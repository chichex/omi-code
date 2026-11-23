// Detector de onboarding: sólo lee archivos acotados del repo. No ejecuta scripts, no sigue symlinks ni
// copia valores (comandos, URLs o secretos): nombres y señales declarativas para proponer, nunca para autorizar.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectLink } from "../project/link.ts";
import { REVIEW_ARTIFACT_FILE, REVIEW_CONTRACT, REVIEW_RUN_PREFIX } from "./gha-review-contract.ts";
import { dispatchInputValues } from "./lifecycle-detect-inputs.ts";
import { GhaReviewEffortSchema, GhaReviewModelSchema, type GhaReviewEffort, type GhaReviewModel } from "./lifecycle-schema.ts";
const MAX_BYTES = 256 * 1024, MAX_WORKFLOWS = 50, MAX_SCRIPTS = 100;
const MANIFESTS = ["Cargo.toml", "Dockerfile", "Makefile", "go.mod", "package.json", "pyproject.toml"];
/** Valores de `model` y `effort` que el workflow_dispatch acepta: vacío si no declara el input. Fijar otro hace fallar el dispatch. */
export interface ReviewTuning { model: GhaReviewModel[]; effort: GhaReviewEffort[] }
type DetectedWorkflow = { file: string; dispatch: boolean; release: boolean } & ({ contract: null } | { contract: typeof REVIEW_CONTRACT; tuning: ReviewTuning });
export interface LifecycleDetection {
 /** `contract`: el workflow declara los marcadores de omi-review-v1. Es una propuesta: el runtime valida run y artefacto. */
 workflows: DetectedWorkflow[]; scripts: string[]; manifests: string[];
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
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expression = (name: string) => `\\$\\{\\{\\s*${literal(name)}\\s*\\}\\}`;
// Lo que el host exige: inputs fuertes, run-name correlacionado y artefacto `review.json` por run y attempt.
const REVIEW_ARTIFACT = new RegExp(`${literal(REVIEW_CONTRACT)}-${expression("inputs.correlation_id")}-${expression("github.run_id")}-${expression("github.run_attempt")}`);
function reviewContract(text: string): typeof REVIEW_CONTRACT | null {
 const input = (name: string) => new RegExp(`^[ \\t]+${name}[ \\t]*:`, "m").test(text);
 const runName = /^run-name[ \t]*:(.*)$/m.exec(text)?.[1] ?? "";
 const correlated = runName.includes(REVIEW_RUN_PREFIX) && /\binputs\.pr\b/.test(runName) && /\binputs\.correlation_id\b/.test(runName);
 const ok = /\bworkflow_dispatch\b/.test(text) && input("expected_head_sha") && input("correlation_id") && correlated && REVIEW_ARTIFACT.test(text) && text.includes(REVIEW_ARTIFACT_FILE);
 return ok ? REVIEW_CONTRACT : null;
}
async function workflows(root: string, skipped: string[], signal: AbortSignal): Promise<LifecycleDetection["workflows"]> {
 const dir = join(root, ".github/workflows");
 try { const entry = await lstat(dir); if (!entry.isDirectory() || entry.isSymbolicLink()) { skipped.push(".github/workflows"); return []; } } catch (e) { if (missing(e)) return []; throw e; }
 const names = (await readdir(dir)).filter(n => /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/.test(n)).sort().slice(0, MAX_WORKFLOWS), found: LifecycleDetection["workflows"] = [];
 for (const file of names) {
  const text = await readBounded(root, `.github/workflows/${file}`, skipped, signal); if (text === null) continue;
  const base = { file, dispatch: /\bworkflow_dispatch\b/.test(text), release: /\btags\s*:|\brelease\b/i.test(text) };
  found.push(reviewContract(text) ? { ...base, contract: REVIEW_CONTRACT, tuning: { model: dispatchInputValues(text, "model", GhaReviewModelSchema.enum), effort: dispatchInputValues(text, "effort", GhaReviewEffortSchema.enum) } } : { ...base, contract: null });
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
