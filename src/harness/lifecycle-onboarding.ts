// Onboarding lifecycle compartido por init y TUI: tandas deterministas sin modelo, resumen y aceptación explícita.
// Guardar escribe sólo la KB y la aceptación local; nunca ejecuta workflows, deploy ni consulta proveedores.
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "../tui/questions/batch.ts";
import type { KbClient } from "../tui/kb-client.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, type LifecycleConfig, type LifecycleTarget } from "./lifecycle-config.ts";
import { commitLifecycleSave, evaluateLifecycle, lifecycleDiff, prepareLifecycleSave, readLifecycle, type LifecycleReading } from "./lifecycle-kb.ts";
import { readLifecycleTrust, writeLifecycleTrust, type LifecycleAcceptance, type LifecycleKey, type LifecycleTrustReading } from "./lifecycle-trust.ts";
import type { LifecycleDetection } from "./lifecycle-detect.ts";

export interface LifecycleOnboardingState { status: "unconfigured" | "pending" | "configured" | "manual" | "not-applicable" | "invalid" | "unavailable"; revision: string | null; reason: string }
/** Sin config, configurado, no-aplica y no se pudo consultar son estados distintos: KB caída nunca es ausencia. */
export function lifecycleOnboardingStatus(reading: LifecycleReading, local: LifecycleTrustReading): LifecycleOnboardingState {
 const evaluation = evaluateLifecycle(reading, local);
 if (reading.kind === "unavailable") return { status: "unavailable", revision: null, reason: reading.reason };
 if (evaluation.status === "invalid") return { status: "invalid", revision: null, reason: "Configuración lifecycle o aceptación local inválida; requiere revisión humana" };
 if (reading.kind === "missing") return { status: "unconfigured", revision: `missing:${reading.perillas?.id ?? "none"}`, reason: "Sin configuración lifecycle para el repo" };
 if (reading.kind === "invalid") return { status: "invalid", revision: null, reason: reading.reason };
 if (evaluation.status === "pending") return { status: "pending", revision: `lifecycle:${reading.hash}`, reason: "Revisión lifecycle sin aceptar localmente" };
 return { status: reading.block.ship.status, revision: `lifecycle:${reading.hash}`, reason: `Ship ${reading.block.ship.status}` };
}
/** Se ofrece al entrar al harness, nunca en consultas simples/needs-info ni otra vez para la misma revisión postergada. */
export function shouldOfferLifecycleOnboarding(intent: "harness" | "simple" | "needs-info", state: LifecycleOnboardingState, local: LifecycleTrustReading): boolean {
 return intent === "harness" && state.status === "unconfigured" && state.revision !== null && !(local.kind === "valid" && local.record.deferred?.revision === state.revision);
}
export interface LifecycleOnboardingDeps {
 kb: KbClient | undefined; key: LifecycleKey; cwd: string; base: string; trustDir: string; detection: LifecycleDetection;
 ask: (batch: QuestionBatch) => Promise<AskResult>; now: () => string; signal: AbortSignal;
}
export type LifecycleOnboardingOutcome = { kind: "saved"; pin: LifecycleAcceptance } | { kind: "deferred"; revision: string } | { kind: "cancelled" } | { kind: "declined" } | { kind: "unavailable" | "invalid"; reason: string };
const CONFIGURE = "Configurar ahora", LATER = "Más adelante", NOT_APPLICABLE = "Este repo no necesita Ship", MANUAL = "Manual (sin destino verificable)", RECEIPT = "Recibo del proveedor", SAVE = "Guardar y aceptar", SKIP = "No guardar";
const RECOVERY: Record<string, "stop" | "rollback" | "fix-forward"> = { "Detener (stop)": "stop", Rollback: "rollback", "Fix-forward": "fix-forward" };
const MODES: Record<string, "ask" | "auto"> = { "Preguntar antes (ask)": "ask", "Automático (auto)": "auto" };
const WORKFLOW = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/, ENDPOINT = /^\/(?!\/)[A-Za-z0-9_./~-]*$/;
type Mechanism = { kind: "gha"; workflow: string } | { kind: "omi"; service: string; environment: "stage" | "prod" } | { kind: "manual" };
const closed = (id: string, header: string, question: string, options: [string, string][], recommended = true, extra: Partial<Question> = {}): Question => ({ id, header, question, options: options.map(([label, description]) => ({ label, description })), multiSelect: false, recommended, freeText: false, ...extra });
function mechanisms(d: LifecycleDetection): Map<string, Mechanism> {
 const options = new Map<string, Mechanism>();
 for (const w of [...d.workflows].sort((a, b) => Number(b.release) - Number(a.release)).slice(0, 8)) options.set(`GitHub Actions · ${w.file}`, { kind: "gha", workflow: w.file });
 if (d.omi && d.omi !== "invalid") for (const service of d.omi.services.slice(0, 4)) for (const environment of ["stage", "prod"] as const) options.set(`OMI · ${service} · ${environment}`, { kind: "omi", service, environment });
 return options.set(MANUAL, { kind: "manual" });
}
function detected(d: LifecycleDetection): string {
 const omi = d.omi === "invalid" ? "vínculo .omi/project.json inválido" : d.omi ? `OMI ${d.omi.organization}/${d.omi.project}: ${d.omi.services.join(", ")}` : "sin vínculo OMI";
 return [`Workflows: ${d.workflows.map(w => w.file).join(", ") || "ninguno"}`, `Scripts: ${d.scripts.join(", ") || "ninguno"}`, `Manifiestos: ${d.manifests.join(", ") || "ninguno"}`, omi, "Detectado por lectura: nada se ejecutó."].join("\n");
}
function destinationBatch(options: Map<string, Mechanism>): QuestionBatch {
 return { title: "Destino de Ship", questions: [
  closed("mechanism", "Mecanismo", "¿Qué entrega verifica OMI después del merge?", [...options.keys()].map(label => [label, label === MANUAL ? "Sin destino: Ship queda manual" : "Propuesto por lo detectado; sólo se observa"]), true, { freeText: { multiline: false, validate: text => WORKFLOW.test(text.trim()) ? undefined : "Nombre de workflow .yml de .github/workflows" } }),
  closed("verify", "Verificar", "¿Cómo se comprueba la entrega?", [[RECEIPT, "GHA: recibo omi-ship-v1 · OMI: recibo de publicación"]], true, { freeText: { multiline: false, validate: text => ENDPOINT.test(text.trim()) && !text.includes("..") ? undefined : "Path de health relativo al destino, por ejemplo /health" } }),
  closed("recovery", "Si falla", "¿Qué hace OMI si Ship falla?", [["Detener (stop)", "Merge hecho, sin compensar"], ["Rollback", "Sólo con versión previa y verificador"], ["Fix-forward", "PR nuevo en la misma raíz y presupuesto"]]),
  closed("mode", "Modo", "¿Ship pregunta antes de cada efecto?", [["Preguntar antes (ask)", "Cada efecto pide permiso"], ["Automático (auto)", "Sólo con reglas y permisos válidos"]]),
 ] };
}
const chosen = (answers: QuestionAnswer[], id: string) => { const a = answers.find(x => x.id === id); return a?.options[0] ?? a?.text?.trim() ?? ""; };
function shipTarget(answers: QuestionAnswer[], options: Map<string, Mechanism>, base: string): LifecycleTarget | "manual" {
 const label = chosen(answers, "mechanism"), m = options.get(label) ?? (WORKFLOW.test(label) ? { kind: "gha" as const, workflow: label } : undefined);
 if (!m) throw new Error("Mecanismo de Ship inválido; no se guardó nada");
 if (m.kind === "manual") return "manual";
 const verify = chosen(answers, "verify"), health = verify && verify !== RECEIPT ? { health: { path: verify, status: 200 } } : undefined;
 const action = RECOVERY[chosen(answers, "recovery")], mode = MODES[chosen(answers, "mode")];
 if (!action || !mode) throw new Error("Recuperación o modo inválidos; no se guardó nada");
 const input = m.kind === "gha"
  ? { id: `gha-${m.workflow.replace(/\.ya?ml$/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`, provider: { kind: "gha", workflow: m.workflow, ref: base, mode: "observe", contract: "omi-ship-v1" }, evidence: { kind: "receipt", ...health } }
  : { id: `omi-${m.service}-${m.environment}`, provider: { kind: "omi", service: m.service, environment: m.environment, mode: "observe" }, evidence: health ? { kind: "omi", ...health } : { kind: "omi", provenance: "publication-receipt" } };
 const made = defaultLifecycleTarget({ ...input, mode, onFailure: { action, mode: "ask" } });
 if ("reason" in made) throw new Error(`Destino inválido: ${made.reason}; no se guardó nada`);
 return made.target;
}
function withShip(current: LifecycleConfig, target: LifecycleTarget | "manual" | "not-applicable"): LifecycleConfig {
 const block = structuredClone(current), kept = block.ship.status === "configured" ? block.ship.targets : [];
 block.ship = typeof target === "string" ? { status: target, targets: [] } : { status: "configured", targets: [...kept.filter(t => t.id !== target.id), target] }; return block;
}
/** Wizard manual (init) o contextual (TUI): Esc cancela sin escribir; postergar no desactiva; guardar exige resumen y sí explícito. */
export async function runLifecycleOnboarding(deps: LifecycleOnboardingDeps): Promise<LifecycleOnboardingOutcome> {
 const { key, signal } = deps, reading = await readLifecycle(deps.kb, key, deps.cwd, signal), local = await readLifecycleTrust(deps.trustDir, key), state = lifecycleOnboardingStatus(reading, local);
 if (!deps.kb || state.status === "unavailable" || state.status === "invalid" || reading.kind === "unavailable" || reading.kind === "invalid" || local.kind === "invalid") return { kind: state.status === "invalid" ? "invalid" : "unavailable", reason: state.reason };
 const first = await deps.ask({ title: `Ship de ${key.repo}`, questions: [closed("ship", "Ship", "¿Cómo seguimos con la entrega (Ship) de este repo?", [[CONFIGURE, "Proponer destino, verificación y recuperación"], [LATER, "Recordar esta revisión; no desactiva y vuelve con omi init"], [NOT_APPLICABLE, "Explícito: se guarda como no-aplica tras el resumen"]], true, { detail: detected(deps.detection) })] });
 if (first.status === "cancelled") return { kind: "cancelled" };
 const record = local.kind === "valid" ? local.record : undefined, choice = chosen(first.answers, "ship"); signal.throwIfAborted();
 if (choice === LATER) {
  const revision = state.revision; if (!revision) return { kind: "unavailable", reason: state.reason };
  await writeLifecycleTrust(deps.trustDir, key, record?.revision, { version: 1, ...key, revision: record ? record.revision + 1 : 0, accepted: record?.accepted ?? null, deferred: { revision, at: deps.now() } });
  return { kind: "deferred", revision };
 }
 const current = reading.kind === "valid" ? reading.block : defaultLifecycleConfig(key.repo, deps.base);
 let block: LifecycleConfig;
 if (choice === NOT_APPLICABLE) block = withShip(current, "not-applicable");
 else if (choice === CONFIGURE) {
  const options = mechanisms(deps.detection), answers = await deps.ask(destinationBatch(options));
  if (answers.status === "cancelled") return { kind: "cancelled" };
  block = withShip(current, shipTarget(answers.answers, options, current.land.base));
 } else throw new Error("Respuesta de onboarding inválida; no se guardó nada");
 const summary = lifecycleDiff(record?.accepted?.block, block, key);
 const accept = await deps.ask({ title: "Resumen antes de guardar", questions: [closed("accept", "Guardar", "¿Guardar en la KB y aceptar esta configuración?", [[SAVE, "Escribe perillas y aceptación local; no ejecuta nada"], [SKIP, "No escribe nada"]], false, { detail: summary })] });
 if (accept.status === "cancelled" || chosen(accept.answers, "accept") !== SAVE) return { kind: "declined" };
 const prepared = await prepareLifecycleSave(deps.kb, key, block, signal, reading.kind === "valid" ? reading.hash : null, deps.cwd);
 return { kind: "saved", pin: await commitLifecycleSave(deps.kb, key, block, prepared, { trustDir: deps.trustDir, expectedRevision: record?.revision, signal, now: deps.now }) };
}
