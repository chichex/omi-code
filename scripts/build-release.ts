// Arma una release: binario por plataforma, bundle de runtime y checksums.txt.
//
//   node scripts/build-release.ts [--targets darwin-arm64,linux-x64] [--out dist/release] [--cache <dir>]
//
// Requiere bun. Sin --targets compila las cuatro plataformas. fd y rg salen de bundled-tools.json;
// --cache cambia dónde quedan sus descargas (por defecto ~/.cache/omi-code/tools).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { exists } from "../src/core/files.ts";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PLATFORMS, assetNames, type Platform } from "../src/upgrade/release.ts";
import { fetchTools, stageTools, type Download } from "./bundled-tools.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent");

/** Lo que el binario de Pi necesita junto a él. Sale del script copy-binary-assets de Pi. */
const PI_ASSETS: readonly [source: string, target: string][] = [
	["package.json", "package.json"],
	["README.md", "README.md"],
	["CHANGELOG.md", "CHANGELOG.md"],
	["docs", "docs"],
	["examples", "examples"],
	["dist/modes/interactive/assets", "assets"],
	["dist/core/export-html/template.html", "export-html/template.html"],
	["dist/core/export-html/template.css", "export-html/template.css"],
	["dist/core/export-html/template.js", "export-html/template.js"],
	["dist/core/export-html/vendor", "export-html/vendor"],
];

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Pi busca sus workers en estas rutas dentro del binario, como en su propio build. */
const WORKERS: readonly [entry: string, source: string][] = [
	["src/utils/image-resize-worker.ts", "dist/utils/image-resize-worker.js"],
	["src/extensions/codemode/worker.ts", "dist/extensions/codemode/worker.js"],
];

/** Pi expone su arranque para bun sólo por ruta: `exports` no lo incluye. */
async function writeEntries(dir: string): Promise<string[]> {
	const setup = [
		`import ${JSON.stringify(join(ROOT, "src/core/bootstrap.ts"))};`,
		...["dist/bun/sandbox-env-setup.js", "dist/bun/runtime-setup.js"].map((file) => `import ${JSON.stringify(join(PI, file))};`),
	];
	await writeFile(join(dir, "entry.ts"), [...setup, `import ${JSON.stringify(join(ROOT, "bin/omi.ts"))};`, ""].join("\n"));
	for (const [entry, source] of WORKERS) {
		await mkdir(dirname(join(dir, entry)), { recursive: true });
		await writeFile(join(dir, entry), `import ${JSON.stringify(join(PI, source))};\n`);
	}
	return ["./entry.ts", ...WORKERS.map(([entry]) => `./${entry}`)];
}

function compile(cwd: string, entries: readonly string[], platform: Platform, outfile: string): void {
	execFileSync(
		"bun",
		["build", "--compile", `--target=bun-${platform}`, "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", ...entries, "--outfile", outfile],
		{ cwd, stdio: ["ignore", "ignore", "inherit"] },
	);
}

async function stageRuntime(stage: string): Promise<void> {
	await mkdir(stage, { recursive: true });
	for (const [source, target] of PI_ASSETS) {
		const from = join(PI, source);
		if (await exists(from)) await cp(from, join(stage, target), { recursive: true });
	}
	const themes = join(PI, "dist/modes/interactive/theme");
	await mkdir(join(stage, "theme"), { recursive: true });
	for (const name of await readdir(themes)) {
		if (name.endsWith(".json")) await cp(join(themes, name), join(stage, "theme", name));
	}
	await cp(join(ROOT, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(stage, "photon_rs_bg.wasm"));
	// El bridge conserva su metadata junto al bundle; Pi y el SDK vienen del host por
	// virtualModules. No copiar el CLI nativo opcional del SDK ni node_modules enteros.
	const bridge = join(ROOT, "node_modules/pi-claude-bridge");
	const target = join(stage, "claude-bridge");
	await mkdir(join(target, "src"), { recursive: true });
	for (const name of ["package.json", "README.md", "LICENSE"]) await cp(join(bridge, name), join(target, name));
	execFileSync("bun", ["build", join(bridge, "src/index.ts"), "--target=node", "--format=esm",
		"--external=@earendil-works/*", "--external=@anthropic-ai/claude-agent-sdk",
		"--outfile", join(target, "src/index.js")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

async function writeChecksums(out: string, names: readonly string[]): Promise<void> {
	const lines: string[] = [];
	for (const name of names) lines.push(`${sha256(await readFile(join(out, name)))}  ${name}`);
	await writeFile(join(out, "checksums.txt"), `${lines.join("\n")}\n`);
}

export interface BuildOptions {
	cacheDir?: string;
	/** Sólo para tests: reemplaza la descarga de fd y rg. */
	download?: Download;
}

export async function buildRelease(targets: readonly Platform[], out: string, options: BuildOptions = {}): Promise<string[]> {
	out = resolve(out);
	const canonical = await realpath(out).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return out; throw error; });
	const repo = relative(canonical, resolve(ROOT));
	if (canonical === homedir() || (repo !== ".." && !repo.startsWith("../") && !isAbsolute(repo)) || await exists(join(canonical, ".git"))) {
		throw new Error(`unsafe_release_output: ${out} es el home, un checkout o un ancestro del repo; elegí un directorio de artifacts`);
	}
	await mkdir(out, { recursive: true });
	const tools = await fetchTools(targets, options);
	const work = await mkdtemp(join(out, ".build-"));
	try {
	const entries = await writeEntries(work);
	const stage = join(work, "runtime");
	await stageRuntime(stage);

	const artifacts: string[] = [];
	for (const platform of targets) {
		const names = assetNames(platform);
		const binary = join(out, names.binary);
		compile(work, entries, platform, binary);
		await cp(binary, join(stage, "omi"));
		const archives = tools.get(platform);
		if (archives === undefined) throw new Error(`bundled_tools: no se prepararon fd y rg para ${platform}`);
		await stageTools(stage, archives);
		// Sin xattrs: los de macOS llenan de advertencias el tar de Linux al instalar.
		execFileSync("tar", ["--no-xattrs", "-czf", join(out, names.runtime), "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		artifacts.push(names.binary, names.runtime);
	}
	await cp(join(ROOT, "install.sh"), join(out, "install.sh"));
	await writeChecksums(out, artifacts);
	return [...artifacts, "install.sh", "checksums.txt"];
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

function parseTargets(value: string | undefined): Platform[] {
	if (value === undefined) return [...PLATFORMS];
	return value.split(",").map((name) => {
		const platform = PLATFORMS.find((candidate) => candidate === name);
		if (platform === undefined) throw new Error(`plataforma desconocida: ${name}`);
		return platform;
	});
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { targets: { type: "string" }, out: { type: "string" }, cache: { type: "string" } } });
	const out = resolve(values.out ?? join(ROOT, "dist/release"));
	const artifacts = await buildRelease(parseTargets(values.targets), out, values.cache === undefined ? {} : { cacheDir: resolve(values.cache) });
	for (const name of artifacts) console.log(join(basename(out), name));
}
