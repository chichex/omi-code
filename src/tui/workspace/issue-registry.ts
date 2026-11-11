// Registro local compartido por todos los worktrees. No son etiquetas de GitHub.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GitSnapshot, GithubItem } from "./data.ts";
import { IssueTriageStateSchema, restoreIssueTriage, type IssueTriageState } from "./issue-triage.ts";
import { inspectIssueWorktree, issueWorktreePath, registeredIssueWorktrees } from "./issue-worktree.ts";
import { readSessionSnapshot } from "./session-files.ts";

const PreparationSchema = Type.Object({
	version: Type.Literal(1), commonDir: Type.String({ minLength: 1, maxLength: 8192 }), state: IssueTriageStateSchema,
	phase: Type.Union([Type.Literal("triaged"), Type.Literal("worktree"), Type.Literal("ready")]),
	source: Type.Object({ body: Type.String({ maxLength: 100_000 }), labels: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 }) }, { additionalProperties: false }),
	sessionFile: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
}, { additionalProperties: false });
export type IssuePreparation = Static<typeof PreparationSchema>;
export interface IssuePreparationEntry { record?: IssuePreparation; error?: string }
export function assertIssueIdentity(record: IssuePreparation, item: Pick<GithubItem, "number" | "url">): void {
	if (record.state.issue.number !== item.number || record.state.issue.url && item.url && record.state.issue.url.replace(/\/+$/, "").toLowerCase() !== item.url.replace(/\/+$/, "").toLowerCase()) {
		throw new Error(`El triage guardado corresponde a otro issue/repositorio: ${record.state.issue.url}. No se reutiliza ni se reemplaza para ${item.url}.`);
	}
}
type Repo = Pick<GitSnapshot, "root" | "commonDir" | "mainRoot">;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
export const issueRegistryDir = (git: Pick<GitSnapshot, "commonDir">): string => join(git.commonDir, "omi", "issue-workspaces");
function recordPath(git: Repo, number: number): string {
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Número de issue no válido");
	return join(issueRegistryDir(git), `${number}.json`);
}
async function validateRecord(git: Repo, number: number, value: unknown): Promise<IssuePreparation> {
	if (!Value.Check(PreparationSchema, value) || value.state.issue.number !== number || !isAbsolute(value.commonDir) || value.commonDir !== await realpath(git.commonDir)
		|| !isAbsolute(value.state.worktree) || resolve(value.state.worktree) !== resolve(issueWorktreePath(git, number))
		|| value.sessionFile !== undefined && !isAbsolute(value.sessionFile) || value.phase === "ready" && !value.sessionFile) {
		throw new Error(`Registro local del issue #${number} inválido o de otro repositorio. No se reemplazó nada: ${recordPath(git, number)}`);
	}
	return value;
}
export async function readIssuePreparation(git: Repo, number: number): Promise<IssuePreparation | undefined> {
	const path = recordPath(git, number);
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Archivo de registro no válido");
		return await validateRecord(git, number, JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (missing(error)) return undefined;
		throw new Error(`No se pudo leer el registro del issue #${number}: ${path}. ${error instanceof Error ? error.message : "Registro inválido"}`);
	}
}
/** El llamador debe tener el lock del issue. Un rename nunca publica un JSON parcial. */
export async function saveIssuePreparation(git: Repo, record: IssuePreparation): Promise<void> {
	await validateRecord(git, record.state.issue.number, record);
	const path = recordPath(git, record.state.issue.number); const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(issueRegistryDir(git), { recursive: true, mode: 0o700 });
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
		finally { await handle.close(); }
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}
export class IssuePreparationBusyError extends Error {}
/** Sin vencimiento por tiempo: nunca robarle un lock a un clasificador lento de otra ventana. */
export async function withIssuePreparationLock<T>(git: Repo, number: number, action: () => Promise<T>): Promise<T> {
	const path = recordPath(git, number).replace(/\.json$/, ".lock");
	await mkdir(issueRegistryDir(git), { recursive: true, mode: 0o700 });
	let handle;
	try { handle = await open(path, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new IssuePreparationBusyError(`El issue #${number} ya se está preparando en otra ventana. Reintentá al terminar. Si OMI se cerró de golpe, verificá el proceso indicado en ${path} antes de quitar ese lock.`);
		throw error;
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }) + "\n");
		return await action();
	} finally { try { await handle.close(); } finally { await rm(path, { force: true }); } }
}
/** Lectura pura del JSONL: SessionManager.open podría migrarlo o completar su última línea. */
export async function readIssueSession(sessionFile: string, expected?: IssueTriageState): Promise<IssueTriageState> {
	const session = await readSessionSnapshot(sessionFile);
	const branch = session.getBranch(); const state = restoreIssueTriage(branch, session.getCwd());
	if (!state || expected && !isDeepStrictEqual(state, expected)
		|| !branch.some((entry) => entry.type === "message" && entry.message.role === "user")
		|| !branch.some((entry) => entry.type === "custom_message" && entry.customType === "omi-issue-triage" && entry.display)) {
		throw new Error(`La sesión guardada no conserva el triage completo en su rama activa: ${sessionFile}. Revisala con /resume; no se creó otra sesión.`);
	}
	return state;
}
export async function verifyIssuePreparation(git: Repo, record: IssuePreparation, signal?: AbortSignal): Promise<void> {
	if (await inspectIssueWorktree(git, record.state, signal) !== "ready") throw new Error(`Falta el worktree guardado en ${record.state.worktree}. Recuperalo antes de retomar; no se recreó ni se borró nada.`);
	if (!record.sessionFile) throw new Error("La preparación aún no tiene una sesión guardada");
	try { await readIssueSession(record.sessionFile, record.state); }
	catch (error) {
		if (missing(error)) throw new Error(`Falta la sesión guardada en ${record.sessionFile}. Recuperala o abrí la sesión correcta con /resume; OMI no reemplaza la conversación.`);
		throw error;
	}
}
export async function loadIssuePreparations(git: Repo): Promise<Map<number, IssuePreparationEntry>> {
	let names: string[];
	try { names = await readdir(issueRegistryDir(git)); }
	catch (error) { if (missing(error)) return new Map(); throw error; }
	const result = new Map<number, IssuePreparationEntry>();
	for (const name of names.filter((name) => /^[1-9]\d*\.json$/.test(name))) {
		const number = Number(name.slice(0, -5)); if (!Number.isSafeInteger(number)) continue;
		let record: IssuePreparation | undefined;
		try {
			record = await readIssuePreparation(git, number);
			if (record?.phase === "ready") {
				// Sólo stat en el refresco; la identidad Git y el JSONL se verifican al abrir/retomar.
				const tree = await lstat(record.state.worktree); const session = await lstat(record.sessionFile!);
				if (!tree.isDirectory() || tree.isSymbolicLink() || !session.isFile() || session.isSymbolicLink()) throw new Error("Ruta de worktree o sesión inválida");
			}
			if (record) result.set(number, { record });
		} catch (error) { result.set(number, { ...(record ? { record } : {}), error: missing(error) ? "Falta el worktree o la sesión guardada. Recuperación pendiente; no se recrean automáticamente." : error instanceof Error ? error.message : "Registro local no disponible" }); }
	}
	return result;
}
/** Migración de preparaciones anteriores al registro. Nunca adoptar sólo por el nombre de carpeta. */
export async function discoverLegacyPreparations(git: Repo, known: ReadonlyMap<number, IssuePreparationEntry>, sessionDir?: string, signal?: AbortSignal, onlyNumber?: number): Promise<Map<number, IssuePreparationEntry>> {
	const candidates = (await registeredIssueWorktrees(git, signal)).flatMap((tree) => {
		const number = Number(/^issue-([1-9]\d*)$/.exec(basename(tree.worktree))?.[1]);
		return Number.isSafeInteger(number) && (onlyNumber === undefined || number === onlyNumber) && !known.has(number) && resolve(tree.worktree) === resolve(issueWorktreePath(git, number)) ? [{ number, worktree: tree.worktree }] : [];
	});
	const result = new Map<number, IssuePreparationEntry>(); if (!candidates.length) return result;
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const sessions = sessionDir ? await SessionManager.listAll(sessionDir, undefined, signal) : await SessionManager.listAll(undefined, signal);
	for (const candidate of candidates) {
		const matches: IssuePreparation[] = [];
		for (const session of sessions.filter((session) => resolve(session.cwd) === resolve(candidate.worktree))) {
			signal?.throwIfAborted();
			try {
				const state = await readIssueSession(session.path);
				if (state.issue.number !== candidate.number || resolve(state.worktree) !== resolve(candidate.worktree)) continue;
				const record: IssuePreparation = { version: 1, commonDir: await realpath(git.commonDir), state, phase: "ready", source: { body: "", labels: [] }, sessionFile: session.path };
				await validateRecord(git, candidate.number, record); await verifyIssuePreparation(git, record, signal); matches.push(record);
			} catch { signal?.throwIfAborted(); /* Sesión ajena/incompleta: no adoptarla. */ }
		}
		if (matches.length === 1) result.set(candidate.number, { record: matches[0]! });
		else if (matches.length > 1) result.set(candidate.number, { error: "Hay varias sesiones con triage para este worktree. Elegí la correcta con /resume; OMI la vinculará sin duplicarla." });
	}
	return result;
}
/** /resume o /fork explícitos pasan a ser el destino de retomar, pero sólo con el mismo triage y Git. */
export async function rememberIssueSession(git: Repo, state: IssueTriageState, sessionFile: string, signal?: AbortSignal): Promise<void> {
	const previous = await readIssuePreparation(git, state.issue.number);
	if (previous && (!isDeepStrictEqual(previous.state, state) || previous.sessionFile === sessionFile && previous.phase === "ready")) return;
	try {
		await withIssuePreparationLock(git, state.issue.number, async () => {
			const latest = await readIssuePreparation(git, state.issue.number);
			if (latest && !isDeepStrictEqual(latest.state, state)) return;
			const record: IssuePreparation = { version: 1, commonDir: await realpath(git.commonDir), state, phase: "ready", source: latest?.source ?? { body: "", labels: [] }, sessionFile };
			await validateRecord(git, state.issue.number, record); await verifyIssuePreparation(git, record, signal); await saveIssuePreparation(git, record);
		});
	} catch (error) { if (!(error instanceof IssuePreparationBusyError)) throw error; }
}
