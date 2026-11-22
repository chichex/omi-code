// Aceptación/pin lifecycle y postergación por KB/producto/repo. Privado, durable y separado de Foundations.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentDir } from "../core/paths.ts";
import { checkLifecycleConfig, lifecycleHash, LifecycleConfigSchema, type LifecycleConfig } from "./lifecycle-config.ts";

export interface LifecycleKey { kbUrl: string; product: string; repo: string }
export interface LifecycleAcceptance { docId: string; blockHash: string; block: LifecycleConfig; author: string; date: string; acceptedAt: string }
export interface LifecycleTrust extends LifecycleKey { version: 1; revision: number; accepted: LifecycleAcceptance | null; deferred: { revision: string; at: string } | null }
export type LifecycleTrustReading = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "valid"; record: LifecycleTrust };
const MAX_BYTES = 8 * 1024 * 1024;
const closed = { additionalProperties: false } as const;
const text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
const RecordSchema = Type.Object({
 version: Type.Literal(1), revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), kbUrl: text(2000), product: text(), repo: text(),
 accepted: Type.Union([Type.Null(), Type.Object({ docId: text(), blockHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), block: LifecycleConfigSchema,
  author: Type.String({ maxLength: 400 }), date: Type.String({ maxLength: 100 }), acceptedAt: text(100) }, closed)]),
 deferred: Type.Union([Type.Null(), Type.Object({ revision: text(256), at: text(100) }, closed)]),
}, closed);
const codeIs = (e: unknown, code: string) => e instanceof Error && "code" in e && e.code === code;
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Lifecycle trust: ${message}`); }
export function lifecycleKeyValid(key: LifecycleKey): boolean {
 try {
  const url = new URL(key.kbUrl);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
   && /^[a-z0-9-]{1,200}$/.test(key.product) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key.repo) && key.repo.length <= 200;
 } catch { return false; }
}
export const lifecycleTrustDir = (home: string): string => join(agentDir(home), "development-lifecycle");
export function lifecycleTrustPath(dir: string, key: LifecycleKey): string {
 requireCondition(isAbsolute(dir) && resolve(dir) === dir && lifecycleKeyValid(key), "ruta o identidad inválida");
 return join(dir, `${createHash("sha256").update(JSON.stringify([key.kbUrl, key.product, key.repo])).digest("hex")}.json`);
}
function validateRecord(value: unknown, key: LifecycleKey): LifecycleTrust {
 requireCondition(Value.Check(RecordSchema, value), "registro inválido o futuro; no se reemplaza");
 requireCondition(value.kbUrl === key.kbUrl && value.product === key.product && value.repo === key.repo, "identidad distinta");
 if (value.accepted) {
  const checked = checkLifecycleConfig(value.accepted.block);
  requireCondition("block" in checked && checked.block.repo === key.repo && lifecycleHash(checked.block) === value.accepted.blockHash, "aceptación/hash inválidos");
 }
 return structuredClone(value);
}
async function directories(dir: string, create: boolean): Promise<void> {
 let current = parse(dir).root;
 for (const part of dir.slice(current.length).split("/").filter(Boolean)) {
  current = join(current, part);
  if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (!codeIs(e, "EEXIST")) throw e; } }
  const entry = await lstat(current);
  requireCondition(entry.isDirectory() && !entry.isSymbolicLink(), "directorio inseguro");
 }
 if (create) await chmod(dir, 0o700);
}
async function checkFile(path: string): Promise<void> {
 try {
  const entry = await lstat(path);
  requireCondition(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= MAX_BYTES, "archivo inseguro o demasiado grande");
 } catch (e) { if (!codeIs(e, "ENOENT")) throw e; }
}
/** Lectura pura. Corrupción/inseguridad no se interpreta como ausencia ni se repara. */
export async function readLifecycleTrust(dir: string, key: LifecycleKey): Promise<LifecycleTrustReading> {
 let file: FileHandle | undefined;
 try {
  const path = lifecycleTrustPath(dir, key); await directories(dir, false); await checkFile(path);
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const entry = await file.stat();
  requireCondition(entry.isFile() && entry.nlink === 1 && entry.size <= MAX_BYTES, "archivo inseguro o demasiado grande");
  const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
  while (length < bytes.length) { const { bytesRead } = await file.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead; }
  requireCondition(length <= MAX_BYTES, "archivo demasiado grande");
  const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
  return { kind: "valid", record: validateRecord(value, key) };
 } catch (e) { return codeIs(e, "ENOENT") ? { kind: "missing" } : { kind: "invalid", reason: "No se pudo validar el registro lifecycle; requiere recuperación humana" }; }
 finally { await file?.close(); }
}
async function releaseLock(path: string, lock: FileHandle): Promise<void> {
 try {
  const owner = await lock.stat(); const current = await lstat(path);
  if (!current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino) await unlink(path);
 } catch (e) { if (!codeIs(e, "ENOENT")) throw e; }
 finally { await lock.close(); }
}
/** Sólo desde decisión host explícita; CAS evita pisar aceptaciones/postergaciones concurrentes. */
export async function writeLifecycleTrust(dir: string, key: LifecycleKey, expectedRevision: number | undefined, next: LifecycleTrust): Promise<void> {
 const path = lifecycleTrustPath(dir, key); const checked = validateRecord(next, key);
 requireCondition(expectedRevision === undefined || Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "revisión inválida");
 requireCondition(checked.revision === (expectedRevision === undefined ? 0 : expectedRevision + 1), "la revisión debe avanzar exactamente una vez");
 const serialized = JSON.stringify(checked, null, 2) + "\n";
 requireCondition(Buffer.byteLength(serialized) <= MAX_BYTES, "registro demasiado grande");
 await directories(dir, true);
 const lockPath = `${path}.lock`; let lock: FileHandle;
 try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
 catch (e) { if (codeIs(e, "EEXIST") || codeIs(e, "ELOOP")) throw new Error(`Lifecycle bloqueado: revisar PID/host en ${lockPath}; no se roba el lock`); throw e; }
 let temp: string | undefined;
 try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() })); await lock.sync();
  const saved = await readLifecycleTrust(dir, key);
  requireCondition(saved.kind !== "invalid", "registro inválido; no se reemplaza");
  requireCondition(expectedRevision === undefined ? saved.kind === "missing" : saved.kind === "valid" && saved.record.revision === expectedRevision, "la aceptación cambió durante la decisión");
  temp = join(dir, `.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  await directories(dir, false); await checkFile(path); await rename(temp, path); temp = undefined;
  const parent = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
 } finally { try { if (temp) await unlink(temp); } finally { await releaseLock(lockPath, lock); } }
}
