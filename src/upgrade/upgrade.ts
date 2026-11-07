// `omi upgrade`: verifica SHA-256 antes de tocar nada y vuelve atrás si lo nuevo no arranca.

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OmiError } from "../core/errors.ts";
import { exists } from "../core/files.ts";
import type { Runner } from "../core/exec.ts";
import { omiHome } from "../core/paths.ts";
import { assetNames, fetchLatestRelease, githubReleaseHeaders, isNewer, parseChecksums, type LatestRelease } from "./release.ts";

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export interface UpgradeOptions {
	homeDir: string;
	current: string;
	platform: string;
	releasesUrl: string;
	/** GH_TOKEN/GITHUB_TOKEN: sólo se envía a la API de releases del repo, nunca se persiste. */
	token?: string;
	runner: Runner;
}

async function download(url: string, target: string, token?: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(url, { headers: githubReleaseHeaders(url, token, "application/octet-stream"), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	} catch (error) {
		throw new OmiError("download_failed", `no se pudo descargar ${url}`, { cause: error });
	}
	if (!response.ok) throw new OmiError("download_failed", `${url} respondió ${response.status}`);
	await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function assertChecksum(path: string, name: string, checksums: Map<string, string>): Promise<void> {
	const expected = checksums.get(name);
	const actual = createHash("sha256").update(await readFile(path)).digest("hex");
	if (expected === undefined || expected !== actual) {
		throw new OmiError("checksum_mismatch", `el SHA-256 de ${name} no coincide con checksums.txt`, { hint: "no se cambió nada" });
	}
}

function assetUrls(release: LatestRelease, platform: string): Record<"binary" | "runtime" | "checksums", { name: string; url: string }> {
	const names = assetNames(platform);
	const pick = (name: string): { name: string; url: string } => {
		const url = release.assets.get(name);
		if (url === undefined) throw new OmiError("release_incomplete", `la release ${release.version} no trae ${name}`);
		return { name, url };
	};
	return { binary: pick(names.binary), runtime: pick(names.runtime), checksums: pick(names.checksums) };
}

/**
 * macOS mata un binario de bun con la firma de fábrica: hay que refirmarlo ad hoc.
 * Es best-effort: lo que decide si la versión sirve es que arranque.
 */
async function signForMac(path: string, platform: string, runner: Runner): Promise<void> {
	if (!platform.startsWith("darwin")) return;
	await runner.run("codesign", ["--remove-signature", path]);
	await runner.run("codesign", ["--force", "--sign", "-", path]);
}

async function starts(path: string, runner: Runner): Promise<boolean> {
	return runner.run(path, ["--version"]).then(
		({ code }) => code === 0,
		() => false,
	);
}

interface Layout {
	binary: string;
	runtime: string;
	work: string;
}

async function swap(active: string, replacement: string, backup: string, undo: (() => Promise<void>)[]): Promise<void> {
	if (await exists(active)) {
		await rename(active, backup);
		undo.push(() => rename(backup, active));
	}
	await rename(replacement, active);
	undo.push(() => rm(active, { recursive: true, force: true }));
}

/** Con el binario suelto roto, un shim apunta al del runtime: mismo fallback que install.sh. */
async function activate(layout: Layout, runner: Runner): Promise<void> {
	if (await starts(layout.binary, runner)) return;
	const executable = join(layout.runtime, "omi").replaceAll("'", "'\\''");
	const shim = `#!/bin/sh\nexec '${executable}' "$@"\n`;
	await writeFile(layout.binary, shim, { mode: 0o755 });
	if (!(await starts(layout.binary, runner))) throw new OmiError("upgrade_failed", "la versión nueva no arranca");
}

async function install(layout: Layout, downloaded: { binary: string; runtime: string }, platform: string, runner: Runner): Promise<void> {
	const unpacked = join(layout.work, "unpacked");
	await mkdir(unpacked);
	const { code, stderr } = await runner.run("tar", ["-xzf", downloaded.runtime, "-C", unpacked]);
	if (code !== 0) throw new OmiError("upgrade_failed", `no se pudo extraer el runtime: ${stderr.trim()}`);
	await chmod(downloaded.binary, 0o755);
	await signForMac(downloaded.binary, platform, runner);
	await signForMac(join(unpacked, "omi"), platform, runner);

	const previousBinary = join(layout.work, "previous-omi");
	const previousRuntime = join(layout.work, "previous-runtime");
	await mkdir(join(layout.binary, ".."), { recursive: true });
	const undo: (() => Promise<void>)[] = [];
	try {
		await swap(layout.runtime, unpacked, previousRuntime, undo);
		await swap(layout.binary, downloaded.binary, previousBinary, undo);
		await activate(layout, runner);
	} catch (error) {
		const failures: unknown[] = [];
		for (const restore of undo.reverse()) {
			try { await restore(); } catch (failure) { failures.push(failure); }
		}
		if (failures.length > 0) {
			throw new OmiError("upgrade_rollback_failed", "falló el upgrade y no se pudo restaurar toda la instalación", {
				hint: `se conservaron los backups en ${layout.work}; restauralos antes de reintentar`,
				cause: new AggregateError([error, ...failures]),
			});
		}
		throw error;
	}
}

export async function checkUpgrade(options: Pick<UpgradeOptions, "current" | "releasesUrl" | "token">): Promise<{ current: string; latest: string; updateAvailable: boolean }> {
	const release = await fetchLatestRelease(options.releasesUrl, options.token);
	return { current: options.current, latest: release.version, updateAvailable: isNewer(options.current, release.version) };
}

export async function runUpgrade(options: UpgradeOptions): Promise<{ current: string; latest: string; updated: boolean }> {
	const { current, platform, runner, homeDir } = options;
	const release = await fetchLatestRelease(options.releasesUrl, options.token);
	const report = { current, latest: release.version };
	if (!isNewer(current, release.version)) return { ...report, updated: false };
	const assets = assetUrls(release, platform);

	const home = omiHome(homeDir);
	await mkdir(home, { recursive: true, mode: 0o700 });
	// Dentro de ~/.omi: rename sólo es atómico en el mismo sistema de archivos.
	const work = await mkdtemp(join(home, "upgrade-"));
	let preserveBackups = false;
	try {
		const downloaded = { binary: join(work, "omi"), runtime: join(work, "runtime.tar.gz"), checksums: join(work, "checksums.txt") };
		await download(assets.checksums.url, downloaded.checksums, options.token);
		await download(assets.binary.url, downloaded.binary, options.token);
		await download(assets.runtime.url, downloaded.runtime, options.token);
		const checksums = parseChecksums(await readFile(downloaded.checksums, "utf8"));
		await assertChecksum(downloaded.binary, assets.binary.name, checksums);
		await assertChecksum(downloaded.runtime, assets.runtime.name, checksums);
		await install({ binary: join(home, "bin", "omi"), runtime: join(home, "runtime"), work }, downloaded, platform, runner);
		return { ...report, updated: true };
	} catch (error) {
		preserveBackups = error instanceof OmiError && error.code === "upgrade_rollback_failed";
		throw error;
	} finally {
		if (!preserveBackups) await rm(work, { recursive: true, force: true });
	}
}
