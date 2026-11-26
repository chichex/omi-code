import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BUNDLED_TOOLS, checkManifest, downloadWorstCaseMs, fetchTools, fetchVerified, retryingDownload, stageTools, type BundledTool, type ToolManifest } from "../scripts/bundled-tools.ts";
import { buildRelease } from "../scripts/build-release.ts";
import { PLATFORMS } from "../src/upgrade/release.ts";
import { tempDir } from "./helpers/io.ts";

const sha256 = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");
const never = async (url: string): Promise<Buffer> => { throw new Error(`un test no descarga: ${url}`); };

// Los mismos assets que bajaría Pi (getReleaseTarget en tools-manager.js): musl en Linux, estático.
const PI_TARGETS = {
	"darwin-arm64": "aarch64-apple-darwin.tar.gz",
	"darwin-x64": "x86_64-apple-darwin.tar.gz",
	"linux-arm64": "aarch64-unknown-linux-musl.tar.gz",
	"linux-x64": "x86_64-unknown-linux-musl.tar.gz",
} as const;
const PI_ASSETS = {
	fd: (version: string, target: string) => `https://github.com/sharkdp/fd/releases/download/v${version}/fd-v${version}-${target}`,
	rg: (version: string, target: string) => `https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-${target}`,
} as const;

test("manifiesto_fija fd y rg para cada plataforma de la release, con el asset que bajaría Pi", () => {
	assert.deepEqual(Object.keys(BUNDLED_TOOLS).sort(), ["fd", "rg"]);
	for (const [name, tool] of Object.entries(BUNDLED_TOOLS) as [keyof typeof PI_ASSETS, BundledTool][]) {
		assert.match(tool.version, /^\d+\.\d+\.\d+$/, name);
		assert.ok(tool.licenses.length > 0, `${name} sin licencias`);
		assert.deepEqual(Object.keys(tool.assets).sort(), [...PLATFORMS].sort(), name);
		for (const platform of PLATFORMS) {
			assert.equal(tool.assets[platform].url, PI_ASSETS[name](tool.version, PI_TARGETS[platform]), `${name} ${platform}`);
			assert.match(tool.assets[platform].sha256, /^[0-9a-f]{64}$/, `${name} ${platform}`);
		}
	}
	assert.doesNotThrow(() => checkManifest(BUNDLED_TOOLS));
});

function variant(change: (tool: BundledTool) => void): ToolManifest {
	const copy = structuredClone(BUNDLED_TOOLS);
	change(copy.fd as BundledTool);
	return copy;
}

test("manifiesto_rechaza una plataforma sin asset, un origen fuera del repo y un SHA-256 inválido", () => {
	assert.throws(() => checkManifest(variant((tool) => { delete (tool.assets as Partial<BundledTool["assets"]>)["linux-arm64"]; })), /linux-arm64/);
	assert.throws(() => checkManifest(variant((tool) => { tool.assets["linux-x64"].url = "https://mirror.example.com/fd.tar.gz"; })), /github\.com\/sharkdp\/fd\/releases\/download/);
	assert.throws(() => checkManifest(variant((tool) => { tool.assets["linux-x64"].url = tool.assets["linux-x64"].url.replace("https:", "http:"); })), /github\.com/);
	assert.throws(() => checkManifest(variant((tool) => { tool.assets["darwin-x64"].sha256 = "abc"; })), /SHA-256/);
	assert.throws(() => checkManifest(variant((tool) => { tool.licenses = []; })), /licencia/);
});

test("manifiesto_rechaza un asset de otra versión que la declarada", () => {
	// Un bump que edita la versión y no una URL, o al revés.
	assert.throws(() => checkManifest(variant((tool) => { tool.version = "10.5.3"; })), /10\.5\.3/);
	assert.throws(() => checkManifest(variant((tool) => { tool.assets["linux-arm64"].url = tool.assets["linux-arm64"].url.replaceAll(tool.version, "10.5.1"); })), /linux-arm64.*10\.5\.2/);
	assert.throws(() => checkManifest(variant((tool) => { tool.assets["darwin-x64"].url = tool.assets["darwin-x64"].url.replace(`/v${tool.version}/`, "/v10.5.1/"); })), /darwin-x64/);
});

const ASSET = { url: "https://github.com/sharkdp/fd/releases/download/v1.0.0/fd-v1.0.0-x86_64-unknown-linux-musl.tar.gz", sha256: sha256("bueno") };

test("fetchVerified_un SHA-256 que no coincide falla y no deja nada en el cache", async (t) => {
	const cache = await tempDir(t);
	await assert.rejects(fetchVerified(ASSET, cache, async () => Buffer.from("alterado")), /checksum_mismatch.*fd-v1\.0\.0/);
	assert.deepEqual(await readdir(cache), []);
});

test("fetchVerified_baja una vez y después usa el cache sin red", async (t) => {
	const cache = join(await tempDir(t), "nuevo");
	const urls: string[] = [];
	const content = await fetchVerified(ASSET, cache, async (url) => { urls.push(url); return Buffer.from("bueno"); });
	assert.equal(content.toString(), "bueno");
	assert.deepEqual(urls, [ASSET.url]);
	assert.equal((await fetchVerified(ASSET, cache, never)).toString(), "bueno");
});

test("fetchVerified_un cache alterado se vuelve a bajar y se verifica", async (t) => {
	const cache = await tempDir(t);
	await fetchVerified(ASSET, cache, async () => Buffer.from("bueno"));
	const [cached] = await readdir(cache);
	assert.ok(cached);
	await writeFile(join(cache, cached), "alterado en disco");
	await assert.rejects(fetchVerified(ASSET, cache, async () => Buffer.from("también alterado")), /checksum_mismatch/);
	assert.equal((await fetchVerified(ASSET, cache, async () => Buffer.from("bueno"))).toString(), "bueno");
	assert.equal(await readFile(join(cache, cached), "utf8"), "bueno");
});

type Attempt = (signal: AbortSignal) => Response | Promise<Response>;

/** Un fetch que contesta cada intento con el paso que le toca. Anota intentos, esperas y líneas de log. */
function scriptedDownload(attempts: Attempt[], timeoutMs?: number) {
	const seen = { calls: 0, abortedAtStart: [] as boolean[], sleeps: [] as number[], logs: [] as string[] };
	const download = retryingDownload({
		fetch: async (url, { signal }) => {
			assert.equal(url, ASSET.url);
			const attempt = attempts[seen.calls++];
			if (attempt === undefined) throw new Error(`intento de más: ${seen.calls}`);
			seen.abortedAtStart.push(signal.aborted);
			return attempt(signal);
		},
		sleep: async (ms) => { seen.sleeps.push(ms); },
		log: (line) => { seen.logs.push(line); },
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return { download, seen };
}

const ok: Attempt = () => new Response("bueno");
const status = (code: number): Attempt => () => new Response("error", { status: code });
// Lo que tira undici cuando GitHub corta el socket, como en el release del PR #94.
const socketClosed: Attempt = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }); };
const bodyCut: Attempt = () => {
	let pulls = 0;
	return new Response(new ReadableStream({
		pull(controller) {
			if (pulls++ === 0) controller.enqueue(Buffer.from("bue"));
			else controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
		},
	}));
};
// El timer de AbortSignal.timeout no retiene el event loop: el intervalo hace de socket abierto.
const hangs: Attempt = (signal) => new Promise((_, reject) => {
	const socket = setInterval(() => {}, 1_000);
	signal.addEventListener("abort", () => { clearInterval(socket); reject(signal.reason); }, { once: true });
});
const retryLine = (attempt: number, reason: string) => `bundled_tools: reintento ${attempt}/4 de ${ASSET.url}: ${reason}`;

test("retryingDownload_un corte de red se reintenta con espera exponencial y una línea por reintento", async () => {
	const { download, seen } = scriptedDownload([socketClosed, socketClosed, ok]);
	assert.equal((await download(ASSET.url)).toString(), "bueno");
	assert.equal(seen.calls, 3);
	assert.deepEqual(seen.sleeps, [1_000, 2_000]);
	assert.deepEqual(seen.logs, [retryLine(2, "fetch failed (other side closed)"), retryLine(3, "fetch failed (other side closed)")]);
});

test("retryingDownload_HTTP 408, 429 y 5xx se reintentan", async () => {
	for (const code of [408, 429, 500, 502, 503, 504]) {
		const { download, seen } = scriptedDownload([status(code), ok]);
		assert.equal((await download(ASSET.url)).toString(), "bueno", `${code}`);
		assert.deepEqual(seen.logs, [retryLine(2, `respondió ${code}`)]);
	}
});

test("retryingDownload_otro 4xx falla al primer intento, sin esperar", async () => {
	for (const code of [400, 401, 403, 404, 410]) {
		const { download, seen } = scriptedDownload([status(code), ok]);
		await assert.rejects(download(ASSET.url), { message: `download_failed: ${ASSET.url} respondió ${code}` });
		assert.deepEqual({ calls: seen.calls, sleeps: seen.sleeps, logs: seen.logs }, { calls: 1, sleeps: [], logs: [] }, `${code}`);
	}
});

test("retryingDownload_un cuerpo que se corta a mitad se reintenta", async () => {
	const { download, seen } = scriptedDownload([bodyCut, ok]);
	assert.equal((await download(ASSET.url)).toString(), "bueno");
	assert.deepEqual(seen.logs, [retryLine(2, "terminated (other side closed)")]);
});

test("retryingDownload_un intento que vence su timeout se reintenta con un timeout nuevo", async () => {
	const { download, seen } = scriptedDownload([hangs, ok], 5);
	assert.equal((await download(ASSET.url)).toString(), "bueno");
	assert.deepEqual(seen.abortedAtStart, [false, false], "cada intento arranca con su propio timeout");
	assert.equal(seen.logs.length, 1);
	assert.match(seen.logs[0] ?? "", /^bundled_tools: reintento 2\/4 de https:\/\/github\.com\/.+: .*timeout/);
});

test("retryingDownload_se rinde tras 4 intentos, dice cuántos y conserva la causa", async () => {
	const network = scriptedDownload([socketClosed, socketClosed, socketClosed, socketClosed]);
	await assert.rejects(network.download(ASSET.url), (error: Error) => {
		assert.equal(error.message, `download_failed: ${ASSET.url} falló tras 4 intentos: fetch failed (other side closed)`);
		assert.ok(error.cause instanceof TypeError);
		assert.equal(error.cause.message, "fetch failed");
		assert.equal((error.cause.cause as Error).message, "other side closed");
		return true;
	});
	assert.equal(network.seen.calls, 4);
	assert.deepEqual(network.seen.sleeps, [1_000, 2_000, 4_000]);
	assert.deepEqual(network.seen.logs.map((line) => line.split(":")[1]), [" reintento 2/4 de https", " reintento 3/4 de https", " reintento 4/4 de https"]);
	const http = scriptedDownload([status(503), status(503), status(503), status(503)]);
	await assert.rejects(http.download(ASSET.url), { message: `download_failed: ${ASSET.url} falló tras 4 intentos: respondió 503` });
});

test("fetchVerified_un SHA-256 que no coincide no se reintenta", async (t) => {
	const { download, seen } = scriptedDownload([() => new Response("alterado"), ok]);
	await assert.rejects(fetchVerified(ASSET, await tempDir(t), download), /checksum_mismatch/);
	assert.deepEqual({ calls: seen.calls, logs: seen.logs }, { calls: 1, logs: [] });
});

test("retryingDownload_con el fetch real, un socket que se cierra antes de responder o a mitad del cuerpo se reintenta", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		if (requests === 1) { request.socket.destroy(); return; }
		if (requests === 2) {
			response.writeHead(200, { "content-length": "5" });
			response.write("bue", () => request.socket.destroy());
			return;
		}
		response.end("bueno");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fd.tar.gz`;
	const logs: string[] = [];
	const download = retryingDownload({ sleep: async () => {}, log: (line) => { logs.push(line); } });
	assert.equal((await download(url)).toString(), "bueno");
	assert.equal(requests, 3);
	assert.deepEqual(logs, [`bundled_tools: reintento 2/4 de ${url}: fetch failed (other side closed)`, `bundled_tools: reintento 3/4 de ${url}: terminated (other side closed)`]);
});

test("buildRelease_un asset que no coincide con el manifiesto corta el build antes de compilar", async (t) => {
	const out = await tempDir(t);
	const urls: string[] = [];
	await assert.rejects(
		buildRelease(["linux-x64"], out, { cacheDir: await tempDir(t), download: async (url) => { urls.push(url); return Buffer.from("alterado"); } }),
		/checksum_mismatch/,
	);
	assert.ok(urls.length > 0);
	assert.deepEqual(await readdir(out), [], "no quedó binario, runtime ni temporales");
});

test("fetchTools_trae del cache las de cada plataforma pedida", async (t) => {
	const cache = await tempDir(t);
	const manifest = variant(() => {});
	for (const tool of Object.values(manifest)) tool.assets["linux-arm64"].sha256 = sha256(`${tool.assets["linux-arm64"].url}`);
	const archives = await fetchTools(["linux-arm64"], { manifest, cacheDir: cache, download: async (url) => Buffer.from(url) });
	assert.deepEqual([...archives.keys()], ["linux-arm64"]);
	assert.deepEqual(archives.get("linux-arm64")?.map((archive) => archive.name), ["fd", "rg"]);
	assert.equal((await fetchTools(["linux-arm64"], { manifest, cacheDir: cache, download: never })).get("linux-arm64")?.length, 2);
});

async function fakeArchive(t: TestContext, root: string, files: Record<string, string>): Promise<Buffer> {
	const dir = await tempDir(t);
	await mkdir(join(dir, root));
	for (const [name, content] of Object.entries(files)) await writeFile(join(dir, root, name), content, { mode: name === "fd" ? 0o755 : 0o644 });
	const archive = join(await tempDir(t), "archive.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", dir, root]);
	return readFile(archive);
}

test("stageTools_deja el binario ejecutable en bin/ y sus licencias, sin restos de otra plataforma", async (t) => {
	const stage = await tempDir(t);
	await mkdir(join(stage, "bin"));
	await writeFile(join(stage, "bin/rg"), "de otra plataforma\n");
	const content = await fakeArchive(t, "fd-v1.0.0-x86_64-unknown-linux-musl", { fd: "#!/bin/sh\necho fd 1.0.0\n", "LICENSE-MIT": "MIT\n", "README.md": "no va\n" });
	const tool: BundledTool = { repo: "sharkdp/fd", version: "1.0.0", licenses: ["LICENSE-MIT"], assets: BUNDLED_TOOLS.fd.assets };
	await stageTools(stage, [{ name: "fd", tool, asset: ASSET, content }]);
	assert.deepEqual(await readdir(join(stage, "bin")), ["fd"]);
	assert.equal((await stat(join(stage, "bin/fd"))).mode & 0o777, 0o755);
	assert.equal(execFileSync(join(stage, "bin/fd"), { encoding: "utf8" }), "fd 1.0.0\n");
	assert.deepEqual(await readdir(join(stage, "licenses/fd")), ["LICENSE-MIT"]);
});

test("stageTools_falla si el archivo no trae el binario o una licencia del manifiesto", async (t) => {
	const tool: BundledTool = { repo: "sharkdp/fd", version: "1.0.0", licenses: ["LICENSE-MIT"], assets: BUNDLED_TOOLS.fd.assets };
	const withoutLicense = await fakeArchive(t, "fd-v1.0.0-x86_64-unknown-linux-musl", { fd: "#!/bin/sh\n" });
	await assert.rejects(stageTools(await tempDir(t), [{ name: "fd", tool, asset: ASSET, content: withoutLicense }]), /LICENSE-MIT/);
	const otherRoot = await fakeArchive(t, "otro", { fd: "#!/bin/sh\n", "LICENSE-MIT": "MIT\n" });
	await assert.rejects(stageTools(await tempDir(t), [{ name: "fd", tool, asset: ASSET, content: otherRoot }]), /fd-v1\.0\.0-x86_64-unknown-linux-musl\/fd/);
});

// Si GitHub se cuelga del todo, cada intento espera su timeout entero. Sin límite en el job, el release quedaba
// colgado hasta las 6 h de GitHub; con un timeout por intento largo, el límite del job cortaba antes que el error.
test("release.yml: los jobs que bajan fd y rg tienen timeout-minutes y el peor caso de las descargas entra con margen", async () => {
	const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const job = (name: string) => {
		const found = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, "m").exec(workflow);
		assert.ok(found, `falta el job ${name}`);
		return found[1]!;
	};
	const limit = (name: string) => {
		const found = /^    timeout-minutes: (\d+)$/m.exec(job(name));
		assert.ok(found, `el job ${name} no tiene timeout-minutes`);
		return Number(found[1]) * 60_000;
	};
	const assets = Object.values(BUNDLED_TOOLS).reduce((count, tool) => count + Object.keys(tool.assets).length, 0);
	assert.equal(assets, 8);
	assert.ok(downloadWorstCaseMs(1) <= 3 * 60_000, `un asset tarda hasta ${downloadWorstCaseMs(1) / 1000} s en rendirse`);
	// Lo normal del job: build tarda unos 7 min y macos unos 2.
	const margin = 15 * 60_000;
	// build: test:packaging baja los 2 del host y build-release los 8; sin cache, son 10.
	assert.ok(limit("build") >= downloadWorstCaseMs(assets + 2) + margin, "build corta antes de que las descargas se rindan");
	assert.ok(limit("macos") >= downloadWorstCaseMs(2) + margin, "macos corta antes de que las descargas se rindan");
	for (const name of ["build", "macos"]) assert.ok(limit(name) <= 60 * 60_000, `${name}: un límite de más de 1 h no frena un cuelgue`);
});
