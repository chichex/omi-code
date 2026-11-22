// Qué revisión de Foundations aceptó la persona, por KB, producto y repo. Vive en <OMI_HOME>/agent/foundations.
// No es una frontera de seguridad: lo protege del modelo dentro del harness, no de un shell ajeno.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentDir } from "../core/paths.ts";
import { checkBlock, foundationsHash, type FoundationsBlock } from "./foundations.ts";

const MAX_BYTES = 1024 * 1024;
const Text = (max = 2000) => Type.String({ maxLength: max });
const RecordSchema = Type.Object({
	version: Type.Literal(2), kbUrl: Text(), product: Text(200), repo: Text(200),
	accepted: Type.Union([Type.Object({ docId: Text(200), blockHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), block: Type.Unknown(), author: Text(400), date: Text(100), acceptedAt: Text(100) }, { additionalProperties: false }), Type.Null()]),
	offerDeclined: Type.Boolean(),
}, { additionalProperties: false });
export interface TrustKey { kbUrl: string; product: string; repo: string }
export interface AcceptedRevision { docId: string; blockHash: string; block: FoundationsBlock; author: string; date: string; acceptedAt: string }
export interface TrustRecord extends TrustKey { version: 2; accepted: AcceptedRevision | null; offerDeclined: boolean }

export const foundationsDir = (homeDir: string): string => join(agentDir(homeDir), "foundations");
export function trustPath(dir: string, key: TrustKey): string {
	return join(dir, `${createHash("sha256").update(JSON.stringify([key.kbUrl, key.product, key.repo])).digest("hex").slice(0, 32)}.json`);
}
const codeIs = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;
async function safeDirectory(dir: string, create: boolean): Promise<boolean> {
	if (create) {
		try { await mkdir(dir, { recursive: true, mode: 0o700 }); } catch (error) { if (!codeIs(error, "EEXIST")) throw error; }
	}
	try {
		const entry = await lstat(dir);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Registro de Foundations inseguro: ${dir} no es un directorio propio (symlink)`);
		if (create && (entry.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
		return true;
	} catch (error) { if (codeIs(error, "ENOENT")) return false; throw error; }
}

/** El registro de esta KB, producto y repo; corrupto, ajeno o inseguro cuenta como nada aceptado. */
export async function readTrust(dir: string, key: TrustKey): Promise<TrustRecord | undefined> {
	try {
		if (!(await safeDirectory(dir, false))) return undefined;
		const file = await open(trustPath(dir, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let raw: string;
		try {
			const entry = await file.stat();
			if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_BYTES) return undefined;
			raw = (await file.readFile()).toString("utf8");
		} finally { await file.close(); }
		const value: unknown = JSON.parse(raw);
		if (!Value.Check(RecordSchema, value) || value.kbUrl !== key.kbUrl || value.product !== key.product || value.repo !== key.repo) return undefined;
		if (!value.accepted) return { ...value, accepted: null };
		const checked = checkBlock(value.accepted.block);
		if ("reason" in checked || foundationsHash(checked.block) !== value.accepted.blockHash || checked.block.repo !== key.repo) return undefined;
		return { ...value, accepted: { ...value.accepted, block: checked.block } };
	} catch { return undefined; }
}

export interface TrustWriteOptions {
	/** Una confirmación pendiente sólo escribe si sigue vigente la aceptación que leyó antes de preguntar. */
	expected?: TrustRecord | null;
	isCurrent?: () => boolean;
	/** Frontera de fallo/observación antes del reemplazo real; no sustituye rename ni finge persistencia. */
	beforeReplace?: (temporary: string, target: string) => Promise<void>;
}
// Cola por ruta real del registro, sólo en este proceso. Los lectores siguen viendo el archivo completo anterior.
const writes = new Map<string, Promise<void>>();
async function serializeTrustWrite(path: string, write: () => Promise<void>): Promise<void> {
	const previous = writes.get(path) ?? Promise.resolve();
	const current = previous.then(write);
	const settled = current.then(() => {}, () => {});
	writes.set(path, settled);
	try { await current; }
	finally { if (writes.get(path) === settled) writes.delete(path); }
}
async function assertTrustExpectation(dir: string, key: TrustKey, expected: string | undefined, isCurrent: TrustWriteOptions["isCurrent"]): Promise<void> {
	const checkGeneration = () => { if (isCurrent && isCurrent() !== true) throw new Error("La aceptación de Foundations quedó obsoleta; no se escribió ese permiso anterior."); };
	checkGeneration();
	if (expected !== undefined && JSON.stringify(await readTrust(dir, key) ?? null) !== expected) throw new Error("La aceptación de Foundations cambió; no se sobrescribió una revisión más nueva.");
	checkGeneration();
}
async function replaceTrustFile(dir: string, path: string, serialized: string, check: () => Promise<void>, beforeReplace: TrustWriteOptions["beforeReplace"]): Promise<void> {
	await check();
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("Registro de Foundations inseguro: symlink o hardlink");
	} catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
	const temp = join(dir, `.${randomUUID()}.tmp`);
	try {
		const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
		await beforeReplace?.(temp, path);
		// Volver a comprobar tras todo await, dentro de la cola y antes del punto de commit atómico.
		await check();
		await rename(temp, path);
	} finally { await unlink(temp).catch(() => {}); }
}
/** Escritura atómica, 0600, sin symlinks. Sólo tras una decisión humana; no es CAS entre procesos. */
export async function writeTrust(dir: string, record: TrustRecord, options: TrustWriteOptions = {}): Promise<void> {
	if (!Value.Check(RecordSchema, record)) throw new Error("Registro de Foundations inválido u obsoleto; configurá v2 de nuevo");
	if (record.accepted) {
		const checked = checkBlock(record.accepted.block);
		if ("reason" in checked || checked.block.repo !== record.repo || foundationsHash(checked.block) !== record.accepted.blockHash) throw new Error("Aceptación de Foundations inválida: bloque, repo o hash no coinciden");
	}
	const serialized = `${JSON.stringify(record, null, 2)}\n`;
	if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Registro de Foundations demasiado grande");
	const key: TrustKey = { kbUrl: record.kbUrl, product: record.product, repo: record.repo };
	const expected = options.expected === undefined ? undefined : JSON.stringify(options.expected);
	if (options.isCurrent && options.isCurrent() !== true) throw new Error("La aceptación de Foundations quedó obsoleta.");
	await safeDirectory(dir, true);
	const directory = await realpath(dir); const path = trustPath(directory, key);
	const check = () => assertTrustExpectation(directory, key, expected, options.isCurrent);
	await serializeTrustWrite(path, () => replaceTrustFile(directory, path, serialized, check, options.beforeReplace));
}
