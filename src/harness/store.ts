import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseWorkflow, type Workflow } from "./model.ts";

const MAX_BYTES = 8 * 1024 * 1024;
export class WorkflowConflictError extends Error {
 constructor(message = "El workflow cambió o está bloqueado por otro proceso") { super(message); this.name = "WorkflowConflictError"; }
}
function codeIs(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Harness store: ${message}`); }
export function workflowPath(checkout: Workflow["checkout"], issueNumber: number): string {
 requireCondition(Number.isSafeInteger(issueNumber) && issueNumber > 0, "número de issue inválido");
 for (const path of [checkout.root, checkout.commonDir]) requireCondition(isAbsolute(path) && resolve(path) === path && !path.includes("\0"), "checkout debe tener rutas absolutas normalizadas");
 return join(checkout.commonDir, "omi", "development", `${issueNumber}.json`);
}
// No se siguen symlinks, ni en el archivo ni en sus directorios. Un lock abandonado
// requiere intervención explícita: jamás se roba por su edad o por un PID remoto.
async function directories(path: string, create: boolean): Promise<void> {
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
export async function readWorkflow(checkout: Workflow["checkout"], issueNumber: number): Promise<Workflow | undefined> {
 const path = workflowPath(checkout, issueNumber);
 let file: FileHandle | undefined;
 try {
  await directories(dirname(path), false);
  await checkFile(path);
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const entry = await file.stat();
  requireCondition(entry.isFile() && entry.nlink === 1 && entry.size <= MAX_BYTES, "archivo inválido o demasiado grande");
  // Lectura acotada incluso si otro proceso hace crecer el archivo después de stat.
  const bytes = Buffer.alloc(MAX_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
   const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
   if (!bytesRead) break;
   length += bytesRead;
  }
  requireCondition(length <= MAX_BYTES, "estado demasiado grande");
  const state = parseWorkflow(bytes.subarray(0, length).toString("utf8"));
  validateIdentity(state, checkout, issueNumber);
  return state;
 } catch (error) { if (codeIs(error, "ENOENT")) return undefined; throw error; }
 finally { await file?.close(); }
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
 catch (error) { if (codeIs(error, "EEXIST") || codeIs(error, "ELOOP")) throw new WorkflowConflictError(); throw error; }
 let temp: string | undefined;
 try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
  await lock.sync();
  const current = await readWorkflow(checkout, issueNumber);
  if (expectedRevision === undefined ? current !== undefined : current === undefined || current.revision !== expectedRevision) throw new WorkflowConflictError();
  const next = parseWorkflow(JSON.stringify(change(current)));
  validateIdentity(next, checkout, issueNumber);
  requireCondition(next.revision === (expectedRevision === undefined ? 0 : expectedRevision + 1), "la revisión debe avanzar exactamente una vez");
  if (current) requireCondition(next.id === current.id, "no se puede reemplazar la identidad del workflow");
  const serialized = JSON.stringify(next, null, 2) + "\n";
  requireCondition(Buffer.byteLength(serialized) <= MAX_BYTES, "estado demasiado grande");
  temp = join(directory, `.${issueNumber}.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  await directories(directory, false);
  await checkFile(path);
  await rename(temp, path);
  temp = undefined;
  const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return next;
 } finally {
  try { if (temp) await unlink(temp); } finally { await releaseLock(lockPath, lock); }
 }
}
