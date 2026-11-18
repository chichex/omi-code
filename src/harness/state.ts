import { artifactHash, MAX_ATTEMPTS, MAX_EVIDENCE, MAX_HISTORY, MAX_REVIEWS, MAX_STEPS, parseWorkflow, sourceHash, type Workflow, type Exploration, type InferenceInput, type Plan, type Spec, type Evidence, type Review, type Step } from "./model.ts";

import { recipeNextPhase, recipeRoute } from "./phases.ts";

export type WorkflowEvent =
 | { type: "explored"; exploration: Exploration }
 | { type: "inferences"; inferences: InferenceInput[] }
 | { type: "answered"; id: string; answer: string }
 | { type: "planned"; plan: Plan }
 | { type: "diagnosed"; cause: string; reproduction: string; size: "small" | "large" }
 | { type: "specified"; spec: Spec }
 | { type: "approved" }
 | { type: "step_started"; id: string }
 | { type: "evidence"; evidence: Evidence }
 | { type: "check_failed"; evidence: Evidence }
 | { type: "step_completed"; id: string; commit: string; fingerprint: string }
 | { type: "reviewed"; review: Review }
 | { type: "verified"; fingerprint: string }
 | { type: "retry"; reason: string }
 | { type: "pause"; reason: string }
 | { type: "resume" }
 | { type: "source_changed"; source: Workflow["source"] }
 | { type: "publishing"; head: string; bodyHash: string }
 | { type: "published"; head: string; url: string; number: number };

function requireCondition(condition: unknown, message: string): asserts condition {
 if (!condition) throw new Error(`Harness: ${message}`);
}
function nonempty(value: string): boolean { return typeof value === "string" && value.trim().length > 0; }
function validate(state: Workflow): Workflow { return parseWorkflow(JSON.stringify(state)); }

export function createWorkflow(source: Workflow["source"], checkout: Workflow["checkout"], id: string, at: string): Workflow {
 requireCondition(nonempty(at), "falta fecha");
 return validate({ version: 1, id, revision: 0, source: { ...source, hash: sourceHash(source.title, source.body) }, checkout: { ...checkout },
  phase: "explore", status: "active", blockedReason: "", activity: "Explorar el issue", exploration: null, inferences: [], recipe: null,
  diagnosis: null, spec: null, steps: [], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: null, publication: { status: "none" }, attempts: [], history: [] });
}

export function recipeApprovalHash(state: Workflow): string {
 return artifactHash({ source: state.source, recipe: state.recipe, spec: state.spec });
}
export function isApproved(state: Workflow): boolean {
 return state.recipe !== null && state.approval !== null && state.approval.sourceHash === state.source.hash
  && state.source.hash === sourceHash(state.source.title, state.source.body) && state.approval.recipeHash === recipeApprovalHash(state);
}
function explorationBlock(exploration: Exploration | null): string {
 if (!exploration) return "Falta explorar el repositorio";
 if (!exploration.references.length) return "Faltan referencias del repositorio";
 if (exploration.missingFoundation.length) return `Falta fundación: ${exploration.missingFoundation.join(", ")}`;
 if (exploration.dependencies.some(d => d.blocking && !d.ready)) return "Hay dependencias bloqueantes sin resolver";
 if (exploration.disposition === "needs-info") return exploration.reason;
 return "";
}
function decisionBlock(state: Workflow): string {
 return explorationBlock(state.exploration) || (state.inferences.some(i => i.resolution === "pending") ? "Hay preguntas pendientes" : "");
}
function setBlock(state: Workflow, reason: string): void {
 state.status = reason ? "waiting" : "active";
 state.blockedReason = reason.slice(0, 4000);
}
function requirePhase(state: Workflow, ...phases: Workflow["phase"][]): void {
 requireCondition(phases.includes(state.phase), `evento inválido en fase ${state.phase}`);
}
function stepsFor(state: Workflow): void {
 const recipe = state.recipe;
 requireCondition(recipe, "falta receta");
 if (recipe.route === "direct") {
  state.steps = [{ id: "C1", title: recipe.objective, cases: recipe.cases.map(c => c.id), status: "pending", red: null, green: null, commit: null }];
 }
 state.phase = recipeNextPhase(recipe.route);
}
// Una receta sin aprobar se puede rehacer: si la persona dice que no, se ajusta sin perder
// exploración ni respuestas. Aprobada, sólo cambia con refresh.
function planWorkflow(state: Workflow, plan: Plan): void {
 requirePhase(state, "recipe", "approve");
 requireCondition(!decisionBlock(state), "resolver exploración y preguntas antes del Plan");
 requireCondition(new Set(plan.cases.map(c => c.id)).size === plan.cases.length && plan.cases.every(c => /^D[1-9]\d*$/.test(c.id)), "casos D únicos requeridos");
 const classification = { ...plan.classification };
 const lenses = [...new Set(plan.lenses)];
 if (classification.riskAreas.length) classification.risk = "high";
 if (classification.risk === "high") {
  for (const lens of ["compliance", "security"] as const) if (!lenses.includes(lens)) lenses.push(lens);
 }
 const route = recipeRoute(classification);
 state.recipe = { ...plan, classification, lenses, route };
 state.spec = null; state.diagnosis = null; state.approval = null; state.steps = [];
 stepsFor(state);
}
function specify(state: Workflow, spec: Spec): void {
 requirePhase(state, "spec");
 requireCondition(state.recipe && state.recipe.route === "spec", "falta receta spec");
 requireCondition(spec.steps.length > 0 && spec.playbook.length > 0, "faltan pasos o playbook");
 const ids = spec.steps.map(s => s.id);
 requireCondition(new Set(ids).size === ids.length && ids.every(id => /^C[1-9]\d*$/.test(id)), "pasos C únicos requeridos");
 const cases = state.recipe.cases.map(c => c.id);
 requireCondition(spec.steps.every(s => s.cases.length && s.cases.every(c => cases.includes(c))), "paso contiene caso desconocido");
 requireCondition(cases.every(c => spec.steps.some(s => s.cases.includes(c))), "faltan casos D cubiertos");
 state.spec = spec;
 state.steps = spec.steps.map(s => ({ ...s, status: "pending", red: null, green: null, commit: null }));
 state.phase = "approve";
}
export function successful(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean { return evidence.exitCode === 0 && evidence.outcome === "passed"; }
// Único criterio de "falló de verdad": 126/127 son comando ausente o no ejecutable y >=128 es una señal.
export function expectedFailure(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean {
 return evidence.outcome === "failed" && evidence.exitCode !== null && evidence.exitCode >= 1 && evidence.exitCode <= 125;
}
const EXHAUSTED = "Se agotaron las vueltas; se necesita intervención humana";
// Por lente y contenido: hasta 3 veredictos (pass/fail) y 10 corridas en total, contando
// cancelaciones y errores del proveedor (unknown), que no gastan veredictos.
const MAX_LENS_VERDICTS = 3; const MAX_LENS_RUNS = 10;
// Un lente que falló no se vuelve a tirar sobre el mismo contenido, salvo que un refuter
// posterior apruebe: si no, hay que corregir el código en otra vuelta.
export function lensRunBlock(state: Workflow, lens: Review["lens"], fingerprint: string): string {
 const same = (r: Review) => r.lens === lens && r.fingerprint === fingerprint;
 const runs = state.reviews.filter(same); const last = runs.at(-1);
 if (last?.verdict === "fail") {
  const after = state.reviews.slice(state.reviews.lastIndexOf(last) + 1);
  if (lens === "refuter" || !after.some(r => r.lens === "refuter" && r.fingerprint === fingerprint && r.verdict === "pass")) return `El lente ${lens} ya falló sobre este contenido; corregí el cambio con retry`;
 }
 if (runs.filter(r => r.verdict !== "unknown").length >= MAX_LENS_VERDICTS || runs.length >= MAX_LENS_RUNS) return `Se agotaron los intentos del lente ${lens} sobre este contenido`;
 return "";
}
function requireEvidenceRoom(state: Workflow): void {
 const exit = state.phase === "verify" || state.phase === "pr" ? "hacé retry o refresh" : "pausá y usá /omi-work refresh";
 requireCondition(state.evidence.length < MAX_EVIDENCE, `la evidencia de esta vuelta llegó al tope; ${exit}`);
}
function getStep(state: Workflow, id: string): Step {
 const step = state.steps.find(s => s.id === id);
 requireCondition(step, `paso inexistente: ${id}`);
 return step;
}
function activeEvidenceStep(state: Workflow, evidence: Evidence): Step {
 requirePhase(state, "implement"); requireCondition(state.status === "active" && isApproved(state), "falta aprobación vigente o hay un bloqueo");
 requireCondition(evidence.stepId, "falta paso de evidencia");
 const step = getStep(state, evidence.stepId);
 requireCondition(step.status === "active", "el paso no está activo");
 requireCondition(evidence.caseId === null || step.cases.includes(evidence.caseId), "caso fuera del paso");
 return step;
}
// Ledger de intentos no válidos: conserva la observación, nunca acredita un avance.
function recordFailedCheck(state: Workflow, evidence: Evidence): void {
 requireEvidenceRoom(state); requireCondition(!state.evidence.some(e => e.id === evidence.id), "id de evidencia repetido");
 if (evidence.kind === "reproduction") {
  requirePhase(state, "explore", "diagnose");
  requireCondition(!successful(evidence) && !expectedFailure(evidence), "la reproducción es válida; usar evidence");
 } else {
  requireCondition(evidence.kind === "red" || evidence.kind === "green", "check_failed sólo admite reproducción, rojo o verde");
  const step = activeEvidenceStep(state, evidence);
  requireCondition(evidence.kind === "red" ? !expectedFailure(evidence) : !successful(evidence), "el check es válido; usar evidence");
  step.green = null;
  if (evidence.kind === "red") step.red = null;
 }
 state.evidence.push(evidence);
}
function recordEvidence(state: Workflow, evidence: Evidence): void {
 requireEvidenceRoom(state); requireCondition(!state.evidence.some(e => e.id === evidence.id), "id de evidencia repetido");
 switch (evidence.kind) {
  case "reproduction":
   requirePhase(state, "explore", "diagnose");
   requireCondition(successful(evidence) || expectedFailure(evidence), "reproducción no confirmada");
   break;
  case "red": case "green": {
   const step = activeEvidenceStep(state, evidence);
   if (evidence.kind === "red") {
    requireCondition(expectedFailure(evidence), "rojo debe fallar realmente, no por comando ausente o interrumpido");
    step.red = evidence.id; step.green = null;
   } else {
    const red = state.evidence.find(e => e.id === step.red);
    requireCondition(red && expectedFailure(red) && red.command === evidence.command, "verde requiere rojo previo del mismo comando");
    requireCondition(successful(evidence), "verde debe terminar con exit 0"); step.green = evidence.id;
   }
   break;
  }
  case "verification": case "gate": requirePhase(state, "verify"); break;
 }
 state.evidence.push(evidence);
}
function verifiedEvidence(state: Workflow, fingerprint: string, head?: string): void {
 requireCondition(state.status === "active" && !decisionBlock(state), "hay un bloqueo pendiente");
 requireCondition(isApproved(state) && state.recipe && state.steps.length && state.steps.every(s => s.status === "done" && s.commit), "faltan pasos o aprobación");
 for (const c of state.recipe.cases) {
  const latest = state.evidence.findLast(e => e.kind === "verification" && e.caseId === c.id);
  requireCondition(latest && successful(latest) && latest.command === c.command && latest.fingerprint === fingerprint && (head === undefined || latest.head === head), `falta verificación actual del caso ${c.id}`);
 }
 for (const lens of state.recipe.lenses) {
  const review = state.reviews.findLast(r => r.lens === lens && r.fingerprint === fingerprint);
  requireCondition(review?.verdict === "pass" && review.findings.length === 0, `falta lente aprobado: ${lens}`);
 }
 const gates = state.evidence.filter(e => e.kind === "gate" && e.fingerprint === fingerprint);
 for (const command of new Set(gates.map(e => e.command))) {
  const latest = gates.findLast(e => e.command === command);
  requireCondition(latest && successful(latest), "gate fallido");
 }
}
function startStep(state: Workflow, id: string): void {
 requirePhase(state, "implement"); requireCondition(state.status === "active" && isApproved(state) && !decisionBlock(state), "falta aprobación vigente o hay un bloqueo");
 const step = getStep(state, id);
 requireCondition(step.status === "pending" && !state.steps.some(s => s.status === "active"), "sólo un paso activo");
 const index = state.steps.indexOf(step);
 requireCondition(state.steps.slice(0, index).every(s => s.status === "done"), "dependencias previas sin completar");
 step.status = "active";
}
function completeStep(state: Workflow, event: Extract<WorkflowEvent, { type: "step_completed" }>): void {
 requirePhase(state, "implement"); requireCondition(state.status === "active" && isApproved(state) && !decisionBlock(state), "falta aprobación vigente o hay un bloqueo");
 const step = getStep(state, event.id);
 const green = state.evidence.find(e => e.id === step.green);
 requireCondition(step.status === "active" && green && successful(green) && green.fingerprint === event.fingerprint, "falta verde actual");
 requireCondition(nonempty(event.commit), "falta commit");
 requireCondition(!state.steps.some(s => s.id !== step.id && s.commit === event.commit), "el commit ya acredita otro paso");
 step.status = "done"; step.commit = event.commit;
 if (state.steps.every(s => s.status === "done")) state.phase = "verify";
}
function archiveAttempt(state: Workflow, reason: string, at: string): void {
 if (!state.evidence.length && !state.reviews.length) return;
 // Sólo la cola de cada salida: el archivo de intentos no puede llenar el tope de 8 MB del estado.
 const evidence = state.evidence.map(e => ({ ...e, output: e.output.slice(-500) }));
 state.attempts = [...(state.attempts ?? []), { sourceHash: state.source.hash, round: state.round, reason, at, evidence, reviews: state.reviews }].slice(-MAX_ATTEMPTS);
}
// Lo ya commiteado sigue hecho: no puede volver a dar rojo. La vuelta agrega un paso de
// corrección que cubre todos los D y exige su propio rojo, verde y commit.
function retry(state: Workflow, reason: string, at: string): void {
 requirePhase(state, "verify", "pr"); requireCondition(nonempty(reason), "falta motivo del reintento");
 requireCondition(state.status === "active" && !decisionBlock(state) && state.recipe, "hay un bloqueo pendiente");
 if (state.round >= state.maxRounds) { setBlock(state, EXHAUSTED); return; }
 requireCondition(state.steps.length < MAX_STEPS, "no quedan pasos para otra vuelta; dividí la tarea");
 archiveAttempt(state, reason, at);
 state.round++; state.phase = "implement";
 const next = Math.max(0, ...state.steps.map(s => Number(/^C(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1;
 state.steps.push({ id: `C${next}`, title: `Corrección de la vuelta ${state.round}: ${reason}`.slice(0, 4000), cases: state.recipe.cases.map(c => c.id), status: "pending", red: null, green: null, commit: null });
 state.evidence = []; state.reviews = []; state.publication = { status: "none" };
 // La aprobación se conserva sólo para exactamente el mismo source/receta/spec.
 if (!isApproved(state)) state.approval = null;
 setBlock(state, state.approval ? "" : "Falta aprobación humana vigente");
}
function sourceChanged(state: Workflow, source: Workflow["source"], at: string): void {
 requireCondition(source.number === state.source.number && source.url === state.source.url, "no se puede cambiar la identidad del issue");
 archiveAttempt(state, "Cambió el pedido o se volvió a explorar", at);
 state.source = { ...source, hash: sourceHash(source.title, source.body) };
 state.exploration = null; state.inferences = []; state.recipe = null; state.diagnosis = null; state.spec = null;
 state.steps = []; state.evidence = []; state.reviews = []; state.approval = null; state.round = 0;
 state.publication = { status: "none" }; state.phase = "explore"; setBlock(state, "");
}
// El bloqueo de vueltas agotadas vive en el estado, no en el historial: el historial es una ventana acotada.
function retriesExhausted(state: Workflow): boolean {
 return state.round >= state.maxRounds && state.blockedReason === EXHAUSTED;
}
function resumeBlock(state: Workflow): string {
 if (retriesExhausted(state)) return EXHAUSTED;
 const approvalRequired = state.phase === "approve" || (["implement", "verify", "pr"].includes(state.phase) && !isApproved(state));
 return decisionBlock(state) || (approvalRequired ? "Falta aprobación humana vigente" : "") || state.blockedReason;
}
function recordReview(state: Workflow, review: Review): void {
 requirePhase(state, "verify");
 requireCondition(state.recipe?.lenses.includes(review.lens), "lente fuera de la receta");
 const blocked = lensRunBlock(state, review.lens, review.fingerprint); requireCondition(!blocked, blocked);
 requireCondition(state.reviews.length < MAX_REVIEWS, "los lentes de esta vuelta llegaron al tope; hacé retry o refresh");
 requireCondition(review.verdict !== "pass" || review.findings.length === 0, "un lente con hallazgos no puede aprobar");
 state.reviews.push(review);
}
// La UI/adapter es la única autoridad que puede emitir approved o autorizar una reproducción.
// Este reducer puro no ejecuta comandos, verifica Git ni obtiene consentimiento.
export function transition(original: Workflow, event: WorkflowEvent, at: string): Workflow {
 const state = validate(original);
 requireCondition(nonempty(at), "falta fecha");
 // Un cierre sin cambio lo decide el modelo; volver a leer el pedido es la salida humana.
 requireCondition(state.status !== "complete" || state.phase === "closed" && event.type === "source_changed", "el trabajo ya está cerrado");
 requireCondition(state.status !== "paused" || event.type === "resume" || event.type === "source_changed", "el trabajo está pausado");
 if (state.status === "waiting" && retriesExhausted(state)) requireCondition(["pause", "resume", "source_changed"].includes(event.type), "se agotaron las vueltas");
 applyEvent(state, event, at);
 state.revision++;
 state.activity = (event.type === "pause" || event.type === "retry" ? `${event.type}: ${event.reason}` : event.type).slice(0, 4000);
 state.history = [...state.history, { at, phase: state.phase, activity: state.activity }].slice(-MAX_HISTORY);
 return validate(state);
}
// Tabla de eventos: los helpers mantienen juntas las invariantes de cada artefacto.
function applyEvent(state: Workflow, event: WorkflowEvent, at: string): void {
 switch (event.type) {
  case "explored":
   requirePhase(state, "explore", "decide"); state.exploration = event.exploration;
   if (event.exploration.disposition === "wontfix") { state.phase = "closed"; state.status = "complete"; state.blockedReason = event.exploration.reason; }
   else { state.phase = "decide"; setBlock(state, decisionBlock(state)); }
   return;
  case "inferences":
   requirePhase(state, "decide"); requireCondition(!explorationBlock(state.exploration), "falta exploración lista");
   requireCondition(new Set(event.inferences.map(i => i.id)).size === event.inferences.length, "preguntas repetidas");
   requireCondition(!state.inferences.length, "las inferencias ya se registraron");
   state.inferences = event.inferences.map(i => {
    const assume = i.confidence >= 80 && !i.irreversible && (i.kind !== "how" || i.references.length > 0);
    return { ...i, resolution: assume ? "assumed" : "pending", answer: assume ? i.recommended : null };
   }); setBlock(state, decisionBlock(state));
   if (state.status === "active") state.phase = "recipe";
   return;
  case "answered": {
   requirePhase(state, "decide"); const inference = state.inferences.find(i => i.id === event.id);
   requireCondition(inference && inference.resolution === "pending" && nonempty(event.answer), "pregunta o respuesta inválida");
   inference.resolution = "answered"; inference.answer = event.answer; setBlock(state, decisionBlock(state));
   if (state.status === "active") state.phase = "recipe";
   return;
  }
  case "planned": planWorkflow(state, event.plan); return;
  case "diagnosed": {
   requirePhase(state, "diagnose"); requireCondition(state.recipe && nonempty(event.cause), "falta causa");
   const reproduction = state.evidence.find(e => e.id === event.reproduction && e.kind === "reproduction");
   requireCondition(reproduction && (successful(reproduction) || expectedFailure(reproduction)), "falta reproducción confirmada");
   state.diagnosis = { cause: event.cause, reproduction: event.reproduction, size: event.size };
   state.recipe.classification.causeKnown = true; state.recipe.classification.size = event.size;
   state.recipe.route = recipeRoute(state.recipe.classification); stepsFor(state); return;
  }
  case "specified": specify(state, event.spec); return;
  case "approved":
   requirePhase(state, "approve"); requireCondition(!decisionBlock(state) && state.recipe && state.steps.length, "faltan decisiones, receta o pasos");
   requireCondition(state.recipe.route !== "spec" || state.spec, "falta spec");
   state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), at }; state.phase = "implement"; setBlock(state, ""); return;
  case "step_started": startStep(state, event.id); return;
  case "evidence": recordEvidence(state, event.evidence); return;
  case "check_failed": recordFailedCheck(state, event.evidence); return;
  case "step_completed": completeStep(state, event); return;
  case "reviewed": recordReview(state, event.review); return;
  case "verified": requirePhase(state, "verify"); verifiedEvidence(state, event.fingerprint); state.phase = "pr"; return;
  case "retry": retry(state, event.reason, at); return;
  case "pause":
   requireCondition(nonempty(event.reason), "falta motivo de pausa");
   // El motivo de pausa queda en activity/history; un bloqueo previo no debe perderse.
   if (state.status !== "waiting") state.blockedReason = "";
   state.status = "paused"; return;
  case "resume":
   requireCondition(state.status === "paused", "el trabajo no está pausado");
   setBlock(state, resumeBlock(state)); return;
  case "source_changed": sourceChanged(state, event.source, at); return;
  case "publishing": {
   requirePhase(state, "pr"); const latest = state.evidence.findLast(e => e.kind === "verification");
   requireCondition(latest, "falta verificación"); verifiedEvidence(state, latest.fingerprint, event.head);
   requireCondition(nonempty(event.bodyHash), "falta hash del cuerpo");
   if (state.publication.status === "pending") requireCondition(state.publication.head === event.head && state.publication.bodyHash === event.bodyHash, "publicación pendiente distinta");
   state.publication = { status: "pending", head: event.head, bodyHash: event.bodyHash, at }; return;
  }
  case "published":
   requirePhase(state, "pr"); requireCondition(state.publication.status === "pending" && state.publication.head === event.head, "head no coincide con publicación pendiente");
   state.publication = { status: "opened", head: event.head, url: event.url, number: event.number }; state.phase = "done"; state.status = "complete"; return;
  default: { const unhandled: never = event; throw new Error(`Evento desconocido: ${JSON.stringify(unhandled)}`); }
 }
}
