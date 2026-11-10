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
export interface FileLineStats { added: number; removed: number }
export interface ChangedFile { status: string; path: string; previousPath?: string; lines?: FileLineStats | "binary" }
export interface GitSnapshot {
	root: string; gitDir: string; commonDir: string; mainRoot: string; linked: boolean;
	branch: string; detached: boolean; changes: ChangedFile[]; changeCount: number;
	tracking: boolean | undefined; upstream?: string; ahead: number | undefined; behind: number | undefined;
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
/** --numstat -z: los nombres pueden incluir tabs/saltos de línea; los renames traen dos rutas aparte. */
export function parseNumstat(raw: string): Map<string, FileLineStats | "binary"> | undefined {
	const result = new Map<string, FileLineStats | "binary">();
	if (!raw) return result;
	if (!raw.endsWith("\0")) return undefined;
	const records = raw.slice(0, -1).split("\0");
	for (let i = 0; i < records.length; i++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]!); if (!match) return undefined;
		let path = match[3]!;
		if (!path) { const previous = records[++i]; path = records[++i] ?? ""; if (!previous || !path) return undefined; }
		if (result.has(path)) return undefined;
		if (match[1] === "-" && match[2] === "-") result.set(path, "binary");
		else {
			const added = Number(match[1]); const removed = Number(match[2]);
			if (!/^\d+$/.test(match[1]!) || !/^\d+$/.test(match[2]!) || !Number.isSafeInteger(added) || !Number.isSafeInteger(removed)) return undefined;
			result.set(path, { added, removed });
		}
	}
	return result;
}
async function readLineStats(root: string, changes: ChangedFile[], hasHead: boolean, signal: AbortSignal | undefined, run: ReadCommand): Promise<void> {
	const tracked = changes.filter((file) => file.status !== "??"); if (!tracked.length) return;
	let base = "HEAD";
	if (!hasHead) {
		// Árbol vacío de Git, sin crear objetos ni modificar el índice; también sirve en repos SHA-256.
		const format = await run("git", ["rev-parse", "--show-object-format"], root, signal);
		if (format.code !== 0 || format.truncated) return;
		const emptyTrees: Record<string, string> = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };
		const empty = emptyTrees[format.stdout.trim()]; if (!empty) return; base = empty;
	}
	const renamed = tracked.filter((file) => file.previousPath && file.status.includes("R"));
	const statsFor = async (files: ChangedFile[], renames: boolean) => {
		const paths = [...new Set(files.flatMap((file) => file.previousPath ? [file.path, file.previousPath] : [file.path]))];
		const diff = await run("git", ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--color=never", renames ? "--find-renames" : "--no-renames", base, "--", ...paths.map((path) => `:(literal)${path}`)], root, signal);
		return diff.code === 0 && !diff.truncated ? parseNumstat(diff.stdout) : undefined;
	};
	// Respetar las filas del status: no convertir una alta y una baja independientes en un rename implícito.
	const [stats, renameStats] = await Promise.all([statsFor(tracked, false), renamed.length ? statsFor(renamed, true) : undefined]);
	if (!stats) return;
	for (const file of tracked) {
		const source = renamed.includes(file) ? renameStats : stats; if (!source) continue;
		const values = [source.get(file.path), ...(file.previousPath && file.status.includes("R") ? [source.get(file.previousPath)] : [])];
		file.lines = values.includes("binary") ? "binary" : values.reduce<FileLineStats>((sum, value) => value && value !== "binary" ? { added: sum.added + value.added, removed: sum.removed + value.removed } : sum, { added: 0, removed: 0 });
	}
}
/** Commits contra la referencia local del upstream (último fetch). Nunca hace fetch ni convierte errores en 0/0. */
async function readTracking(root: string, ref: string | undefined, hasHead: boolean, signal: AbortSignal | undefined, run: ReadCommand): Promise<Pick<GitSnapshot, "tracking" | "upstream" | "ahead" | "behind">> {
	const unknown = { tracking: undefined, ahead: undefined, behind: undefined };
	if (ref === undefined) return { ...unknown, tracking: false }; // HEAD separado.
	if (!ref.startsWith("refs/heads/")) return unknown;
	const result = await run("git", ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:short)", "--count=1", "--", ref], root, signal);
	if (result.code !== 0 || result.truncated) return unknown;
	if (!result.stdout) return hasHead ? unknown : { ...unknown, tracking: false }; // Branch sin commits, no una lectura vacía de un branch existente.
	const match = /^([^\0\n]+)\0([^\0\n]*)\0([^\0\n]*)\n?$/.exec(result.stdout);
	if (!match || match[1] !== ref) return unknown;
	if (!match[2] && !match[3]) return { ...unknown, tracking: false };
	if (!match[2]?.startsWith("refs/") || !match[3]) return unknown;
	const tracking = { ...unknown, tracking: true, upstream: match[3] };
	const counts = await run("git", ["rev-list", "--left-right", "--count", `HEAD...${match[2]}`], root, signal);
	const values = counts.code === 0 && !counts.truncated ? /^\s*(\d+)\s+(\d+)\s*$/.exec(counts.stdout) : undefined;
	if (!values) return tracking;
	const ahead = Number(values[1]); const behind = Number(values[2]);
	return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) ? { ...tracking, ahead, behind } : tracking;
}
export async function readGit(cwd: string, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<GitSnapshot | undefined> {
	const paths = await run("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], cwd, signal);
	if (paths.code !== 0 || paths.truncated) return undefined;
	const [root, gitDir, commonDir] = paths.stdout.trimEnd().split("\n");
	if (!root || !gitDir || !commonDir) return undefined;
	const [symbolic, head, status, worktrees] = await Promise.all([
		run("git", ["symbolic-ref", "--quiet", "HEAD"], cwd, signal),
		run("git", ["rev-parse", "--short", "HEAD"], cwd, signal),
		run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, signal),
		run("git", ["worktree", "list", "--porcelain", "-z"], cwd, signal),
	]);
	if (status.code !== 0 || status.truncated) throw new Error("No se pudo leer el estado completo de Git");
	const parsed = parseStatus(status.stdout);
	const detached = symbolic.code !== 0;
	const ref = detached ? undefined : symbolic.truncated ? "" : symbolic.stdout.trim();
	const [tracking] = await Promise.all([readTracking(root, ref, head.code === 0, signal, run), readLineStats(root, parsed.changes, head.code === 0, signal, run)]);
	const first = worktrees.stdout.split("\0").find((record) => record.startsWith("worktree "));
	return {
		root, gitDir, commonDir, mainRoot: first?.slice(9) || root, linked: resolve(gitDir) !== resolve(commonDir),
		branch: (detached ? head.stdout.trim() : symbolic.stdout.trim().replace(/^refs\/heads\//, "")) || "sin commits", detached,
		...parsed, ...tracking,
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

export type GithubKind = "issue" | "pr";
export interface GithubItem {
	number: number; title: string; author: string; labels: string[]; url: string; updatedAt: string;
	draft: boolean; head: string; base: string; review: string;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
export async function readGithub(git: GitSnapshot, kind: GithubKind, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<GithubItem[]> {
	const fields = "number,title,author,labels,url,updatedAt" + (kind === "pr" ? ",isDraft,headRefName,baseRefName,reviewDecision" : "");
	// Todo el repo, no sólo la branch actual. También funciona con HEAD separado.
	const result = await run("gh", [kind, "list", "--state", "open", "--limit", "100", "--json", fields], git.root, signal);
	if (result.code !== 0 || result.truncated) throw new Error("GitHub no disponible (gh, autenticación o red)");
	const raw: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(raw)) throw new Error("Respuesta de GitHub no válida");
	return raw.slice(0, 100).map((value) => {
		const item = object(value);
		if (!Number.isSafeInteger(item.number) || Number(item.number) <= 0 || typeof item.title !== "string") throw new Error("Respuesta de GitHub no válida");
		return {
			number: Number(item.number), title: item.title, author: String(object(item.author).login ?? "desconocido"),
			labels: Array.isArray(item.labels) ? item.labels.map((label) => object(label).name).filter((name): name is string => typeof name === "string") : [],
			url: typeof item.url === "string" ? item.url : "", updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
			draft: item.isDraft === true, head: typeof item.headRefName === "string" ? item.headRefName : "", base: typeof item.baseRefName === "string" ? item.baseRefName : "", review: typeof item.reviewDecision === "string" ? item.reviewDecision : "",
		};
	});
}
export async function readGithubDetail(git: GitSnapshot, kind: GithubKind, number: number, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<string> {
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Número de GitHub no válido");
	const result = await run("gh", [kind, "view", String(number), "--json", "body"], git.root, signal);
	if (result.code !== 0 || result.truncated) throw new Error("Detalle no disponible o demasiado grande");
	const data = object(JSON.parse(result.stdout));
	if (typeof data.body !== "string") throw new Error("Detalle de GitHub no válido");
	return data.body;
}
export interface EnvironmentStatus { service: string; name: string; state: string; version?: string }
export async function readEnvironments(io: Io, signal: AbortSignal): Promise<{ project?: string; services: string[]; environments: EnvironmentStatus[] }> {
	const link = await loadProjectLink(io.cwd); if (!link) return { services: [], environments: [] };
	const { client } = await openSession(io); const org = await resolveOrganization(client, link.organizationSlug, signal);
	const environments: EnvironmentStatus[] = [];
	for (const service of link.services.slice(0, 10)) {
		const view = await client.request("GET", `/organizations/${encodeURIComponent(org.organization_id)}/projects/${encodeURIComponent(link.projectSlug)}/services/${encodeURIComponent(service.name)}`, ServiceSchema, { signal });
		for (const environment of view.environments) environments.push({ service: service.name, name: environment.name, state: environment.state, ...(environment.current_version ? { version: environment.current_version } : {}) });
	}
	return { project: `${link.organizationSlug}/${link.projectSlug}`, services: link.services.slice(0, 10).map((service) => service.name), environments };
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
