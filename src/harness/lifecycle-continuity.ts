// Selector puro de continuidad. El host conserva coordinación, autorización y guardrails de cada efecto.
import type { Workflow } from "./model.ts";
import type { LifecycleConfig, LifecycleContinuity, ContinuityMode } from "./lifecycle-schema.ts";
import type { EnabledLifecycle, LifecycleState } from "./lifecycle-state-schema.ts";
import type { SelectedPause } from "./continuity-pause.ts";

export type ContinuityStage = keyof LifecycleContinuity;
/** push publica la corrección ya verificada en el mismo PR; fix abre o confirma una ronda. Ambas son de la etapa fix. */
export type ContinuityAction = "adopt" | "review" | "fix" | "push" | "land" | "ship";
export type ContinuitySelection =
 | { kind: "action"; action: ContinuityAction; stage: ContinuityStage; mode: Exclude<ContinuityMode, "manual"> }
 | { kind: "pause"; reason: SelectedPause; stage?: ContinuityStage }
 | { kind: "yield"; reason: "correction-model" }
 | { kind: "complete" };
export interface ContinuityInput {
 workflow: Pick<Workflow, "phase" | "status" | "blockedReason" | "publication"> & { lifecycle?: LifecycleState };
 /** Config aceptada para entrada. Con lifecycle habilitado manda su pin vigente, no esta copia. */
 config: LifecycleConfig | null;
 /** Sólo el host que acaba de confirmar publicación puede emitir publication-confirmed. Restaurar no llama al selector. */
 trigger: "publication-confirmed" | "advance";
 /** Hechos ya ingeridos por el host, incluso Review vacía. Un recibo solo no acredita la ingesta.
  * Efímero: restaurar una sesión no recrea esta señal. No es aprobación de Land. */
 reviewObserved: { operationId: string; subjectId: string } | null;
}
const pause = (reason: SelectedPause): ContinuitySelection => ({ kind: "pause", reason });
/** No materializa ni muta la configuración legacy. */
export function effectiveLifecycleContinuity(config: LifecycleConfig): LifecycleContinuity {
 return config.continuity ? { ...config.continuity } : { entry: "manual", review: "manual", fix: "manual", land: "manual", ship: "manual" };
}
function offer(config: LifecycleConfig, stage: ContinuityStage, action: ContinuityAction): ContinuitySelection {
 const mode = effectiveLifecycleContinuity(config)[stage];
 return mode === "manual" ? { kind: "pause", reason: "manual", stage } : { kind: "action", action, stage, mode };
}
function observedReview(s: EnabledLifecycle, observed: ContinuityInput["reviewObserved"]): boolean {
 if (!observed || observed.subjectId !== s.currentSubject) return false;
 const op = s.operations.findLast(o => o.kind === "review" && o.subjectId === s.currentSubject);
 return !!op && op.id === observed.operationId && op.status === "confirmed" && op.receipt.outcome === "succeeded"
  && op.receipt.verifiedSubjectId === s.currentSubject;
}
type Finding = EnabledLifecycle["ledger"][number];
/** La última disposición, sólo si es del HEAD actual y de la última observación del hallazgo. */
function currentDisposition(s: EnabledLifecycle, f: Finding): Finding["dispositions"][number] | undefined {
 const observation = f.observations.at(-1), disposition = f.dispositions.at(-1);
 return disposition?.subjectId === s.currentSubject && disposition.observationHash === observation?.hash
  && disposition.observationSequence === f.observations.length ? disposition : undefined;
}
const settled = (s: EnabledLifecycle, f: Finding) => ["corrected", "refuted-with-evidence"].includes(currentDisposition(s, f)?.status ?? "");
function findingStatus(s: EnabledLifecycle): "clear" | "fix" | "human" {
 if (s.ledger.some(f => currentDisposition(s, f)?.status === "human-required")) return "human";
 return s.ledger.every(f => settled(s, f)) ? "clear" : "fix";
}
/** El ejecutor puede pedir confirmación humana de hallazgos ya corregidos sin reservar ronda: sólo de los que siguen pendientes. */
function canConfirmCorrected(s: EnabledLifecycle): boolean {
 return s.evidence.some(e => e.subjectId === s.currentSubject && e.kind === "verification" && e.outcome === "pass")
  && s.ledger.some(f => !settled(s, f) && f.observations.at(-1)?.subjectId === s.currentSubject && f.dispositions.some(d => d.status === "corrected"));
}
/** Sin la Review observada en esta sesión no se encadena. El próximo paso sale de los hallazgos ya registrados, sin repetir la Review. */
function unobservedReview(s: EnabledLifecycle): ContinuitySelection {
 const findings = findingStatus(s);
 if (findings === "human") return pause("human-required");
 return { kind: "pause", reason: "review-facts-required", stage: findings === "clear" ? "land" : "fix" };
}
function reviewOrFix(input: ContinuityInput, s: EnabledLifecycle, config: LifecycleConfig): ContinuitySelection {
 const op = s.operations.findLast(o => o.kind === "review" && o.subjectId === s.currentSubject);
 if (!op) return offer(config, "review", "review");
 if (!observedReview(s, input.reviewObserved)) return unobservedReview(s);
 const findings = findingStatus(s);
 if (findings === "human") return pause("human-required");
 if (findings === "fix") {
  const fix = offer(config, "fix", "fix");
  // En la cadena, corrections auto no abre «Ya corregidos» (fixLifecycle): sin rondas no queda acción. A mano sí los confirma.
  const confirmable = !(fix.kind === "action" && config.corrections.mode === "auto") && canConfirmCorrected(s);
  if (s.budget.roundsUsed >= config.corrections.maxRounds && !confirmable) return pause("rounds-exhausted");
  return fix;
 }
 return offer(config, "land", "land");
}
function correction(input: ContinuityInput, s: EnabledLifecycle, config: LifecycleConfig): ContinuitySelection | null {
 const round = s.corrections?.at(-1);
 if (!round || round.status === "pushed") return null;
 if (round.status === "failed") return pause("correction-failed");
 if ((round.status === "coding" || round.status === "planned") && ["implement", "verify"].includes(input.workflow.phase)) {
  return { kind: "yield", reason: "correction-model" };
 }
 // La vuelta ya consumió su ronda: publicar la verificación es un push, no otra ronda.
 if (input.workflow.phase === "pr" || round.status === "verified") return offer(config, "fix", "push");
 return pause("correction-facts-required");
}
/** Selecciona UNA acción, sin efectuar I/O, reservar operaciones ni conceder permisos.
 * ask confirma continuidad; auto sólo ofrece llamar la capacidad existente con sus permisos independientes.
 * El llamador debe detener la cadena ante cancelación/rechazo/error, nunca reinterpretarlo como advance.
 */
export function selectLifecycleContinuation(input: ContinuityInput): ContinuitySelection {
 const w = input.workflow;
 if (w.status === "paused") return pause("workflow-paused");
 if (w.status === "waiting") return pause("workflow-waiting");
 if (w.blockedReason) return pause("workflow-blocked");
 const s = w.lifecycle;
 if (!s || s.status === "disabled") {
  if (w.publication.status !== "opened") return pause("publication-required");
  // El lifecycle adopta un solo PR: un stack no se adopta ni se pregunta su entrada.
  if (w.publication.stack) return { kind: "pause", reason: "stack-unsupported", stage: "entry" };
  if (input.trigger !== "publication-confirmed") return pause("entry-trigger-required");
  return input.config ? offer(input.config, "entry", "adopt") : pause("config-required");
 }
 if (s.stage === "paused") return pause("lifecycle-paused");
 if (s.stage === "complete" || s.stage === "delivered") return { kind: "complete" };
 if (!s.currentSubject || !s.subjects.some(subject => subject.id === s.currentSubject)) return pause("subject-required");
 const config = s.pins.find(pin => pin.accepted.blockHash === s.pinHash)?.accepted.block;
 if (!config) return pause("config-required");
 const round = s.corrections?.at(-1);
 // coding guarda una reserva pending durante todo el TDD. Continuar su modelo o verificarla
 // en PR no repite el efecto; cualquier OTRA reserva, o unknown incluso propio, sí bloquea.
 const coding = round?.status === "coding" || round?.status === "planned";
 if (s.operations.some(op => op.status !== "confirmed" && !(coding && op.id === round.operationId
  && op.kind === "correction" && op.status === "pending"))) return pause("operation-unsettled");
 // Un fallo confirmado no es incierto, pero no concede un retry automático sin diagnóstico.
 const latest = s.operations.at(-1);
 if (latest?.status === "confirmed" && latest.receipt.outcome === "failed") return pause("operation-failed");
 if (s.segments.some(segment => segment.mode !== "closed")) return pause("activity-unsettled");
 if (s.budget.activeMilliseconds >= config.budget.activeSeconds * 1000) return pause("budget-exhausted");
 const activeCorrection = correction(input, s, config);
 // Ceder al modelo termina el intento ya reservado; push sigue necesitando otra reserva.
 if (activeCorrection?.kind === "yield") return activeCorrection;
 if (s.budget.attemptsUsed >= config.budget.maxAttempts) return pause("budget-exhausted");
 if (activeCorrection) return activeCorrection;
 switch (s.stage) {
  case "review": return reviewOrFix(input, s, config);
  case "corrections": return pause("correction-facts-required");
  case "ready": case "land":
   if (!observedReview(s, input.reviewObserved)) return unobservedReview(s);
   if (findingStatus(s) !== "clear") return reviewOrFix(input, s, config);
   return offer(config, "land", "land");
  case "ship":
   if (["unconfigured", "manual"].includes(config.ship.status)) return pause("ship-unconfigured");
   return offer(config, "ship", "ship");
 }
}
