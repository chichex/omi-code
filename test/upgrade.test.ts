import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { run } from "../src/cli/main.ts";
import type { OmiError } from "../src/core/errors.ts";
import { processRunner, type Runner } from "../src/core/exec.ts";
import { RELEASES_URL, assetNames, currentPlatform, isNewer, parseChecksums } from "../src/upgrade/release.ts";
import { checkUpgrade, runUpgrade } from "../src/upgrade/upgrade.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const PLATFORM = "linux-x64";

function sha256(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

interface Release {
	url: string;
	requests: string[];
	files: Map<string, Buffer>;
}

/** Tarball real, con el binario y el runtime que espera install.sh. */
async function runtimeTarball(t: TestContext, binary: string): Promise<Buffer> {
	const dir = await tempDir(t);
	await mkdir(join(dir, "theme"), { recursive: true });
	await writeFile(join(dir, "theme/dark.json"), "nuevo\n");
	await writeFile(join(dir, "omi"), binary, { mode: 0o755 });
	// fd y rg vienen en el runtime, como en una release real.
	await mkdir(join(dir, "bin"));
	for (const name of ["fd", "rg"]) await writeFile(join(dir, "bin", name), `#!/bin/sh\necho ${name} nuevo\n`, { mode: 0o755 });
	const output = join(await tempDir(t), "runtime.tar.gz");
	execFileSync("tar", ["-czf", output, "-C", dir, "."]);
	return readFile(output);
}

const WORKING_BINARY = "#!/bin/sh\necho 9.9.9\n";

async function releaseServer(t: TestContext, options: { tag?: string; corrupt?: string; omit?: string; binary?: string; status?: number } = {}): Promise<Release> {
	const binary = options.binary ?? WORKING_BINARY;
	const names = assetNames(PLATFORM);
	const files = new Map<string, Buffer>([
		[names.binary, Buffer.from(binary)],
		[names.runtime, await runtimeTarball(t, binary)],
	]);
	const checksums = [...files].map(([name, content]) => `${sha256(content)}  ${name}`).join("\n");
	files.set(names.checksums, Buffer.from(`${checksums}\n`));
	if (options.corrupt !== undefined) files.set(options.corrupt, Buffer.from("alterado"));
	if (options.omit !== undefined) files.delete(options.omit);
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push(path);
		if (options.status !== undefined) {
			response.writeHead(options.status);
			response.end();
			return;
		}
		if (path === "/latest") {
			const assets = [...files.keys()].map((name) => ({ name, browser_download_url: `${base}/download/${name}` }));
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ tag_name: options.tag ?? "v9.9.9", assets }));
			return;
		}
		const content = files.get(path.replace("/download/", ""));
		response.writeHead(content === undefined ? 404 : 200);
		response.end(content);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(() => new Promise<void>((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	}));
	return { url: base, requests, files };
}

/** Instalación vieja: binario y runtime que el upgrade tiene que reemplazar o preservar. */
async function installed(t: TestContext, name = ""): Promise<string> {
	const home = join(await tempDir(t), name);
	await mkdir(join(home, ".omi/bin"), { recursive: true });
	await writeFile(join(home, ".omi/bin/omi"), "#!/bin/sh\necho 0.1.0\n", { mode: 0o755 });
	await mkdir(join(home, ".omi/runtime/theme"), { recursive: true });
	await writeFile(join(home, ".omi/runtime/theme/dark.json"), "viejo\n");
	return home;
}

function options(home: string, release: Release, runner: Runner = processRunner) {
	return { homeDir: home, current: "0.1.0", platform: PLATFORM, releasesUrl: `${release.url}/latest`, runner } as const;
}

for (const [current, latest, expected] of [
	["0.1.0", "0.1.1", true],
	["0.1.9", "0.2.0", true],
	["0.9.0", "0.10.0", true],
	["1.0.0", "1.0.0", false],
	["1.2.0", "1.1.9", false],
	["1.0.0-rc.1", "1.0.0", true],
	["1.0.0", "1.0.0-rc.1", false],
] as const) {
	test(`isNewer_${latest} frente a ${current} es ${expected}`, () => {
		assert.equal(isNewer(current, latest), expected);
	});
}

test("parseChecksums_lee el formato de sha256sum", () => {
	const checksums = parseChecksums("abc  omi-linux-x64\ndef *omi-linux-x64-runtime.tar.gz\n\n");
	assert.equal(checksums.get("omi-linux-x64"), "abc");
	assert.equal(checksums.get("omi-linux-x64-runtime.tar.gz"), "def");
});

test("currentPlatform_nombra las cuatro plataformas y rechaza el resto", () => {
	assert.equal(currentPlatform("darwin", "arm64"), "darwin-arm64");
	assert.equal(currentPlatform("darwin", "x64"), "darwin-x64");
	assert.equal(currentPlatform("linux", "arm64"), "linux-arm64");
	assert.equal(currentPlatform("linux", "x64"), "linux-x64");
	assert.throws(() => currentPlatform("win32", "x64"), /win32/);
});

test("checkUpgrade_informa si hay una versión nueva", async (t) => {
	const release = await releaseServer(t);
	assert.deepEqual(await checkUpgrade(options("/nada", release)), { current: "0.1.0", latest: "9.9.9", updateAvailable: true });
});

test("checkUpgrade_no descarga nada", async (t) => {
	const release = await releaseServer(t);
	await checkUpgrade(options("/nada", release));
	assert.deepEqual(release.requests, ["/latest"]);
});

test("checkUpgrade_sin releases explica que puede ser un repo privado", async (t) => {
	const release = await releaseServer(t, { status: 404 });
	await assert.rejects(checkUpgrade(options("/nada", release)), (error: OmiError) => error.code === "release_not_found" && /privado/.test(error.hint ?? ""));
});

test("upgrade de un repo privado usa el token sólo en la API de GitHub y descarga sus assets autenticados", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const seen: { url: string; authorization: string | null; accept: string | null }[] = [];
	t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		seen.push({ url, authorization: headers.get("Authorization"), accept: headers.get("Accept") });
		if (headers.get("Authorization") !== "Bearer gh_fake") return new Response("", { status: 401 });
		if (url === RELEASES_URL) return Response.json({ tag_name: "v9.9.9", assets: [...release.files.keys()].map((name) => ({
			name, browser_download_url: `https://github.com/chichex/omi-code/releases/download/v9.9.9/${name}`,
			url: `https://api.github.com/repos/chichex/omi-code/releases/assets/${name}`,
		})) });
		const content = release.files.get(url.split("/").at(-1) ?? "");
		return content === undefined ? new Response("", { status: 404 }) : new Response(content);
	});
	const report = await runUpgrade({ ...options(home, release), releasesUrl: RELEASES_URL, token: "gh_fake" });
	assert.equal(report.updated, true);
	assert.equal(seen.length, 4);
	assert.ok(seen.every((request) => request.url.startsWith("https://api.github.com/") && request.authorization === "Bearer gh_fake"));
	assert.ok(seen.slice(1).every((request) => request.accept === "application/octet-stream"));
	assert.doesNotMatch(JSON.stringify(report), /gh_fake/);
});

test("upgrade no envía el token de GitHub a un endpoint alternativo", async (t) => {
	t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		assert.equal(new Headers(init?.headers).has("Authorization"), false);
		return Response.json({ tag_name: "v9.9.9", assets: [] });
	});
	assert.equal((await checkUpgrade({ current: "0.1.0", releasesUrl: "https://untrusted.invalid/latest", token: "gh_fake" })).updateAvailable, true);
});

test("runUpgrade_verifica y reemplaza binario y runtime", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const result = await runUpgrade(options(home, release));
	assert.deepEqual(result, { current: "0.1.0", latest: "9.9.9", updated: true });
	assert.equal(await readFile(join(home, ".omi/bin/omi"), "utf8"), WORKING_BINARY);
	assert.equal((await stat(join(home, ".omi/bin/omi"))).mode & 0o777, 0o755);
	assert.equal(await readFile(join(home, ".omi/runtime/theme/dark.json"), "utf8"), "nuevo\n");
});

test("runUpgrade_reemplaza fd y rg del runtime y quedan ejecutables", async (t) => {
	const home = await installed(t);
	await mkdir(join(home, ".omi/runtime/bin"));
	await writeFile(join(home, ".omi/runtime/bin/rg"), "#!/bin/sh\necho rg viejo\n", { mode: 0o755 });
	await runUpgrade(options(home, await releaseServer(t)));
	for (const name of ["fd", "rg"]) assert.equal(execFileSync(join(home, ".omi/runtime/bin", name), { encoding: "utf8" }), `${name} nuevo\n`);
});

test("runUpgrade_no deja temporales en ~/.omi", async (t) => {
	const home = await installed(t);
	await runUpgrade(options(home, await releaseServer(t)));
	assert.deepEqual((await readdir(join(home, ".omi"))).sort(), ["bin", "runtime"]);
});

test("runUpgrade_ya al día no descarga", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t, { tag: "v0.1.0" });
	assert.deepEqual(await runUpgrade(options(home, release)), { current: "0.1.0", latest: "0.1.0", updated: false });
	assert.deepEqual(release.requests, ["/latest"]);
});

for (const target of ["binary", "runtime"] as const) {
	test(`runUpgrade_con un checksum que no coincide en ${target} no toca la instalación`, async (t) => {
		const home = await installed(t);
		const release = await releaseServer(t, { corrupt: assetNames(PLATFORM)[target] });
		await assert.rejects(runUpgrade(options(home, release)), (error: OmiError) => error.code === "checksum_mismatch");
		assert.match(await readFile(join(home, ".omi/bin/omi"), "utf8"), /0\.1\.0/);
		assert.equal(await readFile(join(home, ".omi/runtime/theme/dark.json"), "utf8"), "viejo\n");
		assert.deepEqual((await readdir(join(home, ".omi"))).sort(), ["bin", "runtime"]);
	});
}

test("runUpgrade_sin un asset falla antes de bajar nada del resto", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t, { omit: assetNames(PLATFORM).checksums });
	await assert.rejects(runUpgrade(options(home, release)), (error: OmiError) => error.code === "release_incomplete");
	assert.deepEqual(release.requests, ["/latest"]);
});

test("runUpgrade_si el binario nuevo no arranca cae al del runtime con un shim", async (t) => {
	const home = await installed(t);
	const names = assetNames(PLATFORM);
	const release = await releaseServer(t);
	const broken = Buffer.from("#!/bin/sh\nexit 137\n");
	release.files.set(names.binary, broken);
	const checksums = (release.files.get(names.checksums)?.toString() ?? "").replace(/^\S+(  omi-linux-x64\n)/m, `${sha256(broken)}$1`);
	release.files.set(names.checksums, Buffer.from(checksums));
	await runUpgrade(options(home, release));
	assert.match(await readFile(join(home, ".omi/bin/omi"), "utf8"), /exec .*runtime\/omi/);
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), { encoding: "utf8" }), "9.9.9\n");
});

test("runUpgrade_si nada arranca restaura la instalación anterior", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t, { binary: "#!/bin/sh\nexit 137\n" });
	await assert.rejects(runUpgrade(options(home, release)), (error: OmiError) => error.code === "upgrade_failed");
	assert.match(await readFile(join(home, ".omi/bin/omi"), "utf8"), /0\.1\.0/);
	assert.equal(await readFile(join(home, ".omi/runtime/theme/dark.json"), "utf8"), "viejo\n");
	assert.deepEqual((await readdir(join(home, ".omi"))).sort(), ["bin", "runtime"]);
});

test("runUpgrade_en macOS firma el binario antes de instalarlo", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const seen: string[] = [];
	const runner: Runner = {
		run: (command, args, runOptions) => {
			if (command === "codesign") {
				seen.push(args[0] ?? "");
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}
			return processRunner.run(command, args, runOptions);
		},
	};
	const darwin = assetNames("darwin-arm64");
	const names = assetNames(PLATFORM);
	for (const key of ["binary", "runtime"] as const) {
		const content = release.files.get(names[key]);
		assert.ok(content);
		release.files.set(darwin[key], content);
	}
	release.files.set(darwin.checksums, Buffer.from((release.files.get(names.checksums)?.toString() ?? "").replaceAll("omi-linux-x64", "omi-darwin-arm64")));
	await runUpgrade({ ...options(home, release, runner), platform: "darwin-arm64" });
	// El binario suelto y el del runtime: cualquiera de los dos puede quedar activo. fd y rg no:
	// llegan con la firma de upstream intacta.
	assert.deepEqual(seen, ["--remove-signature", "--force", "--remove-signature", "--force"]);
});

test("upgrade restaura runtime si falla el segundo swap", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	await chmod(join(home, ".omi/bin"), 0o500);
	try { await assert.rejects(runUpgrade(options(home, release))); }
	finally { await chmod(join(home, ".omi/bin"), 0o755); }
	assert.match(await readFile(join(home, ".omi/bin/omi"), "utf8"), /0\.1\.0/);
	assert.equal(await readFile(join(home, ".omi/runtime/theme/dark.json"), "utf8"), "viejo\n");
});

test("upgrade conserva backups y explica su ubicación si falla el rollback", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const runner: Runner = { run: async (command, args, opts) => {
		if (command === join(home, ".omi/bin/omi")) {
			await chmod(join(home, ".omi"), 0o500);
			return { code: 137, stdout: "", stderr: "broken" };
		}
		return processRunner.run(command, args, opts);
	} };
	try {
		await assert.rejects(runUpgrade(options(home, release, runner)), (error: OmiError) => error.code === "upgrade_rollback_failed" && /upgrade-/.test(error.hint ?? ""));
	} finally { await chmod(join(home, ".omi"), 0o700); }
	const work = (await readdir(join(home, ".omi"))).find((name) => name.startsWith("upgrade-"));
	assert.ok(work);
	assert.equal(await readFile(join(home, ".omi", work, "previous-runtime/theme/dark.json"), "utf8"), "viejo\n");
});

test("upgrade fallback ejecuta correctamente rutas con caracteres de shell", async (t) => {
	const home = await installed(t, "home $unknown ' \" \\ `false`");
	const release = await releaseServer(t);
	const names = assetNames(PLATFORM);
	const broken = Buffer.from("#!/bin/sh\nexit 137\n");
	release.files.set(names.binary, broken);
	release.files.set(names.checksums, Buffer.from((release.files.get(names.checksums)?.toString() ?? "").replace(/^\S+(  omi-linux-x64\n)/m, `${sha256(broken)}$1`)));
	await runUpgrade(options(home, release));
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), { encoding: "utf8" }), "9.9.9\n");
});

test("omi upgrade --check no exige una plataforma con binario", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(descriptor);
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		const io = testIo({ homeDir: home, env: { OMI_RELEASES_URL: `${release.url}/latest` } });
		assert.equal(await run(["upgrade", "--check", "--json"], io), 0, io.errors());
	} finally { Object.defineProperty(process, "platform", descriptor); }
});

test("omi upgrade --check_por la CLI", async (t) => {
	const home = await installed(t);
	const release = await releaseServer(t);
	const io = testIo({ homeDir: home, env: { OMI_RELEASES_URL: `${release.url}/latest` } });
	assert.equal(await run(["upgrade", "--check", "--json"], io), 0, io.errors());
	const report = JSON.parse(io.output()) as { latest: string; updateAvailable: boolean };
	assert.equal(report.latest, "9.9.9");
	assert.equal(report.updateAvailable, true);
});
