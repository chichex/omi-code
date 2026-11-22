// Transporte GitHub GET-only acotado, sin shell ni salida remota cruda en errores.
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import type { Runner, CommandResult } from "../core/exec.ts";
import { childEnvironment } from "../core/process-environment.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
export const MAX_GITHUB_READ_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTION_BYTES = 8 * 1024 * 1024;
export class GitHubReadError extends Error {
 readonly status: number | null; readonly transient: boolean;
 constructor(message = "GitHub incompleto/no disponible; no acredita avance", status: number | null = null, transient = false) { super(message); this.name = "GitHubReadError"; this.status = status; this.transient = transient; }
}
interface ReadResult extends CommandResult { truncated?: boolean; transient?: boolean }
export const boundedGitHubRunner: Runner = { run(command, args, options = {}) {
 return new Promise<ReadResult>(done => {
  execFile(command, args, { cwd: options.cwd, signal: options.signal, timeout: 15000, killSignal: "SIGKILL", maxBuffer: MAX_GITHUB_READ_BYTES, windowsHide: true,
   env: childEnvironment({ ...process.env, ...options.env }) }, (error, stdout, stderr) => {
    const code = error && "code" in error ? error.code : undefined;
    done({ code: error ? 1 : 0, stdout, stderr,
     ...(code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? { truncated: true } : {}),
     ...(error && /timeout|ECONNRESET|EAI_AGAIN/.test(String(code)) ? { transient: true } : {}) });
   });
 });
} };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
interface Packet { body: unknown; next: string | null }
export interface GitHubReadOptions { repo: string; cwd: string; runner?: Runner; delay?: (milliseconds: number, signal: AbortSignal) => Promise<void> }
export class GitHubReadClient {
 readonly repo: string;
 private readonly options: GitHubReadOptions;
 constructor(options: GitHubReadOptions) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(options.repo) || options.repo.length > 200 || options.repo.split("/").some(part => part === "." || part === "..") || !isAbsolute(options.cwd)) throw new GitHubReadError("Identidad/checkout GitHub inválidos");
  this.repo = options.repo; this.options = options;
 }
 private allowed(endpoint: string): void {
  const prefix = `repos/${this.repo}`; const path = endpoint.split("?")[0]!;
  const tail = path.slice(prefix.length);
  const allowed = path === prefix || path.startsWith(prefix + "/") && (/^\/pulls\/[1-9]\d*(?:\/(?:reviews|comments))?$/.test(tail)
   || /^\/issues\/[1-9]\d*\/comments$/.test(tail)
   || /^\/commits\/[a-f0-9]{40}(?:[a-f0-9]{24})?\/(?:statuses|check-runs)$/.test(tail)
   || /^\/(?:branches|rules\/branches)\/[^/?#]+(?:\/protection)?$/.test(tail)
   || /^\/actions\/workflows\/(?:[1-9]\d*|[A-Za-z0-9_.-]+\.ya?ml)(?:\/runs)?$/.test(tail)
   || /^\/actions\/runs\/[1-9]\d*(?:\/artifacts)?$/.test(tail)
   || /^\/git\/ref\/(?:heads|tags)\/[^/?#]+$/.test(tail) || /^\/git\/tags\/[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tail));
  const url = new URL(endpoint, "https://api.github.com/");
  const queryAllowed = (key: string, value: string): boolean => ["page", "per_page"].includes(key) ? /^[1-9]\d*$/.test(value)
   : tail.startsWith("/actions/") && (key === "event" && ["workflow_dispatch", "push", "release", "workflow_run"].includes(value)
    || key === "branch" && lifecycleRef(value) || key === "created" && value.startsWith(">=") && Number.isFinite(Date.parse(value.slice(2))));
  if (!allowed || endpoint.length > 4096 || url.hostname !== "api.github.com" || url.hash || [...url.searchParams].some(([key, value]) => !queryAllowed(key, value))) throw new GitHubReadError("Endpoint fuera del contrato de lectura GitHub");
  const branch = /^\/(?:branches|rules\/branches)\/([^/?#]+)(?:\/protection)?$/.exec(tail)?.[1];
  if (branch && !lifecycleRef(decodeURIComponent(branch))) throw new GitHubReadError("Branch GitHub inválida");
  const ref = /^\/git\/ref\/(?:heads|tags)\/([^/?#]+)$/.exec(tail)?.[1];
  if (ref && !lifecycleRef(decodeURIComponent(ref))) throw new GitHubReadError("Ref GitHub inválida");
 }
 private async packet(endpoint: string, signal: AbortSignal): Promise<Packet> {
  this.allowed(endpoint);
  for (let attempt = 0; ; attempt++) {
   signal.throwIfAborted();
   try {
    const result: ReadResult = await (this.options.runner ?? boundedGitHubRunner).run("gh", ["api", "--hostname", "github.com", "--method", "GET", "--include", endpoint], {
     cwd: this.options.cwd, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
     env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    signal.throwIfAborted();
    if (result.truncated || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_GITHUB_READ_BYTES) throw new GitHubReadError("Respuesta GitHub truncada/demasiado grande");
    const separator = /\r?\n\r?\n/.exec(result.stdout);
    if (!separator) throw new GitHubReadError(undefined, null, result.transient === true || /timeout|connection reset|temporary failure/i.test(result.stderr));
    const headers = result.stdout.slice(0, separator.index); const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s[^\r\n]*)?/i.exec(headers)?.[1];
    if (!status) throw new GitHubReadError("Headers GitHub incompletos");
    const code = Number(status);
    if (code !== 200 || result.code !== 0) throw new GitHubReadError(undefined, code, code === 429 || code >= 500 && code <= 599);
    if (!/^content-type:\s*(?:application\/json|application\/vnd\.github\+json)(?:;|\s*$)/im.test(headers)) throw new GitHubReadError("GitHub no devolvió JSON");
    let body: unknown;
    try { body = JSON.parse(result.stdout.slice(separator.index + separator[0].length)); }
    catch { throw new GitHubReadError("JSON GitHub incompleto"); }
    const links = headers.split(/\r?\n/).filter(line => /^link:/i.test(line)).map(line => line.slice(line.indexOf(":") + 1).trim()).join(",");
    let next: string | null = null;
    for (const part of links ? links.split(/\s*,\s*/) : []) {
     const link = /^<([^<>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/i.exec(part);
     if (!link) throw new GitHubReadError("Paginación GitHub ambigua/malformada");
     if (link[2]?.toLowerCase() === "next") { if (next) throw new GitHubReadError("Paginación GitHub duplicada"); next = link[1] ?? null; }
    }
    return { body, next };
   } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof GitHubReadError) || !error.transient || attempt >= 2) throw error instanceof GitHubReadError ? error : new GitHubReadError();
    await (this.options.delay ?? ((ms, abort) => sleep(ms, undefined, { signal: abort })))(100 * 2 ** attempt, signal);
   }
  }
 }
 async json(endpoint: string, signal: AbortSignal): Promise<unknown> {
  const packet = await this.packet(endpoint, signal);
  if (packet.next) throw new GitHubReadError("Se esperaba un objeto sin paginación"); return packet.body;
 }
 async collection<S extends TSchema>(endpoint: string, schema: S, signal: AbortSignal, field?: string): Promise<Static<S>[]> {
  const items: Static<S>[] = []; const ids = new Set<string>(); let bytes = 0; let expectedTotal: number | undefined;
  for (let page = 1; page <= 10; page++) {
   const requested = new URL(endpoint, "https://api.github.com/"); requested.searchParams.set("per_page", "100"); requested.searchParams.set("page", String(page));
   const packet = await this.packet(requested.pathname.slice(1) + requested.search, signal); let raw: unknown = packet.body;
   if (field) {
    if (!record(raw) || !Number.isSafeInteger(raw.total_count) || Number(raw.total_count) < 0) throw new GitHubReadError("Colección GitHub sin total verificable");
    if (expectedTotal !== undefined && expectedTotal !== raw.total_count) throw new GitHubReadError("La colección cambió durante la paginación");
    expectedTotal = Number(raw.total_count); raw = raw[field];
   }
   if (!Array.isArray(raw) || raw.length > 100 || raw.some(item => !Value.Check(schema, item))) throw new GitHubReadError("Colección GitHub inválida/incompleta");
   bytes += Buffer.byteLength(JSON.stringify(raw));
   if (items.length + raw.length > 1000 || bytes > MAX_COLLECTION_BYTES || (expectedTotal ?? 0) > 1000) throw new GitHubReadError("Colección GitHub supera el tope; no se recorta para aprobar");
   for (const item of raw) {
    if (!Value.Check(schema, item)) throw new GitHubReadError();
    if (record(item) && (typeof item.id === "number" || typeof item.id === "string")) { const id = String(item.id); if (ids.has(id)) throw new GitHubReadError("IDs GitHub duplicados durante paginación"); ids.add(id); }
    items.push(item);
   }
   if (!packet.next) {
    if (expectedTotal !== undefined && items.length !== expectedTotal) throw new GitHubReadError("Colección GitHub truncada"); return items;
   }
   const next = new URL(packet.next); const nextPage = next.searchParams.get("page");
   if (!raw.length || page === 10 || next.protocol !== "https:" || next.hostname !== "api.github.com" || next.username || next.password || next.hash || next.pathname !== requested.pathname || [...new URL(endpoint, "https://api.github.com/").searchParams].some(([key, value]) => next.searchParams.get(key) !== value) || nextPage !== String(page + 1) || next.searchParams.get("per_page") !== "100") throw new GitHubReadError("Paginación GitHub incompleta o fuera de identidad");
  }
  throw new GitHubReadError("Colección GitHub incompleta");
 }
}
