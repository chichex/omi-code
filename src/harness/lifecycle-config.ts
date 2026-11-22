// Perillas lifecycle: validación, defaults, identidad canónica y composición. Ningún I/O ni permiso.
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { fences, type Fence } from "./fences.ts";
import { LifecycleConfigSchema, LifecycleTargetSchema, type LifecycleConfig, type LifecycleTarget } from "./lifecycle-schema.ts";

export { LifecycleConfigSchema, LifecycleTargetSchema } from "./lifecycle-schema.ts";
export type { LifecycleConfig, LifecycleTarget } from "./lifecycle-schema.ts";
export const LIFECYCLE_INFO = "omi-development-lifecycle";
type Problem = { reason: string };
export type ParsedLifecycle =
 | { status: "valid"; block: LifecycleConfig; hash: string; span: [number, number] }
 | { status: "missing" }
 | { status: "invalid"; reason: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
function safeStrings(value: unknown): boolean {
 if (typeof value === "string") return value.trim() === value && !hidden.test(value);
 if (Array.isArray(value)) return value.every(safeStrings);
 return !record(value) || Object.values(value).every(safeStrings);
}
/** Subconjunto de refs Git, nunca opciones, refspecs, expresiones ni nombres ambiguos. */
export function lifecycleRef(value: string): boolean {
 return /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && !value.includes("..") && !value.includes("//")
  && !value.endsWith(".") && !value.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".lock"));
}
function workflowIdentity(value: { workflow: string; ref: string }): boolean {
 const name = value.workflow.replace(/^\.github\/workflows\//, "");
 return !name.includes("..") && lifecycleRef(value.ref);
}
function endpoint(path: string): boolean { return !path.split("/").some(part => part === "." || part === ".."); }
function jsonField(field: string): boolean { return !field.split(".").some(part => ["__proto__", "constructor", "prototype"].includes(part)); }
function assetName(value: string): boolean { return !/[\\/]/.test(value) && value !== "." && value !== ".."; }
function targetProblem(target: LifecycleTarget): string | undefined {
 const { provider, evidence } = target;
 if (provider.kind === "gha" && (!workflowIdentity(provider) || provider.rollback && !workflowIdentity(provider.rollback))) return "workflow/ref de destino o rollback inválido";
 if (evidence.kind === "github-release" && (!evidence.assets.every(assetName) || !assetName(evidence.checksumsAsset) || evidence.tag !== undefined && !lifecycleRef(evidence.tag))) return "release debe declarar tag válido y assets/checksums por nombre, sin rutas";
 if (evidence.health && !endpoint(evidence.health.path)) return "health requiere un path relativo al destino, sin navegación";
 if (evidence.version && (!endpoint(evidence.version.path) || !jsonField(evidence.version.versionField) || evidence.version.commitField !== undefined && !jsonField(evidence.version.commitField))) return "version requiere path y campos JSON propios, sin navegación ni prototipos";
 return undefined;
}
export function checkLifecycleConfig(value: unknown): { block: LifecycleConfig } | Problem {
 if (!Value.Check(LifecycleConfigSchema, value)) return { reason: "no cumple lifecycle v1 cerrado: identidad, etapas, proveedores, destinos, evidencia y límites completos" };
 if (!safeStrings(value)) return { reason: "la configuración tiene controles/invisibles o espacios al borde" };
 if (value.repo.split("/").some(p => p === "." || p === "..")) return { reason: "identidad de repo inválida" };
 if (!lifecycleRef(value.land.base)) return { reason: "base de Land inválida" };
 const review = value.review.provider;
 if (review.kind === "gha" && !workflowIdentity(review)) return { reason: "workflow/ref de Review inválido" };
 if (review.kind === "github" && new Set(review.reviewers.map(r => r.toLowerCase())).size !== review.reviewers.length) return { reason: "reviewers repetidos" };
 const checks = value.land.requiredChecks.map(c => JSON.stringify([c.context, c.appId]));
 if (new Set(checks).size !== checks.length) return { reason: "checks context/appId repetidos" };
 if (new Set(value.ship.targets.map(t => t.id)).size !== value.ship.targets.length) return { reason: "IDs de destinos repetidos" };
 for (const target of value.ship.targets) { const reason = targetProblem(target); if (reason) return { reason }; }
 return { block: structuredClone(value) };
}
/** Requiere branch detectada/confirmada: no existe un default global main. */
export function defaultLifecycleConfig(repo: string, base: string): LifecycleConfig {
 const checked = checkLifecycleConfig({
  version: 1, repo, review: { mode: "ask", provider: { kind: "local" }, timeoutSeconds: 1200 },
  corrections: { mode: "ask", maxRounds: 2 }, land: { mode: "ask", base, method: "squash", maxRisk: "low", requiredChecks: [] },
  ship: { status: "unconfigured", targets: [] }, budget: { maxAttempts: 12, maxFixForwardPRs: 1, activeSeconds: 7200 },
 });
 if ("reason" in checked) throw new Error(`Defaults lifecycle inválidos: ${checked.reason}`);
 return checked.block;
}
/** Sólo la creación de un destino materializa defaults. Leer perillas incompletas no las repara. */
export function defaultLifecycleTarget(input: unknown): { target: LifecycleTarget } | Problem {
 if (!record(input) || input.onFailure !== undefined && !record(input.onFailure)) return { reason: "destino u onFailure inválidos" };
 const value = { mode: "ask", timeoutSeconds: 1800, maxRetries: 0, ...input,
  onFailure: { action: "stop", mode: "ask", ...(record(input.onFailure) ? input.onFailure : {}) } };
 if (!Value.Check(LifecycleTargetSchema, value) || !safeStrings(value)) return { reason: "destino lifecycle inválido o incompleto" };
 const reason = targetProblem(value);
 return reason ? { reason } : { target: structuredClone(value) };
}
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function validated(block: LifecycleConfig): LifecycleConfig {
 const checked = checkLifecycleConfig(block);
 if ("reason" in checked) throw new Error(`Lifecycle inválido: ${checked.reason}`);
 return checked.block;
}
/** Claves de objetos canónicas; el orden de destinos es significativo y no se cambia. */
export function lifecycleHash(block: LifecycleConfig): string {
 return createHash("sha256").update(JSON.stringify(canonical(validated(block)))).digest("hex");
}
export function parseLifecycleConfig(body: string, repo: string): ParsedLifecycle {
 let found: { fence: Fence; value: unknown } | undefined;
 for (const fence of fences(body).filter(f => f.info === LIFECYCLE_INFO)) {
  if (!fence.closed) return { status: "invalid", reason: "una cerca lifecycle no cierra" };
  let value: unknown;
  try { value = JSON.parse(body.slice(fence.contentStart, fence.contentEnd)); }
  catch { return { status: "invalid", reason: "JSON lifecycle inválido: no se puede identificar el repo" }; }
  if (!record(value) || typeof value.repo !== "string") return { status: "invalid", reason: "el bloque lifecycle no identifica su repo" };
  if (value.repo.toLowerCase() !== repo.toLowerCase()) continue;
  if (found) return { status: "invalid", reason: "bloques lifecycle duplicados para el repo" };
  found = { fence, value };
 }
 if (!found) return { status: "missing" };
 const checked = checkLifecycleConfig(found.value);
 return "reason" in checked ? { status: "invalid", reason: checked.reason }
  : { status: "valid", block: checked.block, hash: lifecycleHash(checked.block), span: [found.fence.start, found.fence.end] };
}
export function renderLifecycleBlock(block: LifecycleConfig): string {
 const json = JSON.stringify(validated(block), null, 2);
 const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map(m => m[0].length));
 const fence = "`".repeat(Math.max(3, longest + 1));
 return `${fence}${LIFECYCLE_INFO}\n${json}\n${fence}`;
}
/** Control local por span. El caller del guardado debe releer y confirmar la KB (no CAS remoto). */
export function composeLifecyclePerillas(current: string | undefined, product: string, repo: string, block: LifecycleConfig): string {
 if (validated(block).repo !== repo.toLowerCase()) throw new Error("Lifecycle declara otro repo");
 const rendered = renderLifecycleBlock(block);
 let result: string;
 if (current === undefined) result = `# Perillas de ${product}\n\n## Lifecycle de omi · ${block.repo}\n\n${rendered}\n`;
 else {
  const parsed = parseLifecycleConfig(current, repo);
  if (parsed.status === "invalid") throw new Error(`Las perillas lifecycle requieren revisión: ${parsed.reason}`);
  result = parsed.status === "valid" ? current.slice(0, parsed.span[0]) + rendered + current.slice(parsed.span[1])
   : `${current}${current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"}## Lifecycle de omi · ${block.repo}\n\n${rendered}\n`;
 }
 const check = parseLifecycleConfig(result, repo);
 if (check.status !== "valid" || check.hash !== lifecycleHash(block)) throw new Error("Las perillas no admiten el bloque lifecycle sin cambiar su sentido");
 return result;
}
