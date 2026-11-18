// fd y rg viajan dentro del runtime para que Pi no los baje de GitHub al arrancar. Versión, URL y
// SHA-256 de cada plataforma están fijados en bundled-tools.json: un asset que no coincide corta el
// build. Las descargas quedan en un cache por hash, así un rebuild no vuelve a la red.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BUNDLED_TOOLS_DIR } from "../src/core/runtime.ts";
import { PLATFORMS, type Platform } from "../src/upgrade/release.ts";
import manifest from "./bundled-tools.json" with { type: "json" };

export interface ToolAsset {
	url: string;
	sha256: string;
}

export interface BundledTool {
	/** Repo de GitHub: la única fuente aceptada para sus assets. */
	repo: string;
	version: string;
	/** Archivos de licencia del asset, que van a `licenses/<nombre>/` del runtime. */
	licenses: string[];
	assets: Record<Platform, ToolAsset>;
}

/** Por nombre del binario, como `fd` o `rg`. */
export type ToolManifest = Record<string, BundledTool>;

export const BUNDLED_TOOLS: Record<"fd" | "rg", BundledTool> = manifest;

export type Download = (url: string) => Promise<Buffer>;

export interface VerifiedArchive {
	name: string;
	tool: BundledTool;
	asset: ToolAsset;
	/** El .tar.gz con el SHA-256 del manifiesto. */
	content: Buffer;
}

export interface FetchOptions {
	manifest?: ToolManifest;
	cacheDir?: string;
	download?: Download;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_SUFFIX = ".tar.gz";

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "omi-code", "tools");
}

const download: Download = async (url) => {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`download_failed: ${url} respondió ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
};

/** Falla si falta una plataforma, si un asset no sale de las releases de su repo o si un hash no es SHA-256. */
export function checkManifest(tools: ToolManifest): void {
	for (const [name, tool] of Object.entries(tools)) {
		if (tool.licenses.length === 0) throw new Error(`bundled_tools: ${name} no declara ninguna licencia`);
		const origin = `https://github.com/${tool.repo}/releases/download/`;
		for (const platform of PLATFORMS) {
			const asset = tool.assets[platform] as ToolAsset | undefined;
			if (asset === undefined) throw new Error(`bundled_tools: ${name} no fija un asset para ${platform}`);
			if (!asset.url.startsWith(origin) || !asset.url.endsWith(ARCHIVE_SUFFIX)) throw new Error(`bundled_tools: ${name} ${platform} tiene que bajar un ${ARCHIVE_SUFFIX} de ${origin}`);
			if (!/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`bundled_tools: ${name} ${platform} no fija un SHA-256 válido`);
		}
	}
}

/** El asset, del cache si su hash coincide; si no, lo baja y lo guarda sólo después de verificarlo. */
export async function fetchVerified(asset: ToolAsset, cacheDir: string, get: Download = download): Promise<Buffer> {
	const path = join(cacheDir, `${asset.sha256}-${basename(new URL(asset.url).pathname)}`);
	const cached = await readFile(path).catch(() => undefined);
	if (cached !== undefined && sha256(cached) === asset.sha256) return cached;
	const content = await get(asset.url);
	const actual = sha256(content);
	if (actual !== asset.sha256) throw new Error(`checksum_mismatch: el SHA-256 de ${asset.url} es ${actual} y el manifiesto fija ${asset.sha256}`);
	await mkdir(cacheDir, { recursive: true });
	// Dos builds a la vez no se pisan: cada uno escribe el suyo y lo renombra.
	const partial = `${path}.${process.pid}.partial`;
	await writeFile(partial, content);
	await rename(partial, path);
	return content;
}

/** Las de todas las plataformas antes de compilar: un hash que no coincide corta el build sin gastar en bun. */
export async function fetchTools(targets: readonly Platform[], options: FetchOptions = {}): Promise<Map<Platform, VerifiedArchive[]>> {
	const tools = options.manifest ?? BUNDLED_TOOLS;
	checkManifest(tools);
	const cacheDir = options.cacheDir ?? defaultCacheDir();
	const archives = new Map<Platform, VerifiedArchive[]>();
	for (const platform of targets) {
		const verified: VerifiedArchive[] = [];
		for (const [name, tool] of Object.entries(tools)) {
			const asset = tool.assets[platform];
			verified.push({ name, tool, asset, content: await fetchVerified(asset, cacheDir, options.download) });
		}
		archives.set(platform, verified);
	}
	return archives;
}

/** Deja `bin/<nombre>` y `licenses/<nombre>/` de una plataforma, en lugar de los de la anterior. */
export async function stageTools(stage: string, archives: readonly VerifiedArchive[]): Promise<void> {
	const bin = join(stage, BUNDLED_TOOLS_DIR);
	const licenses = join(stage, "licenses");
	await rm(bin, { recursive: true, force: true });
	await rm(licenses, { recursive: true, force: true });
	await mkdir(bin, { recursive: true });
	for (const { name, tool, asset, content } of archives) {
		// Se extrae lo verificado en memoria, no el archivo del cache: nadie lo cambia en el medio.
		const work = await mkdtemp(join(tmpdir(), `omi-${name}-`));
		try {
			const archive = join(work, "asset.tar.gz");
			await writeFile(archive, content);
			execFileSync("tar", ["-xzf", archive, "-C", work]);
			const root = basename(new URL(asset.url).pathname, ARCHIVE_SUFFIX);
			await copyMember(join(work, root), name, join(bin, name), `${root}/${name}`);
			await chmod(join(bin, name), 0o755);
			await mkdir(join(licenses, name), { recursive: true });
			for (const license of tool.licenses) await copyMember(join(work, root), license, join(licenses, name, license), `${root}/${license}`);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}
}

async function copyMember(root: string, member: string, target: string, label: string): Promise<void> {
	await cp(join(root, member), target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new Error(`bundled_tools: el asset no trae ${label}`);
		throw error;
	});
}
