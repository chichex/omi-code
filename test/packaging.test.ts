import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { assetNames, currentPlatform } from "../src/upgrade/release.ts";
import { tempDir } from "./helpers/io.ts";

const installScript = fileURLToPath(new URL("../install.sh", import.meta.url));
const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Publica en una carpeta lo mismo que una release, con scripts en vez de binarios. */
async function fakeRelease(t: TestContext, options: { binary?: string; bundled?: string; tamper?: boolean } = {}): Promise<string> {
	const dir = await tempDir(t);
	const stage = await tempDir(t);
	const names = assetNames(currentPlatform());
	const bundled = options.bundled ?? "#!/bin/sh\necho 1.0.0\n";
	await mkdir(join(stage, "skills/ship"), { recursive: true });
	await writeFile(join(stage, "skills/ship/SKILL.md"), "x\n");
	await writeFile(join(stage, "omi"), bundled, { mode: 0o755 });
	await writeFile(join(dir, names.binary), options.binary ?? "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
	execFileSync("tar", ["-czf", join(dir, names.runtime), "-C", stage, "."]);
	const lines: string[] = [];
	for (const name of [names.binary, names.runtime]) lines.push(`${sha256(await readFile(join(dir, name)))}  ${name}`);
	await writeFile(join(dir, "checksums.txt"), `${lines.join("\n")}\n`);
	if (options.tamper === true) await writeFile(join(dir, names.binary), "#!/bin/sh\necho malo\n");
	return dir;
}

function install(base: string, home: string) {
	return spawnSync("sh", [installScript], { encoding: "utf8", env: { ...process.env, HOME: home, OMI_INSTALL_BASE: `file://${base}` } });
}

test("install.sh_instala binario y runtime en ~/.omi", async (t) => {
	const home = await tempDir(t);
	const result = install(await fakeRelease(t), home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), ["--version"], { encoding: "utf8" }), "1.0.0\n");
	assert.equal((await stat(join(home, ".omi/runtime/skills/ship/SKILL.md"))).isFile(), true);
	assert.equal((await stat(join(home, ".omi/runtime/omi"))).isFile(), true);
});

test("install.sh usa gh autenticado para los assets de un repo privado", async (t) => {
	const home = await tempDir(t);
	const release = await fakeRelease(t);
	const tools = await tempDir(t);
	await writeFile(join(tools, "curl"), "#!/bin/sh\necho descarga-sin-autenticar >&2\nexit 99\n", { mode: 0o755 });
	await writeFile(join(tools, "gh"), `#!/bin/sh
if [ "$1" = auth ]; then exit 0; fi
if [ "$1" = release ] && [ "$2" = download ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) asset=$2; shift 2 ;;
      --dir) dest=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$FAKE_RELEASE/$asset" "$dest/$asset"
  exit $?
fi
exit 1
`, { mode: 0o755 });
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, FAKE_RELEASE: release };
	delete env.OMI_INSTALL_BASE;
	const result = spawnSync("sh", [installScript], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), ["--version"], { encoding: "utf8" }), "1.0.0\n");
});

test("install.sh_cae al bundle si el binario suelto no arranca", async (t) => {
	const home = await tempDir(t);
	const result = install(await fakeRelease(t, { binary: "#!/bin/sh\nexit 137\n" }), home);
	assert.equal(result.status, 0, result.stderr);
	assert.match(await readFile(join(home, ".omi/bin/omi"), "utf8"), /exec .*runtime\/omi/);
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), ["--version"], { encoding: "utf8" }), "1.0.0\n");
});

test("install.sh fallback no interpreta caracteres de shell del HOME", async (t) => {
	const home = join(await tempDir(t), "home $unknown ' \" \\ `false`");
	const result = install(await fakeRelease(t, { binary: "#!/bin/sh\nexit 137\n" }), home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(execFileSync(join(home, ".omi/bin/omi"), ["--version"], { encoding: "utf8" }), "1.0.0\n");
});

test("install.sh_falla con un mensaje claro si nada arranca", async (t) => {
	const home = await tempDir(t);
	const broken = "#!/bin/sh\nexit 137\n";
	const result = install(await fakeRelease(t, { binary: broken, bundled: broken }), home);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no arranca/);
});

test("install.sh_no instala nada si el checksum no coincide", async (t) => {
	const home = await tempDir(t);
	const result = install(await fakeRelease(t, { tamper: true }), home);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /SHA-256/);
	await assert.rejects(stat(join(home, ".omi/bin/omi")));
});

test("bump-pi.yml_es programado y sólo abre el PR después de los tests", async () => {
	const workflow = await read(".github/workflows/bump-pi.yml");
	assert.match(workflow, /schedule:/);
	assert.match(workflow, /@earendil-works\/pi-coding-agent/);
	const test = workflow.indexOf("run: npm test");
	assert.ok(test > 0 && test < workflow.indexOf("gh pr create"));
	assert.match(workflow, /--save-exact/);
	assert.match(workflow, /setup-bun/);
	const packaging = workflow.indexOf("run: npm run test:packaging");
	assert.ok(packaging > 0 && packaging < workflow.indexOf("gh pr create"));
	assert.doesNotMatch(workflow, /gh pr merge/);
	assert.match(workflow, /git ls-remote.*--heads/);
});

test("release.yml_compila con bun y verifica que el tag coincida", async () => {
	const workflow = await read(".github/workflows/release.yml");
	assert.match(workflow, /tags: \["v\*"\]/);
	assert.match(workflow, /setup-bun/);
	assert.match(workflow, /scripts\/build-release\.ts/);
	assert.match(workflow, /GITHUB_REF_NAME/);
	assert.ok(workflow.indexOf("npm test") < workflow.indexOf("gh release create"));
});

test("buildRelease no borra archivos previos del directorio de salida", async (t) => {
	const { buildRelease } = await import("../scripts/build-release.ts");
	const out = await tempDir(t);
	await writeFile(join(out, "keep.txt"), "user data\n");
	await buildRelease([], out);
	assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "user data\n");
});

test("buildRelease rechaza un checkout Git como salida sin tocarlo", async (t) => {
	const { buildRelease } = await import("../scripts/build-release.ts");
	const out = await tempDir(t);
	await mkdir(join(out, ".git"));
	await writeFile(join(out, "keep.txt"), "user data\n");
	await assert.rejects(buildRelease([], out), /unsafe_release_output/);
	assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "user data\n");
});

test("build-release_declara las cuatro plataformas", async () => {
	const { PLATFORMS } = await import("../src/upgrade/release.ts");
	assert.deepEqual([...PLATFORMS], ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
	assert.match(await read("scripts/build-release.ts"), /bun-\$\{platform\}/);
});
