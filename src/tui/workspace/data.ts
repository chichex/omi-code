// Lecturas de la UI: acotadas, sin shell, sin prompts y sin mutaciones.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, statfs } from "node:fs/promises";
import { cpus, freemem, hostname, platform, totalmem } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Io } from "../../cli/io.ts";
import { openSession, resolveOrganization } from "../../client/session.ts";
import { ServiceSchema } from "../../client/views.ts";
import { childEnvironment } from "../../core/process-environment.ts";
import { isInside } from "../../core/files.ts";
import { loadProjectLink } from "../../project/link.ts";

export interface CommandResult { code: number; stdout: string; truncated?: boolean }
export type ReadCommand = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;
export const readCommand: ReadCommand = (command, args, cwd, signal) => new Promise((done) => {
	// status puede ejecutar un fsmonitor configurado en el repo; la UI nunca lo necesita.
	const commandArgs = command === "git" ? ["-c", "core.fsmonitor=false", ...args] : args;
	execFile(command, commandArgs, {
		cwd, signal, timeout: 2500, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
		env: { ...childEnvironment(process.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" },
	}, (error, stdout) => done({ code: error ? 1 : 0, stdout: String(stdout), ...(error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? { truncated: true } : {}) }));
});

/** Nombres de archivos, modelos y respuestas remotas nunca pueden inyectar controles al terminal. */
export function safeText(value: string): string { return value.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g, ""); }
export interface ChangedFile { status: string; path: string; previousPath?: string }
export interface GitSnapshot {
	root: string; gitDir: string; commonDir: string; mainRoot: string; linked: boolean;
	branch: string; detached: boolean; changes: ChangedFile[]; changeCount: number; tracking: boolean; ahead: number; behind: number;
}
export function parseStatus(raw: string): { changes: ChangedFile[]; changeCount: number } {
	const records = raw.split("\0"); const changes: ChangedFile[] = []; let changeCount = 0;
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!; if (record.length < 4) continue;
		const status = record.slice(0, 2); const path = record.slice(3);
		const previousPath = /[RC]/.test(status) ? records[++i] : undefined;
		changeCount++;
		if (changes.length < 100) changes.push({ status, path, ...(previousPath === undefined ? {} : { previousPath }) });
	}
	return { changes, changeCount };
}
export async function readGit(cwd: string, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<GitSnapshot | undefined> {
	const paths = await run("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], cwd, signal);
	if (paths.code !== 0 || paths.truncated) return undefined;
	const [root, gitDir, commonDir] = paths.stdout.trimEnd().split("\n");
	if (!root || !gitDir || !commonDir) return undefined;
	const [symbolic, head, status, worktrees, upstream] = await Promise.all([
		run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, signal),
		run("git", ["rev-parse", "--short", "HEAD"], cwd, signal),
		run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, signal),
		run("git", ["worktree", "list", "--porcelain", "-z"], cwd, signal),
		run("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd, signal),
	]);
	if (status.code !== 0 || status.truncated) throw new Error("No se pudo leer el estado completo de Git");
	const detached = symbolic.code !== 0;
	const first = worktrees.stdout.split("\0").find((record) => record.startsWith("worktree "));
	const [ahead = 0, behind = 0] = upstream.code === 0 ? upstream.stdout.trim().split(/\s+/).map(Number) : [];
	return {
		root, gitDir, commonDir, mainRoot: first?.slice(9) || root, linked: resolve(gitDir) !== resolve(commonDir),
		branch: (detached ? head.stdout.trim() : symbolic.stdout.trim()) || "sin commits", detached,
		...parseStatus(status.stdout), tracking: upstream.code === 0, ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0,
	};
}

export interface Resources {
	host: string; cpu?: number; processCpu?: number; totalRam: number; availableRam: number; rss: number; memoryEstimated: boolean;
	disk?: { total: number; used: number; available: number };
}
export function cpuTotals(): { idle: number; total: number } {
	return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}
export function cpuPercent(before: { idle: number; total: number }, after: { idle: number; total: number }): number | undefined {
	const total = after.total - before.total;
	return total > 0 ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100)) : undefined;
}
export function linuxAvailable(raw: string): number | undefined {
	const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(raw);
	return match ? Number(match[1]) * 1024 : undefined;
}
export function macAvailable(raw: string): number | undefined {
	const page = /page size of (\d+) bytes/.exec(raw); if (!page) return undefined;
	let pages = 0;
	for (const name of ["free", "inactive", "speculative"]) { const count = new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(raw); if (count) pages += Number(count[1]); }
	return pages * Number(page[1]);
}
export function resourceReader(run: ReadCommand = readCommand) {
	let previous: ReturnType<typeof cpuTotals> | undefined;
	let processSample = process.cpuUsage(); let sampledAt = performance.now();
	return async (cwd: string, signal?: AbortSignal): Promise<Resources> => {
		const sample = cpuTotals(); const cpu = previous ? cpuPercent(previous, sample) : undefined; previous = sample;
		const now = performance.now(); const usage = process.cpuUsage(); const elapsed = now - sampledAt;
		const processCpu = elapsed > 100 ? Math.min(100, ((usage.user - processSample.user + usage.system - processSample.system) / (elapsed * 1000 * Math.max(1, cpus().length))) * 100) : undefined;
		processSample = usage; sampledAt = now;
		let availableRam = freemem(); let memoryEstimated = true;
		if (platform() === "linux") {
			try { const available = linuxAvailable(await readFile("/proc/meminfo", "utf8")); if (available !== undefined) { availableRam = available; memoryEstimated = false; } } catch { /* freemem es el fallback. */ }
		} else if (platform() === "darwin") {
			const vm = await run("vm_stat", [], cwd, signal); const available = vm.code === 0 ? macAvailable(vm.stdout) : undefined;
			if (available !== undefined) availableRam = available;
		}
		let disk: Resources["disk"];
		try { const info = await statfs(cwd); disk = { total: info.blocks * info.bsize, used: (info.blocks - info.bfree) * info.bsize, available: info.bavail * info.bsize }; } catch { /* no disponible */ }
		return { host: hostname(), ...(cpu === undefined ? {} : { cpu }), ...(processCpu === undefined ? {} : { processCpu }), totalRam: totalmem(), availableRam: Math.min(totalmem(), Math.max(0, availableRam)), rss: process.memoryUsage().rss, memoryEstimated, ...(disk ? { disk } : {}) };
	};
}

export interface GithubSnapshot { branch: string; pr?: string; runs: { id: number; name: string; status: string; conclusion: string | null; jobs?: string }[] }
export async function readGithub(git: GitSnapshot, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<GithubSnapshot> {
	if (git.detached) return { branch: git.branch, runs: [] };
	const result = await run("gh", ["run", "list", "--branch", git.branch, "--limit", "3", "--json", "databaseId,displayTitle,name,status,conclusion"], git.root, signal);
	if (result.code !== 0 || result.truncated) throw new Error("GitHub no disponible (gh, autenticación o red)");
	const raw: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(raw)) throw new Error("Respuesta de GitHub no válida");
	const runs: GithubSnapshot["runs"] = raw.filter((item) => item && typeof item === "object" && typeof item.databaseId === "number" && typeof item.name === "string" && typeof item.status === "string")
		.slice(0, 3).map((item) => ({ id: item.databaseId as number, name: item.name as string, status: item.status as string, conclusion: typeof item.conclusion === "string" ? item.conclusion : null }));
	const [prResult, jobResult] = await Promise.all([
		run("gh", ["pr", "view", "--json", "number,title,state,isDraft"], git.root, signal),
		runs[0] ? run("gh", ["run", "view", String(runs[0].id), "--json", "jobs"], git.root, signal) : Promise.resolve(undefined),
	]);
	let pr: string | undefined;
	if (prResult.code === 0 && !prResult.truncated) { const data = JSON.parse(prResult.stdout); if (typeof data.number === "number" && typeof data.title === "string") pr = `PR #${data.number}${data.isDraft ? " · Draft" : ""} · ${data.title}`; }
	if (jobResult?.code === 0 && !jobResult.truncated && runs[0]) {
		const data = JSON.parse(jobResult.stdout);
		if (Array.isArray(data.jobs)) runs[0].jobs = data.jobs.slice(0, 15).filter((job: { name?: unknown }) => typeof job.name === "string")
			.map((job: { name: string; status: string; conclusion?: string }) => `${job.name}: ${job.conclusion || job.status}`).join("\n");
	}
	return { branch: git.branch, ...(pr ? { pr } : {}), runs };
}
export interface EnvironmentStatus { service: string; name: string; state: string; version?: string }
export async function readEnvironments(io: Io, signal: AbortSignal): Promise<{ project?: string; environments: EnvironmentStatus[] }> {
	const link = await loadProjectLink(io.cwd); if (!link) return { environments: [] };
	const { client } = await openSession(io); const org = await resolveOrganization(client, link.organizationSlug, signal);
	const environments: EnvironmentStatus[] = [];
	for (const service of link.services.slice(0, 10)) {
		const view = await client.request("GET", `/organizations/${encodeURIComponent(org.organization_id)}/projects/${encodeURIComponent(link.projectSlug)}/services/${encodeURIComponent(service.name)}`, ServiceSchema, { signal });
		for (const environment of view.environments) environments.push({ service: service.name, name: environment.name, state: environment.state, ...(environment.current_version ? { version: environment.current_version } : {}) });
	}
	return { project: `${link.organizationSlug}/${link.projectSlug}`, environments };
}
const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_LINES = 2000;
/** Heurística para pedir una confirmación extra, no una garantía de detectar todos los secretos. */
export function sensitivePreviewPath(path: string): boolean {
	return path.split(/[\\/]/).some((part) => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|(?:auth|tokens?)(?:\.(?:json|ya?ml|toml))?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
}
/** Sólo por una apertura explícita en Cambios; nunca se llama desde el polling ni se envía al chat. */
export async function readUntrackedPreview(git: GitSnapshot, file: ChangedFile, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const title = `ARCHIVO NUEVO · ${safeText(file.path)}\nSólo lectura local · no enviado al modelo\n\n`;
	const root = await realpath(git.root); const path = resolve(root, file.path);
	if (isAbsolute(file.path) || !isInside(root, path) || path === root) return title + "No se previsualizan rutas fuera del checkout.";
	const entry = await lstat(path);
	if (entry.isSymbolicLink()) return title + "Enlace simbólico: no se abre su destino.";
	if (!entry.isFile()) return title + "No es un archivo regular. Seleccioná un archivo, no un directorio o dispositivo.";
	const target = await realpath(path);
	if (!isInside(root, target)) return title + "No se previsualizan rutas fuera del checkout.";
	// O_NONBLOCK evita quedar esperando si un archivo se reemplaza por un FIFO.
	const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		signal?.throwIfAborted();
		if (!(await handle.stat()).isFile()) return title + "No es un archivo regular.";
		const buffer = Buffer.alloc(PREVIEW_BYTES + 1); let count = 0;
		while (count < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
			if (!bytesRead) break;
			count += bytesRead;
		}
		signal?.throwIfAborted();
		const truncatedBytes = count > PREVIEW_BYTES; const bytes = buffer.subarray(0, Math.min(count, PREVIEW_BYTES));
		if (bytes.includes(0)) return title + "Archivo binario: no hay previsualización de texto.";
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncatedBytes }); }
		catch { return title + "Archivo binario o codificación no UTF-8: no hay previsualización de texto."; }
		const lines = content.split("\n"); const truncatedLines = lines.length > PREVIEW_LINES;
		const visible = lines.slice(0, PREVIEW_LINES).map(safeText).join("\n");
		return title + (visible || "(archivo vacío)") + (truncatedBytes || truncatedLines ? "\n\n[Vista parcial: máximo 256 KiB o 2000 líneas. El archivo no fue modificado.]" : "");
	} finally { await handle.close(); }
}
export async function readFileDiff(git: GitSnapshot, file: ChangedFile, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<string> {
	if (file.status === "??") return `Archivo sin seguimiento: ${safeText(file.path)}\n\nNo se lee automáticamente su contenido (podría ser un secreto).`;
	const args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--color=never", "--", file.path];
	const [working, staged] = await Promise.all([run("git", args, git.root, signal), run("git", [...args.slice(0, 3), "--cached", ...args.slice(3)], git.root, signal)]);
	return ["CAMBIOS SIN STAGE", working.code === 0 ? working.stdout || "Sin cambios." : "Diff no disponible o demasiado grande.", "CAMBIOS EN STAGE", staged.code === 0 ? staged.stdout || "Sin cambios." : "Diff no disponible o demasiado grande."].join("\n\n");
}
export function workspaceName(git: GitSnapshot | undefined): string { return git ? git.linked ? `Worktree · ${basename(git.root)}` : "Repo principal" : "Sin Git"; }
