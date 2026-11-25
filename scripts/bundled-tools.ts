// fd y rg viajan dentro del runtime para que Pi no los baje de GitHub al arrancar. Versión, URL y
// SHA-256 de cada plataforma están fijados en bundled-tools.json: un asset que no coincide corta el
// build. Las descargas quedan en un cache por hash, así un rebuild no vuelve a la red. Un corte de red
// pasajero se reintenta: no voltea un release.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
/** Espera antes de cada reintento. Con tres, son 4 intentos y 7 s de espera como mucho. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DOWNLOAD_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const ARCHIVE_SUFFIX = ".tar.gz";

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "omi-code", "tools");
}

export interface DownloadDeps {
	/** Por defecto, el fetch global. */
	fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	/** Una línea por reintento. Por defecto, a stderr. */
	log?: (line: string) => void;
	/** Vale para cada intento, no para la descarga entera. */
	timeoutMs?: number;
}

class HttpStatusError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`respondió ${status}`);
		this.status = status;
	}
}

/** Un 4xx que no es 408 ni 429 no cambia al reintentar: por ejemplo, un 404 por una URL mal fijada. */
const isTransientStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** El mensaje y el de su causa, como `fetch failed (other side closed)`. */
function reason(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/**
 * Baja una URL con hasta DOWNLOAD_ATTEMPTS intentos. Reintenta lo que puede ser un corte pasajero: un fetch que
 * rechaza, un timeout, un cuerpo cortado o un HTTP 408, 429 o 5xx. El hash se verifica afuera: no se reintenta.
 */
export function retryingDownload(deps: DownloadDeps = {}): Download {
	const get = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? delay;
	const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
	const timeoutMs = deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	return async (url) => {
		for (let attempt = 1; ; attempt++) {
			try {
				// El mismo signal corta también la lectura del cuerpo.
				const response = await get(url, { signal: AbortSignal.timeout(timeoutMs) });
				if (!response.ok) throw new HttpStatusError(response.status);
				return Buffer.from(await response.arrayBuffer());
			} catch (error) {
				if (error instanceof HttpStatusError && !isTransientStatus(error.status)) throw new Error(`download_failed: ${url} ${error.message}`, { cause: error });
				const wait = RETRY_DELAYS_MS[attempt - 1];
				if (wait === undefined) throw new Error(`download_failed: ${url} falló tras ${attempt} intentos: ${reason(error)}`, { cause: error });
				log(`bundled_tools: reintento ${attempt + 1}/${DOWNLOAD_ATTEMPTS} de ${url}: ${reason(error)}`);
				await sleep(wait);
			}
		}
	};
}

const download = retryingDownload();

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
			// El tag (`v10.5.2` o `15.2.0`) y el nombre del asset llevan la versión declarada.
			const [tag = "", file = ""] = new URL(asset.url).pathname.split("/").slice(-2);
			if (tag.replace(/^v/, "") !== tool.version || !file.includes(`${tool.version}-`)) throw new Error(`bundled_tools: ${name} ${platform} baja ${tag}/${file}, no la versión ${tool.version}`);
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
