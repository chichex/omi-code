import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BUNDLED_TOOLS, checkManifest, fetchTools, fetchVerified, stageTools, type BundledTool, type ToolManifest } from "../scripts/bundled-tools.ts";
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
