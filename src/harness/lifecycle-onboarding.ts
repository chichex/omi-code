// Onboarding lifecycle compartido por init y TUI: tandas deterministas sin modelo, resumen y aceptación explícita.
// Guardar escribe sólo la KB y la aceptación local; nunca ejecuta workflows, deploy ni consulta proveedores.
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "../tui/questions/batch.ts";
import type { KbClient } from "../tui/kb-client.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash, type LifecycleConfig, type LifecycleTarget } from "./lifecycle-config.ts";
import { commitLifecycleSave, evaluateLifecycle, lifecycleDiff, prepareLifecycleSave, readLifecycle, type LifecycleReading } from "./lifecycle-kb.ts";
import { readLifecycleTrust, writeLifecycleTrust, type LifecycleAcceptance, type LifecycleKey, type LifecycleTrustReading } from "./lifecycle-trust.ts";
import type { LifecycleDetection } from "./lifecycle-detect.ts";
import { configureLifecycleContinuity, CONTINUITY_NOTICE } from "./lifecycle-wizard.ts";
import { REVIEW_CONTRACT } from "./gha-review-contract.ts";
import { lifecycleRecommendations, reviewCandidates, type LifecycleRecommendation } from "./lifecycle-recommendations.ts";
import { configureLifecycleReview, reviewProviderSummary } from "./lifecycle-review-wizard.ts";

export interface LifecycleOnboardingState { status: "unconfigured" | "pending" | "configured" | "manual" | "not-applicable" | "invalid" | "unavailable"; revision: string | null; reason: string; recommendations: LifecycleRecommendation[] }
/** Sin config, configurado, no-aplica y no se pudo consultar son estados distintos: KB caída nunca es ausencia ni recomienda. */
const MISSING = "missing:";
/** «unconfigured» sale de dos lecturas: sin bloque lifecycle, o un bloque aceptado con Ship sin configurar (Review y Land corren). */
export const lifecycleMissing = (state: LifecycleOnboardingState): boolean => state.status === "unconfigured" && state.revision?.startsWith(MISSING) === true;
export function lifecycleOnboardingStatus(reading: LifecycleReading, local: LifecycleTrustReading, detection: LifecycleDetection | undefined): LifecycleOnboardingState {
 const evaluation = evaluateLifecycle(reading, local);
 if (reading.kind === "unavailable") return { status: "unavailable", revision: null, reason: reading.reason, recommendations: [] };
 if (evaluation.status === "invalid") return { status: "invalid", revision: null, reason: "Configuración lifecycle o aceptación local inválida; requiere revisión humana", recommendations: [] };
 if (reading.kind === "missing") return { status: "unconfigured", revision: `${MISSING}${reading.perillas?.id ?? "none"}`, reason: "Sin configuración lifecycle para el repo", recommendations: lifecycleRecommendations(null, detection) };
 if (reading.kind === "invalid") return { status: "invalid", revision: null, reason: reading.reason, recommendations: [] };
 const recommendations = lifecycleRecommendations(reading.block, detection);
 if (evaluation.status === "pending") return { status: "pending", revision: `lifecycle:${reading.hash}`, reason: "Revisión lifecycle sin aceptar localmente", recommendations };
 return { status: reading.block.ship.status, revision: `lifecycle:${reading.hash}`, reason: `Ship ${reading.block.ship.status}`, recommendations };
}
/** Sin config, pendiente de aceptar o con recomendaciones; nunca en consultas simples/needs-info ni otra vez para la misma revisión postergada. */
export function shouldOfferLifecycleOnboarding(intent: "harness" | "simple" | "needs-info", state: LifecycleOnboardingState, local: LifecycleTrustReading): boolean {
 const deferred = local.kind === "valid" && local.record.deferred?.revision === state.revision;
 return intent === "harness" && state.revision !== null && !deferred && (state.status === "unconfigured" || state.status === "pending" || state.recommendations.length > 0);
}
export interface LifecycleOnboardingDeps {
 kb: KbClient | undefined; key: LifecycleKey; cwd: string; base: string; trustDir: string; detection: LifecycleDetection;
 ask: (batch: QuestionBatch) => Promise<AskResult>; now: () => string; signal: AbortSignal;
 /** La TUI a pedido no repregunta etapas que ya están resueltas. */
 focus?: "missing";
 /** Sólo para startup/new: reclama la revisión diagnosticada al llegar a la primera pregunta. */
 beforeSessionOffer?: (revision: string) => boolean;
}
export type LifecycleOnboardingOutcome = { kind: "saved"; pin: LifecycleAcceptance } | { kind: "deferred"; revision: string } | { kind: "cancelled" } | { kind: "declined" | "suppressed" } | { kind: "unavailable" | "invalid"; reason: string };
const KEEP_SHIP = "Mantener Ship actual", CONFIGURE = "Configurar ahora", LATER = "Más adelante", NOT_APPLICABLE = "Este repo no necesita Ship", MANUAL = "Manual (sin destino verificable)", RECEIPT = "Recibo del proveedor", SAVE = "Guardar y aceptar", SKIP = "No guardar";
const RECOVERY: Record<string, "stop" | "rollback" | "fix-forward"> = { "Detener (stop)": "stop", Rollback: "rollback", "Fix-forward": "fix-forward" };
const MODES: Record<string, "ask" | "auto"> = { "Preguntar antes (ask)": "ask", "Automático (auto)": "auto" };
const WORKFLOW = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/, ENDPOINT = /^\/(?!\/)[A-Za-z0-9_./~-]*$/;
type Mechanism = { kind: "gha"; workflow: string } | { kind: "omi"; service: string; environment: "stage" | "prod" } | { kind: "manual" };
const closed = (id: string, header: string, question: string, options: [string, string][], recommended = true, extra: Partial<Question> = {}): Question => ({ id, header, question, options: options.map(([label, description]) => ({ label, description })), multiSelect: false, recommended, freeText: false, ...extra });
function mechanisms(d: LifecycleDetection): Map<string, Mechanism> {
 const options = new Map<string, Mechanism>();
 for (const w of [...d.workflows].filter(w => w.contract !== REVIEW_CONTRACT).sort((a, b) => Number(b.release) - Number(a.release)).slice(0, 8)) options.set(`GitHub Actions · ${w.file}`, { kind: "gha", workflow: w.file });
 if (d.omi && d.omi !== "invalid") for (const service of d.omi.services.slice(0, 4)) for (const environment of ["stage", "prod"] as const) options.set(`OMI · ${service} · ${environment}`, { kind: "omi", service, environment });
 return options.set(MANUAL, { kind: "manual" });
}
function detected(d: LifecycleDetection): string {
 const omi = d.omi === "invalid" ? "vínculo .omi/project.json inválido" : d.omi ? `OMI ${d.omi.organization}/${d.omi.project}: ${d.omi.services.join(", ")}` : "sin vínculo OMI";
 return [`Workflows: ${d.workflows.map(w => w.file).join(", ") || "ninguno"}`, `Scripts: ${d.scripts.join(", ") || "ninguno"}`, `Manifiestos: ${d.manifests.join(", ") || "ninguno"}`, omi, "Detectado por lectura: nada se ejecutó."].join("\n");
}
const listed = (title: string, recommendations: LifecycleRecommendation[]) => recommendations.length ? `\n${title}:\n${recommendations.map(r => `- ${r.message}`).join("\n")}` : "";
const shipSummary = (ship: LifecycleConfig["ship"]) => ship.status === "configured" ? `Ship configurado: ${ship.targets.map(t => t.id).join(", ")}` : `Ship ${ship.status}`;
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
async function askShip(deps: LifecycleOnboardingDeps, existing: LifecycleConfig | undefined, recommendations: LifecycleRecommendation[]): Promise<LifecycleConfig | "deferred" | "cancelled"> {
 const keepShip: [string, string][] = existing ? [[KEEP_SHIP, `Conserva ${shipSummary(existing.ship)} sin reingresar destinos`]] : [];
 const resume = deps.focus === "missing" ? "/omi-setup" : "omi init";
 const shipOptions: [string, string][] = [...keepShip, [CONFIGURE, "Proponer destino, verificación y recuperación"], [LATER, `Recordar esta revisión; no desactiva y vuelve con ${resume}`], [NOT_APPLICABLE, "Explícito: se guarda como no-aplica tras el resumen"]];
 const first = await deps.ask({ title: `Ship de ${deps.key.repo}`, questions: [closed("ship", "Ship", "¿Cómo seguimos con la entrega (Ship) de este repo?", shipOptions, true, { detail: `${detected(deps.detection)}${listed("Recomendaciones", recommendations)}` })] });
 if (first.status === "cancelled") return "cancelled";
 deps.signal.throwIfAborted();
 const choice = chosen(first.answers, "ship");
 if (choice === LATER) return "deferred";
 if (choice === KEEP_SHIP && existing) return structuredClone(existing);
 const current = existing ?? defaultLifecycleConfig(deps.key.repo, deps.base);
 if (choice === NOT_APPLICABLE) return withShip(current, "not-applicable");
 if (choice !== CONFIGURE) throw new Error("Respuesta de onboarding inválida; no se guardó nada");
 const options = mechanisms(deps.detection), answers = await deps.ask(destinationBatch(options));
 return answers.status === "cancelled" ? "cancelled" : withShip(current, shipTarget(answers.answers, options, current.land.base));
}

/** Wizard manual (init) o contextual (TUI): Esc cancela sin escribir; postergar no desactiva; guardar exige resumen y sí explícito. */
export async function runLifecycleOnboarding(deps: LifecycleOnboardingDeps): Promise<LifecycleOnboardingOutcome> {
 const { key, signal } = deps, reading = await readLifecycle(deps.kb, key, deps.cwd, signal), local = await readLifecycleTrust(deps.trustDir, key), state = lifecycleOnboardingStatus(reading, local, deps.detection);
 if (!deps.kb || state.status === "unavailable" || state.status === "invalid" || reading.kind === "unavailable" || reading.kind === "invalid" || local.kind === "invalid") return { kind: state.status === "invalid" ? "invalid" : "unavailable", reason: state.reason };
 const existing = reading.kind === "valid" ? reading.block : undefined;
 const record = local.kind === "valid" ? local.record : undefined;
 const defer = async (): Promise<LifecycleOnboardingOutcome> => {
  const revision = state.revision; if (!revision) return { kind: "unavailable", reason: state.reason };
  signal.throwIfAborted();
  await writeLifecycleTrust(deps.trustDir, key, record?.revision, { version: 1, ...key, revision: record ? record.revision + 1 : 0, accepted: record?.accepted ?? null, deferred: { revision, at: deps.now() } });
  return { kind: "deferred", revision };
 };
 const focused = deps.focus === "missing";
 const ship = !focused || !existing || existing.ship.status === "unconfigured";
 const review = !focused || state.recommendations.some(r => r.kind === "review-gha");
 const continuity = !focused || state.recommendations.some(r => r.kind === "continuity");
 // Si la KB cambió entre el diagnóstico de la TUI y esta lectura, no se reabre algo ya resuelto.
 if (!ship && !review && !continuity && state.status !== "pending") return { kind: "declined" };
 if (deps.beforeSessionOffer && (!state.revision || !shouldOfferLifecycleOnboarding("harness", state, local) || !deps.beforeSessionOffer(state.revision))) return { kind: "suppressed" };
 const draft = ship || !existing ? await askShip(deps, existing, state.recommendations) : structuredClone(existing);
 if (draft === "deferred") return defer();
 if (draft === "cancelled") return { kind: "cancelled" };
 const reviewed = review ? await configureLifecycleReview(draft, existing?.review.provider ?? null, reviewCandidates(deps.detection), deps.ask) : draft;
 if (!reviewed) return { kind: "cancelled" };
 const block = continuity ? await configureLifecycleContinuity(reviewed, deps.ask) : reviewed;
 if (!block) return { kind: "cancelled" };
 signal.throwIfAborted();
 // Guardar sin tomar una recomendación es haberla visto: posterga esa revisión para que el harness no insista.
 const remaining = lifecycleRecommendations(block, deps.detection), deferral = remaining.length ? { revision: `lifecycle:${lifecycleHash(block)}`, at: deps.now() } : undefined;
 const resume = focused ? "/omi-setup" : "omi init --development";
 const pending = remaining.length ? `${listed("Recomendaciones sin tomar", remaining)}\nGuardar así posterga esta revisión: el harness no la vuelve a ofrecer; volvé con ${resume}.` : "";
 const summary = `${lifecycleDiff(record?.accepted?.block, block, key)}\n${reviewProviderSummary(block.review.provider)}${pending}\n${CONTINUITY_NOTICE}`;
 const options: [string, string][] = [[SAVE, "Escribe perillas y aceptación local; no ejecuta nada"], [SKIP, "No escribe nada"]];
 if (focused && !ship) options.push([LATER, "Posterga la revisión sin escribir en la KB ni cambiar la aceptación"]);
 const accept = await deps.ask({ title: "Resumen antes de guardar", questions: [closed("accept", "Guardar", "¿Guardar en la KB y aceptar esta configuración?", options, false, { detail: summary })] });
 if (accept.status === "cancelled") return { kind: "declined" };
 const choice = chosen(accept.answers, "accept");
 if (choice === LATER && focused && !ship) return defer();
 if (choice !== SAVE) return { kind: "declined" };
 const prepared = await prepareLifecycleSave(deps.kb, key, block, signal, reading.kind === "valid" ? reading.hash : null, deps.cwd);
 return { kind: "saved", pin: await commitLifecycleSave(deps.kb, key, block, prepared, { trustDir: deps.trustDir, expectedRevision: record?.revision, signal, now: deps.now, ...(deferral ? { deferred: deferral } : {}) }) };
}
