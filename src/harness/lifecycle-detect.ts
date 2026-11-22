// Detector de onboarding: sólo lee archivos acotados del repo. No ejecuta scripts, no sigue symlinks ni
// copia valores (comandos, URLs o secretos): nombres y señales declarativas para proponer, nunca para autorizar.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectLink } from "../project/link.ts";
const MAX_BYTES = 256 * 1024, MAX_WORKFLOWS = 50, MAX_SCRIPTS = 100;
const MANIFESTS = ["Cargo.toml", "Dockerfile", "Makefile", "go.mod", "package.json", "pyproject.toml"];
export interface LifecycleDetection {
 workflows: { file: string; dispatch: boolean; release: boolean }[]; scripts: string[]; manifests: string[];
 omi: { organization: string; project: string; services: string[] } | "invalid" | null; skipped: string[];
}
const missing = (e: unknown) => e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR");
async function regular(path: string): Promise<boolean | null> {
 try { const entry = await lstat(path); return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= MAX_BYTES; } catch (e) { if (missing(e)) return null; throw e; }
}
async function readBounded(root: string, path: string, skipped: string[], signal: AbortSignal): Promise<string | null> {
 signal.throwIfAborted(); const ok = await regular(join(root, path)); if (ok === null) return null; if (!ok) { skipped.push(path); return null; }
 const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try { const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0); if (bytesRead > MAX_BYTES) { skipped.push(path); return null; } return bytes.subarray(0, bytesRead).toString("utf8"); } finally { await file.close(); }
}
async function workflows(root: string, skipped: string[], signal: AbortSignal): Promise<LifecycleDetection["workflows"]> {
 const dir = join(root, ".github/workflows");
 try { const entry = await lstat(dir); if (!entry.isDirectory() || entry.isSymbolicLink()) { skipped.push(".github/workflows"); return []; } } catch (e) { if (missing(e)) return []; throw e; }
 const names = (await readdir(dir)).filter(n => /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/.test(n)).sort().slice(0, MAX_WORKFLOWS), found: LifecycleDetection["workflows"] = [];
 for (const file of names) {
  const text = await readBounded(root, `.github/workflows/${file}`, skipped, signal); if (text === null) continue;
  found.push({ file, dispatch: /\bworkflow_dispatch\b/.test(text), release: /\btags\s*:|\brelease\b/i.test(text) });
 }
 return found;
}
async function scripts(root: string, skipped: string[], signal: AbortSignal): Promise<string[]> {
 const text = await readBounded(root, "package.json", skipped, signal); if (text === null) return [];
 try { const value: unknown = JSON.parse(text), list = value && typeof value === "object" && "scripts" in value ? value.scripts : undefined; return list && typeof list === "object" && !Array.isArray(list) ? Object.keys(list).filter(n => /^[\w:.-]{1,100}$/.test(n)).sort().slice(0, MAX_SCRIPTS) : []; }
 catch { skipped.push("package.json"); return []; }
}
async function omiLink(root: string, skipped: string[], signal: AbortSignal): Promise<LifecycleDetection["omi"]> {
 const text = await readBounded(root, ".omi/project.json", skipped, signal); if (text === null) return null;
 try { const link = parseProjectLink(text); return { organization: link.organizationSlug, project: link.projectSlug, services: link.services.map(s => s.name) }; } catch { return "invalid"; }
}
/** Lectura pura para correr en background al abrir la sesión: no escribe, no ejecuta ni abre modales. */
export async function detectLifecycle(root: string, signal: AbortSignal): Promise<LifecycleDetection> {
 const skipped: string[] = [], manifests: string[] = [];
 for (const name of MANIFESTS) { signal.throwIfAborted(); if (await regular(join(root, name)) !== null) manifests.push(name); }
 return { workflows: await workflows(root, skipped, signal), scripts: await scripts(root, skipped, signal), manifests, omi: await omiLink(root, skipped, signal), skipped };
}
