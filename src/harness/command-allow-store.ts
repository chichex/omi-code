// Prefijos que la persona eligió no volver a preguntar, por KB, producto y repo, en esta máquina.
// Vive en <OMI_HOME>/agent/command-allow, junto al registro de Foundations. Como ese registro, no es una frontera
// de seguridad: lo protege del modelo dentro del harness, no de un shell ajeno.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentDir } from "../core/paths.ts";
import { commandPrefix, MAX_ALLOWED } from "./command-allow.ts";
import { trustPath, type TrustKey } from "./foundations-trust.ts";

const MAX_BYTES = 512 * 1024;
const Text = (max: number) => Type.String({ maxLength: max });
const RecordSchema = Type.Object({
	version: Type.Literal(1), kbUrl: Text(2000), product: Text(200), repo: Text(200),
	prefixes: Type.Array(Text(2000), { maxItems: MAX_ALLOWED, uniqueItems: true }),
}, { additionalProperties: false });
type AllowRecord = TrustKey & { version: 1; prefixes: string[] };

export const commandAllowDir = (homeDir: string): string => join(agentDir(homeDir), "command-allow");
const codeIs = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;
const unsafe = (dir: string) => new Error(`Registro de comandos permitidos inseguro: ${dir} no es un directorio propio (symlink)`);
async function safeDirectory(dir: string, create: boolean): Promise<boolean> {
	if (create) {
		try { await mkdir(dir, { recursive: true, mode: 0o700 }); } catch (error) { if (!codeIs(error, "EEXIST")) throw error; }
	}
	try {
		const entry = await lstat(dir);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe(dir);
		if (create && (entry.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
		return true;
	} catch (error) { if (codeIs(error, "ENOENT")) return false; throw error; }
}
// Sólo la forma que propone el diálogo: `git log`, no `git` ni `git -c`, también si alguien edita el archivo a mano.
const allowable = (prefix: string): boolean => commandPrefix(prefix) === prefix;
const valid = (value: unknown, key: TrustKey): value is AllowRecord => Value.Check(RecordSchema, value) && value.kbUrl === key.kbUrl && value.product === key.product && value.repo === key.repo && value.prefixes.every(allowable);
/** Los prefijos de este repo. Sin archivo, roto, ajeno, inseguro o con un prefijo que no es simple: ninguno. */
export async function readAllowedPrefixes(dir: string, key: TrustKey): Promise<string[]> {
	try {
		if (!(await safeDirectory(dir, false))) return [];
		const file = await open(trustPath(dir, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const entry = await file.stat();
			if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_BYTES) return [];
			const value: unknown = JSON.parse((await file.readFile()).toString("utf8"));
			return valid(value, key) ? [...value.prefixes] : [];
		} finally { await file.close(); }
	} catch { return []; }
}
// Para modificar: ausente es una lista vacía, pero ilegible no. Pisarlo borraría lo que la persona ya había permitido.
async function readForUpdate(dir: string, key: TrustKey): Promise<string[]> {
	const path = trustPath(dir, key);
	try { await lstat(path); } catch (error) { if (codeIs(error, "ENOENT")) return []; throw error; }
	const unreadable = new Error(`El registro de comandos permitidos (${path}) no se puede leer: no se cambió. Revisalo o borralo y volvé a permitir los comandos.`);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw unreadable; });
	try {
		const entry = await file.stat();
		if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_BYTES) throw unreadable;
		let value: unknown;
		try { value = JSON.parse((await file.readFile()).toString("utf8")); } catch { throw unreadable; }
		if (!valid(value, key)) throw unreadable;
		return [...value.prefixes];
	} finally { await file.close(); }
}
// Cola por ruta, sólo en este proceso: dos «no volver a preguntar» seguidos no se pisan. Entre procesos no hay
// control de concurrencia: dos sesiones que guardan a la vez pueden perder uno de los dos prefijos.
const writes = new Map<string, Promise<void>>();
async function update(dir: string, key: TrustKey, change: (prefixes: string[]) => string[]): Promise<void> {
	await safeDirectory(dir, true);
	const directory = await realpath(dir); const path = trustPath(directory, key);
	const previous = writes.get(path) ?? Promise.resolve();
	const current = previous.then(async () => {
		const prefixes = change(await readForUpdate(directory, key));
		const record: AllowRecord = { version: 1, kbUrl: key.kbUrl, product: key.product, repo: key.repo, prefixes };
		if (!valid(record, key)) throw new Error("Registro de comandos permitidos inválido; no se guardó");
		try {
			const entry = await lstat(path);
			if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("Registro de comandos permitidos inseguro: symlink o hardlink");
		} catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
		const temp = join(directory, `.${randomUUID()}.tmp`);
		try {
			const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
			await rename(temp, path);
		} finally { await unlink(temp).catch(() => {}); }
	});
	const settled = current.then(() => {}, () => {});
	writes.set(path, settled);
	try { await current; } finally { if (writes.get(path) === settled) writes.delete(path); }
}
/** Sólo tras el sí de la persona en el diálogo. Un prefijo repetido no se duplica. */
export async function addAllowedPrefix(dir: string, key: TrustKey, prefix: string): Promise<void> {
	if (!allowable(prefix)) throw new Error(`«${prefix}» no es un prefijo que se pueda permitir; no se guardó`);
	await update(dir, key, (prefixes) => {
		if (prefixes.includes(prefix)) return prefixes;
		if (prefixes.length >= MAX_ALLOWED) throw new Error(`Ya hay el máximo de ${MAX_ALLOWED} comandos permitidos en este repo: quitá alguno con /omi-permitidos`);
		return [...prefixes, prefix];
	});
}
export async function removeAllowedPrefix(dir: string, key: TrustKey, prefix: string): Promise<void> {
	await update(dir, key, (prefixes) => prefixes.filter((value) => value !== prefix));
}
