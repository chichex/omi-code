// Ejecuta procesos externos (git, docker, regctl). Es una frontera: los tests la reemplazan.
import { spawn } from "node:child_process";
import { childEnvironment } from "./process-environment.ts";
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions {
 cwd?: string;
 /** Se escribe por stdin: es el único canal para una credencial. */
 input?: string; env?: Record<string, string>; signal?: AbortSignal;
 /** Límite conjunto stdout/stderr: excederlo corta el hijo y rechaza, no devuelve salida parcial. */
 maxOutputBytes?: number;
}
export interface Runner { run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> }
export const processRunner: Runner = {
 run: (command, args, options = {}) => new Promise((resolve, reject) => {
  const limit = options.maxOutputBytes ?? Infinity;
  if (!(limit > 0) || (limit !== Infinity && !Number.isSafeInteger(limit))) { reject(new Error("límite de salida inválido")); return; }
  if (options.signal?.aborted) { reject(options.signal.reason); return; }
  const grouped = process.platform !== "win32" && (options.signal !== undefined || options.maxOutputBytes !== undefined);
  const child = spawn(command, args, { ...(grouped ? { detached: true } : {}), ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: childEnvironment({ ...process.env, ...options.env }), stdio: ["pipe", "pipe", "pipe"] });
  // Seguir drenando hasta close: no borrar temporales mientras el hijo cancelado sigue usándolos.
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let total = 0, failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
   if (grouped && child.pid) { try { process.kill(-child.pid, signal); return; } catch {} }
   child.kill(signal);
  };
  const abort = () => {
   failure ??= Object.assign(new Error("Comando cancelado"), { name: "AbortError", code: "ABORT_ERR" });
   stop("SIGTERM"); escalation ??= setTimeout(() => stop("SIGKILL"), 250);
  };
  const cleanup = () => { if (escalation) clearTimeout(escalation); options.signal?.removeEventListener("abort", abort); };
  const collect = (target: Buffer[], chunk: Buffer) => {
   if (failure) return;
   total += chunk.length;
   if (total > limit) { failure = new Error("output excede el límite de salida del comando"); stop("SIGKILL"); return; }
   target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk)); child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.on("error", error => { cleanup(); reject(error); });
  child.on("close", code => { cleanup(); if (failure) reject(failure); else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  child.stdin.on("error", () => {}); child.stdin.end(options.input);
 }),
};
