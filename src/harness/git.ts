// Checkout identity and content evidence. Never writes an index or Git objects.
import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { processRunner, type Runner } from "../core/exec.ts";
import type { Evidence, Exploration, Workflow } from "./model.ts";

type Checkout = Workflow["checkout"];
export interface CheckoutSnapshot { root: string; branch: string; head: string; fingerprint: string; clean: boolean }
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--color=never"];

export async function gitRead(checkout: Checkout, args: string[], runner: Runner, signal?: AbortSignal): Promise<string> {
 signal?.throwIfAborted();
 const result = await runner.run("git", ["-c", "core.fsmonitor=false", "-C", checkout.root, ...args], {
  env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }, ...(signal ? { signal } : {}),
 });
 signal?.throwIfAborted();
 if (result.code !== 0) throw new Error(`No se pudo verificar Git (${args[0]}); no se considera limpio`);
 return result.stdout;
}
function paths(raw: string): string[] {
 if (!raw) return [];
 if (!raw.endsWith("\0")) throw new Error("Lista de paths de Git incompleta");
 const result = raw.slice(0, -1).split("\0");
 if (result.some(p => !p)) throw new Error("Path de Git inválido");
 return result;
}
function inside(root: string, target: string): boolean {
 const rel = relative(root, target); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
async function localPath(root: string, path: string): Promise<string> {
 const target = resolve(root, path);
 if (isAbsolute(path) || !inside(root, target) || target === root || path.split(/[\\/]/).includes("..")) throw new Error("Path fuera del checkout");
 let parent = dirname(target);
 while (true) {
  try { if (!inside(root, await realpath(parent))) throw new Error("Symlink fuera del checkout"); break; }
  catch (error) { if (!isMissing(error) || parent === root) throw error; parent = dirname(parent); }
 }
 return target;
}
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
async function hashPath(hash: Hash, root: string, path: string, signal?: AbortSignal): Promise<void> {
 signal?.throwIfAborted(); const target = await localPath(root, path); hash.update(JSON.stringify(path) + "\0");
 let entry;
 try { entry = await lstat(target); } catch (error) { if (!isMissing(error)) throw error; hash.update("deleted\0"); return; }
 if (entry.isSymbolicLink()) { hash.update("120000\0" + JSON.stringify(await readlink(target)) + "\0"); return; }
 if (!entry.isFile()) throw new Error("No se puede verificar un directorio, submódulo o archivo especial; requiere revisión humana");
 const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await file.stat(); if (!stat.isFile()) throw new Error("El archivo cambió durante la verificación");
  hash.update((stat.mode & 0o111 ? "100755" : "100644") + "\0" + stat.size + "\0");
  const buffer = Buffer.alloc(64 * 1024);
  while (true) { signal?.throwIfAborted(); const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
  const after = await file.stat();
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("El archivo cambió durante la verificación");
  hash.update("\0");
 } finally { await file.close(); }
}
export async function inspectCheckout(checkout: Checkout, runner: Runner = processRunner, signal?: AbortSignal): Promise<CheckoutSnapshot> {
 signal?.throwIfAborted();
 if (!sha.test(checkout.baseCommit) || ["main", "master", "HEAD"].includes(checkout.branch) || !checkout.branch || checkout.branch.startsWith("-")) throw new Error("Base o branch de trabajo inválido");
 const root = await realpath(checkout.root);
 const actualRoot = (await gitRead(checkout, ["rev-parse", "--show-toplevel"], runner, signal)).trim();
 const common = (await gitRead(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], runner, signal)).trim();
 if (await realpath(actualRoot) !== root || await realpath(common) !== await realpath(checkout.commonDir)) throw new Error("La identidad del checkout cambió");
 const ref = (await gitRead(checkout, ["symbolic-ref", "--quiet", "HEAD"], runner, signal)).trim();
 if (ref !== `refs/heads/${checkout.branch}`) throw new Error("El branch cambió o HEAD está separado");
 const head = (await gitRead(checkout, ["rev-parse", "--verify", "HEAD"], runner, signal)).trim();
 if (!sha.test(head)) throw new Error("HEAD inválido");
 await gitRead(checkout, ["merge-base", "--is-ancestor", checkout.baseCommit, head], runner, signal);
 const status = await gitRead(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], runner, signal);
 const changed = paths(await gitRead(checkout, ["diff", ...diffFlags, "--name-only", "-z", checkout.baseCommit, "--"], runner, signal));
 const untracked = paths(await gitRead(checkout, ["ls-files", "--others", "--exclude-standard", "-z"], runner, signal));
 const allPaths = [...new Set([...changed, ...untracked])].sort();
 const hash = createHash("sha256").update(checkout.baseCommit + "\0" + JSON.stringify(allPaths) + "\0");
 for (const path of allPaths) await hashPath(hash, root, path, signal);
 // Detect common concurrent checkout edits rather than attaching evidence to another HEAD.
 if ((await gitRead(checkout, ["rev-parse", "--verify", "HEAD"], runner, signal)).trim() !== head) throw new Error("HEAD cambió durante la verificación");
 return { root, branch: checkout.branch, head, fingerprint: hash.digest("hex"), clean: status === "" };
}
async function readLocal(root: string, path: string, cap: number, signal?: AbortSignal): Promise<string> {
 const target = await localPath(root, path);
 if (!inside(root, await realpath(target))) throw new Error("Referencia fuera del checkout");
 const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  if (!(await file.stat()).isFile()) throw new Error("Referencia no es un archivo regular");
  const buffer = Buffer.alloc(cap + 1); let count = 0;
  while (count < buffer.length) { signal?.throwIfAborted(); const { bytesRead } = await file.read(buffer, count, buffer.length - count, null); if (!bytesRead) break; count += bytesRead; }
  if (count > cap) throw new Error("Archivo demasiado grande; achicar o solicitar revisión humana");
  const bytes = buffer.subarray(0, count); if (bytes.includes(0)) throw new Error("Archivo binario: requiere revisión humana");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
 } finally { await file.close(); }
}
export async function validateReferences(checkout: Checkout, references: Exploration["references"], signal?: AbortSignal): Promise<void> {
 const root = await realpath(checkout.root);
 for (const reference of references) {
  signal?.throwIfAborted(); const body = await readLocal(root, reference.path, 1024 * 1024, signal);
  const lines = body ? body.split("\n").length - (body.endsWith("\n") ? 1 : 0) : 0;
  if (!Number.isSafeInteger(reference.line) || reference.line < 1 || reference.line > lines) throw new Error(`Línea inexistente en ${reference.path}`);
 }
}
export async function readWorkflowDiff(checkout: Checkout, runner: Runner = processRunner, signal?: AbortSignal): Promise<string> {
 await inspectCheckout(checkout, runner, signal);
 let diff = await gitRead(checkout, ["diff", ...diffFlags, checkout.baseCommit, "--"], runner, signal);
 const ensureLimit = () => { if (diff.length > 50000) throw new Error("Diff excede 50000 caracteres: achicar el cambio o solicitar revisión humana; no hay revisión completa"); };
 ensureLimit();
 const root = await realpath(checkout.root);
 for (const path of paths(await gitRead(checkout, ["ls-files", "--others", "--exclude-standard", "-z"], runner, signal)).sort()) {
  const target = await localPath(root, path); const entry = await lstat(target);
  const body = entry.isSymbolicLink() ? await readlink(target) : await readLocal(root, path, 200000, signal);
  diff += `\nArchivo nuevo ${JSON.stringify(path)}\n${body}\n`; ensureLimit();
 }
 return diff;
}
export async function assertStepCommit(checkout: Checkout, evidence: Evidence, commit: string, runner: Runner = processRunner, signal?: AbortSignal): Promise<void> {
 const snapshot = await inspectCheckout(checkout, runner, signal);
 if (!snapshot.clean || snapshot.head !== commit || commit === checkout.baseCommit || evidence.kind !== "green" || evidence.exitCode !== 0 || evidence.outcome !== "passed" || evidence.fingerprint !== snapshot.fingerprint) throw new Error("Commit sin evidencia verde vigente de un checkout limpio");
 if (evidence.head === commit) return;
 const parent = (await gitRead(checkout, ["rev-parse", "--verify", "HEAD^"], runner, signal)).trim();
 if (parent !== evidence.head) throw new Error("El commit no sigue inmediatamente al HEAD verificado");
 const parents = (await gitRead(checkout, ["rev-list", "--parents", "-n", "1", commit], runner, signal)).trim();
 if (parents !== `${commit} ${parent}`) throw new Error("El paso no admite commits de merge ni padres inesperados");
}
