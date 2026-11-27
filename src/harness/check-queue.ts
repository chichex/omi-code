// Cola de cortesía entre los worktrees de un repo para checks pesados (por ejemplo, npm test): no es un lock de
// integridad. El lock del estado (store.ts) jamás se roba por su edad ni por un PID; este turno sí se retira si su
// proceso ya no existe o si lleva el tope sin liberarse, porque equivocarse al juzgar un dueño muerto sólo hace correr
// dos checks a la vez. Falla abierta: con un enlace, un error de disco o la espera agotada, el check corre sin turno y
// lo avisa. Quien espera nunca crea archivos.
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Workflow } from "./model.ts";
import { codeIs, directories } from "./store.ts";

/** alive: sólo los tests lo reemplazan; por defecto, kill(pid, 0). */
export interface CheckTurnPolicy { pollMs: number; limitMs: number; alive?: (pid: number) => boolean }
export const CHECK_TURN_POLICY: CheckTurnPolicy = { pollMs: 1000, limitMs: 15 * 60_000 };
/** notice: qué pasó con el turno, para la salida del check; undefined si se tomó sin esperar. */
export interface CheckTurn { waitedMs: number; notice: string | undefined; release(): Promise<void> }

const MAX_RECORD_BYTES = 4096;
// Tolerante: un binario más nuevo puede sumar campos. Un pid fuera de rango no se juzga ni llega a un kill.
const OwnerSchema = Type.Object({ pid: Type.Integer({ minimum: 2, maximum: 2147483647 }), hostname: Type.String(), root: Type.String(), kind: Type.String(), command: Type.String() });
interface Holder { dev: number; ino: number; mtimeMs: number; pid: number | undefined; text: string }

export function checkTurnPath(checkout: Workflow["checkout"]): string {
 const { commonDir } = checkout;
 if (!isAbsolute(commonDir) || resolve(commonDir) !== commonDir || commonDir.includes("\0")) throw new Error("commonDir debe ser una ruta absoluta normalizada");
 return join(commonDir, "omi", "check-turn.lock");
}
const printable = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
function field(value: unknown, key: "command" | "root" | "hostname"): string {
 if (!value || typeof value !== "object" || !(key in value)) return "";
 const raw: unknown = Reflect.get(value, key);
 return typeof raw === "string" ? printable(raw) : "";
}
// De quién es el turno, con lo que dice el archivo ajeno: «npm test en issue-98».
function ownerText(value: unknown): string {
 const command = field(value, "command") || "un check"; const root = basename(field(value, "root")) || "otro worktree";
 const host = field(value, "hostname");
 return `${command} en ${root}${host && host !== printable(hostname()) ? ` (${host})` : ""}`;
}
function processAlive(pid: number): boolean {
 try { process.kill(pid, 0); return true; } catch (error) { return !codeIs(error, "ESRCH"); }
}
const minutes = (ms: number) => ms < 60_000 ? "menos de 1 min" : `${Math.round(ms / 60_000)} min`;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const NOTICES = {
 waited: (ms: number, owner: string) => `Esperó ${minutes(ms)} el turno de checks del repo: lo tenía ${owner}.`,
 dead: (owner: string) => `Se retiró el turno de checks del repo que tenía ${owner}: su proceso ya no existe.`,
 stale: (owner: string, limitMs: number) => `Se retiró el turno de checks del repo que tenía ${owner}: llevaba ${minutes(limitMs)} o más sin liberarse.`,
 limit: (ms: number, owner: string) => `Esperó ${minutes(ms)} el turno de checks del repo y corre igual: lo sigue teniendo ${owner}.`,
 unsafe: (path: string) => `El turno de checks del repo (${path}) es un enlace o no es un archivo común: corre sin turno y no lo toca.`,
 failed: (error: unknown) => `No se pudo usar el turno de checks del repo (${error instanceof Error ? ("code" in error && typeof error.code === "string" ? error.code : printable(error.message.replace(/^Harness store: /, ""))) : "error desconocido"}): corre sin turno.`,
};

// undefined: no hay turno o cambió mientras se leía; se vuelve a intentar enseguida.
async function readHolder(path: string): Promise<Holder | "unsafe" | undefined> {
 let entry: Stats;
 try { entry = await lstat(path); } catch (error) { if (codeIs(error, "ENOENT")) return undefined; throw error; }
 if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return "unsafe";
 let file: FileHandle;
 try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
 catch (error) { if (codeIs(error, "ENOENT")) return undefined; if (codeIs(error, "ELOOP")) return "unsafe"; throw error; }
 try {
  if (!sameFile(await file.stat(), entry)) return undefined;
  const bytes = Buffer.alloc(MAX_RECORD_BYTES); let length = 0;
  while (length < bytes.length) {
   const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
   if (!bytesRead) break;
   length += bytesRead;
  }
  let value: unknown;
  try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { value = undefined; }
  const owner = Value.Check(OwnerSchema, value) && value.hostname === hostname() ? value.pid : undefined;
  return { dev: entry.dev, ino: entry.ino, mtimeMs: entry.mtimeMs, pid: owner, text: ownerText(value) };
 } finally { await file.close(); }
}
// El archivo que se leyó. dev e ino no alcanzan: el inodo se reusa enseguida (ext4, tmpfs) y un turno nuevo creado por otro
// proceso puede tener el mismo; su mtime es posterior al que se leyó.
export const sameHolder = (current: Pick<Holder, "dev" | "ino" | "mtimeMs">, holder: Pick<Holder, "dev" | "ino" | "mtimeMs">): boolean =>
 current.dev === holder.dev && current.ino === holder.ino && current.mtimeMs === holder.mtimeMs;
// Retira sólo el archivo que se leyó: si otro ya lo reemplazó, no lo toca.
async function retire(path: string, holder: Holder): Promise<void> {
 try {
  const current = await lstat(path);
  if (sameHolder(current, holder) && !current.isSymbolicLink()) await unlink(path);
 } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
}
// Como releaseLock de store.ts, pero sin fallar: un turno que no se pudo borrar lo retira el próximo por su edad.
async function releaseTurn(path: string, turn: FileHandle): Promise<void> {
 try {
  const owner = await turn.stat(); const current = await lstat(path);
  if (sameFile(owner, current) && !current.isSymbolicLink()) await unlink(path);
 } catch { /* falla abierta */ }
 finally { await turn.close().catch(() => {}); }
}
async function create(path: string, record: string): Promise<FileHandle | "taken" | "unsafe"> {
 let turn: FileHandle;
 try { turn = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
 catch (error) { if (codeIs(error, "EEXIST")) return "taken"; if (codeIs(error, "ELOOP")) return "unsafe"; throw error; }
 try { await turn.writeFile(record); } catch (error) { await releaseTurn(path, turn); throw error; }
 return turn;
}

export async function takeCheckTurn(checkout: Workflow["checkout"], check: { kind: string; command: string }, signal: AbortSignal, policy = CHECK_TURN_POLICY, onWait?: (owner: string) => void): Promise<CheckTurn> {
 signal.throwIfAborted();
 const started = Date.now(); const waited = () => Date.now() - started;
 const untaken = (notice: string): CheckTurn => ({ waitedMs: waited(), notice, release: async () => {} });
 const alive = policy.alive ?? processAlive;
 let path = ""; let owner: string | undefined; let retired: string | undefined;
 try {
  path = checkTurnPath(checkout); await directories(dirname(path), true);
  const record = JSON.stringify({ pid: process.pid, hostname: hostname(), root: checkout.root, kind: check.kind, command: check.command.slice(0, 200) });
  for (;;) {
   signal.throwIfAborted();
   const turn = await create(path, record);
   if (turn === "unsafe") return untaken(NOTICES.unsafe(path));
   if (turn !== "taken") return { waitedMs: waited(), notice: retired ?? (owner ? NOTICES.waited(waited(), owner) : undefined), release: () => releaseTurn(path, turn) };
   const holder = await readHolder(path);
   if (holder === "unsafe") return untaken(NOTICES.unsafe(path));
   if (!holder) continue;
   const reason = holder.pid !== undefined && !alive(holder.pid) ? NOTICES.dead(holder.text)
    : Date.now() - holder.mtimeMs >= policy.limitMs ? NOTICES.stale(holder.text, policy.limitMs) : undefined;
   if (reason) { await retire(path, holder); retired = reason; continue; }
   if (waited() >= policy.limitMs) return untaken(NOTICES.limit(waited(), holder.text));
   owner = holder.text; onWait?.(owner);
   await sleep(policy.pollMs, undefined, { signal });
  }
 } catch (error) {
  if (signal.aborted) throw error;
  return untaken(NOTICES.failed(error));
 }
}
