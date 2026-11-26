import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateWorkflow, parseWorkflow, type Workflow, type WorkflowV2 } from "./model.ts";
import { assertLifecycleContinuity, lifecycleReceiptReserveBytes } from "./lifecycle-invariants.ts";
import { preserveCorrectionWorkflow } from "./correction-invariants.ts";

const MAX_BYTES = 8 * 1024 * 1024;
export class WorkflowConflictError extends Error {
 constructor(message = "El workflow cambió o está bloqueado por otro proceso") { super(message); this.name = "WorkflowConflictError"; }
}
export function codeIs(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Harness store: ${message}`); }
export function workflowPath(checkout: Workflow["checkout"], issueNumber: number): string {
 requireCondition(Number.isSafeInteger(issueNumber) && issueNumber > 0, "número de issue inválido");
 for (const path of [checkout.root, checkout.commonDir]) requireCondition(isAbsolute(path) && resolve(path) === path && !path.includes("\0"), "checkout debe tener rutas absolutas normalizadas");
 return join(checkout.commonDir, "omi", "development", `${issueNumber}.json`);
}
// No se siguen symlinks, ni en el archivo ni en sus directorios. Un lock abandonado
// requiere intervención explícita: jamás se roba por su edad o por un PID remoto.
export async function directories(path: string, create: boolean): Promise<void> {
 const root = parse(path).root;
 let current = root;
 for (const component of path.slice(root.length).split("/").filter(Boolean)) {
  current = join(current, component);
  if (create) {
   try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!codeIs(error, "EEXIST")) throw error; }
  }
  const entry = await lstat(current);
  requireCondition(entry.isDirectory() && !entry.isSymbolicLink(), `directorio inseguro: ${current}`);
 }
}
async function checkFile(path: string): Promise<void> {
 try {
  const entry = await lstat(path);
  requireCondition(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, "archivo inseguro");
  requireCondition(entry.size <= MAX_BYTES, "estado demasiado grande");
 } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
}
function validateIdentity(state: Workflow, checkout: Workflow["checkout"], issueNumber: number): void {
 requireCondition(state.source.number === issueNumber, "el estado pertenece a otro issue");
 for (const key of ["root", "commonDir", "branch", "baseCommit"] as const) requireCondition(state.checkout[key] === checkout[key], `checkout distinto: ${key}`);
}
async function readBytes(path: string): Promise<Buffer | undefined> {
 let file: FileHandle | undefined;
 try {
  await checkFile(path);
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const entry = await file.stat();
  requireCondition(entry.isFile() && entry.nlink === 1 && entry.size <= MAX_BYTES, "archivo inválido o demasiado grande");
  // Acotada incluso si otro proceso hace crecer el archivo después de stat.
  const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
  while (length < bytes.length) {
   const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
   if (!bytesRead) break;
   length += bytesRead;
  }
  requireCondition(length <= MAX_BYTES, "estado demasiado grande");
  return bytes.subarray(0, length);
 } catch (error) { if (codeIs(error, "ENOENT")) return undefined; throw error; }
 finally { await file?.close(); }
}
interface StoredWorkflow { state: WorkflowV2; raw: Buffer; legacy: boolean }
async function readStoredWorkflow(checkout: Workflow["checkout"], issueNumber: number): Promise<StoredWorkflow | undefined> {
 const path = workflowPath(checkout, issueNumber);
 try {
  await directories(dirname(path), false);
  const raw = await readBytes(path); if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("Estado del harness inválido: no es JSON UTF-8 válido"); }
  const state = migrateWorkflow(value);
  validateIdentity(state, checkout, issueNumber);
  const legacy = !!value && typeof value === "object" && "version" in value && value.version === 1;
  return { state, raw, legacy };
 } catch (error) { if (codeIs(error, "ENOENT")) return undefined; throw error; }
}
/** Migra sólo en memoria; leer/restaurar nunca escribe backup ni estado. */
export async function readWorkflow(checkout: Workflow["checkout"], issueNumber: number): Promise<WorkflowV2 | undefined> {
 return (await readStoredWorkflow(checkout, issueNumber))?.state;
}
async function syncDirectory(path: string): Promise<void> {
 const parent = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { await parent.sync(); } finally { await parent.close(); }
}
// Bajo el mismo lock y antes del rename v2. No reemplaza un backup parcial/ajeno ni sigue enlaces.
async function backupLegacy(path: string, raw: Buffer): Promise<void> {
 const backup = `${path}.v1.bak`; const existing = await readBytes(backup);
 if (existing) {
  requireCondition(existing.equals(raw) && ((await lstat(backup)).mode & 0o777) === 0o600, "backup v1 distinto o inseguro; recuperar a mano");
 } else {
  const file = await open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
 }
 await syncDirectory(dirname(path));
}
async function releaseLock(path: string, lock: FileHandle): Promise<void> {
 try {
  const owner = await lock.stat();
  const current = await lstat(path);
  if (owner.dev === current.dev && owner.ino === current.ino && !current.isSymbolicLink()) await unlink(path);
 } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
 finally { await lock.close(); }
}
export async function updateWorkflow(checkout: Workflow["checkout"], issueNumber: number, expectedRevision: number | undefined,
 change: (current: Workflow | undefined) => Workflow): Promise<Workflow> {
 const path = workflowPath(checkout, issueNumber);
 requireCondition(expectedRevision === undefined || Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "revisión inválida");
 const directory = dirname(path);
 await directories(directory, true);
 const lockPath = `${path}.lock`;
 let lock: FileHandle;
 try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
 catch (error) {
  if (codeIs(error, "EEXIST") || codeIs(error, "ELOOP")) throw new WorkflowConflictError(`El trabajo está bloqueado por otro proceso. Si no hay otro OMI activo, verificá el PID/host guardado en ${lockPath} y retiralo a mano.`);
  throw error;
 }
 let temp: string | undefined;
 try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
  await lock.sync();
  const stored = await readStoredWorkflow(checkout, issueNumber); const current = stored?.state;
  if (expectedRevision === undefined ? current !== undefined : current === undefined || current.revision !== expectedRevision) throw new WorkflowConflictError();
  // El callback recibe una copia: incluso si muta in-place, la preimagen conserva identidad y consumo.
  const candidate = change(current === undefined ? undefined : structuredClone(current));
  requireCondition(!stored || stored.legacy || candidate.version === 2, "no se admite downgrade de v2");
  const next = parseWorkflow(JSON.stringify(candidate));
  validateIdentity(next, checkout, issueNumber);
  requireCondition(next.revision === (expectedRevision === undefined ? 0 : expectedRevision + 1), "la revisión debe avanzar exactamente una vez");
  if (current) {
   requireCondition(next.id === current.id, "no se puede reemplazar la identidad del workflow");
   assertLifecycleContinuity(current.lifecycle, next.lifecycle);
   preserveCorrectionWorkflow(current, next);
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  requireCondition(Buffer.byteLength(serialized) <= MAX_BYTES, "estado demasiado grande");
  requireCondition(Buffer.byteLength(serialized) <= MAX_BYTES - lifecycleReceiptReserveBytes(next.lifecycle), "falta espacio comprometido para recibos pendientes/actividad");
  if (stored?.legacy) await backupLegacy(path, stored.raw);
  temp = join(directory, `.${issueNumber}.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  await directories(directory, false);
  await checkFile(path);
  await rename(temp, path);
  temp = undefined;
  await syncDirectory(directory);
  return next;
 } finally {
  try { if (temp) await unlink(temp); } finally { await releaseLock(lockPath, lock); }
 }
}
