import { artifactHash, MAX_AGREEMENTS, MAX_AMENDS, MAX_ATTEMPTS, MAX_EVIDENCE, MAX_GRANTS, MAX_HISTORY, MAX_REVIEWS, MAX_ROUNDS, MAX_STEPS, parseWorkflow, sourceHash, type Workflow, type WorkflowV2, type Exploration, type InferenceInput, type Plan, type Spec, type Evidence, type Review, type Step, type StackPull } from "./model.ts";

import { recipeNextPhase, recipeRoute } from "./phases.ts";
import { executionEvidence, executionReviews, assertCorrectionExecution } from "./execution-scope.ts";
import { amendsOf, lensReview } from "./lenses.ts";
import { acceptedRisksOf, contentSecurityBlocks, recordAcceptedRisk, riskAccepted, securityBlocks, unacceptedBlockers } from "./security-blockers.ts";
import { openedStack, planStack, stackGroups, stackProblem, syncedStack } from "./stack.ts";
import { MAX_CHECK_TIMEOUT_SECONDS } from "./check-timing.ts";

export type WorkflowEvent =
 | { type: "explored"; exploration: Exploration }
 | { type: "inferences"; inferences: InferenceInput[] }
 | { type: "answered"; id: string; answer: string }
 | { type: "planned"; plan: Plan }
 | { type: "diagnosed"; cause: string; reproduction: string; size: "small" | "large" }
 | { type: "specified"; spec: Spec }
 | { type: "approved"; by?: "person" | "foundations"; foundations?: string }
 | { type: "command_granted"; key: string; command: string }
 | { type: "step_started"; id: string }
 | { type: "evidence"; evidence: Evidence }
 | { type: "check_failed"; evidence: Evidence }
 | { type: "step_completed"; id: string; commit: string; fingerprint: string }
 | { type: "reviewed"; review: Review }
 | { type: "verified"; fingerprint: string }
 // fingerprint: el contenido commiteado y limpio. retry no lo trae con el checkout sucio: ahí amend no puede.
 | { type: "retry"; reason: string; fingerprint?: string }
 | { type: "amend"; reason: string; fingerprint: string }
 | { type: "pause"; reason: string }
 // Sólo el host, desde /omi-work accept-risk y extra-round en la TUI: ninguna tool del modelo los emite.
 | { type: "risk_accepted"; fingerprint: string; findings: string[]; reason: string }
 | { type: "round_added"; reason: string }
 | { type: "resume" }
 | { type: "source_changed"; source: Workflow["source"] }
 | { type: "agreed"; quote: string; summary: string; replan: boolean; fingerprint?: string }
 // replaces: el hash del recibo pendiente que se renueva con otro cuerpo; sin él, un recibo distinto no se pisa.
 | { type: "publishing"; head: string; bodyHash: string; replaces?: string }
 | { type: "published"; head: string; url: string; number: number; stack?: { number: number; url: string }[] }
 | { type: "stack_synced"; stack: StackPull[] };

function requireCondition(condition: unknown, message: string): asserts condition {
 if (!condition) throw new Error(`Harness: ${message}`);
}
function nonempty(value: string): boolean { return typeof value === "string" && value.trim().length > 0; }
function validate(state: Workflow): WorkflowV2 { return parseWorkflow(JSON.stringify(state)); }

export function createWorkflow(source: Workflow["source"], checkout: Workflow["checkout"], id: string, at: string): WorkflowV2 {
 requireCondition(nonempty(at), "falta fecha");
 return validate({ version: 2, lifecycle: { status: "disabled" }, pullRequest: null, publicationFormat: 1, id, revision: 0, source: { ...source, hash: sourceHash(source.title, source.body) }, checkout: { ...checkout },
  phase: "explore", status: "active", blockedReason: "", activity: "Explorar el issue", exploration: null, inferences: [], recipe: null,
  diagnosis: null, spec: null, steps: [], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: null, publication: { status: "none" }, attempts: [], agreements: [], history: [] });
}

export function recipeApprovalHash(state: Workflow): string {
 return artifactHash({ source: state.source, recipe: state.recipe, spec: state.spec });
}
export function isApproved(state: Workflow): boolean {
 return state.recipe !== null && state.approval !== null && state.approval.sourceHash === state.source.hash
  && state.source.hash === sourceHash(state.source.title, state.source.body) && state.approval.recipeHash === recipeApprovalHash(state);
}
export function explorationBlock(exploration: Exploration | null): string {
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
 const stack = stackProblem(spec); requireCondition(!stack, stack);
 state.spec = spec;
 state.steps = spec.steps.map(s => ({ ...s, status: "pending", red: null, green: null, commit: null }));
 state.phase = "approve";
}
export function successful(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean { return evidence.exitCode === 0 && evidence.outcome === "passed"; }
// Único criterio de "falló de verdad": 126/127 son comando ausente o no ejecutable y >=128 es una señal.
export function expectedFailure(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean {
 return evidence.outcome === "failed" && evidence.exitCode !== null && evidence.exitCode >= 1 && evidence.exitCode <= 125;
}
// 126/127: el comando no existe o no es ejecutable; nunca corrió.
export function missingCommand(e: Pick<Evidence, "exitCode" | "outcome">): boolean { return e.outcome === "failed" && (e.exitCode === 126 || e.exitCode === 127); }
const EXHAUSTED = "Se agotaron las vueltas; se necesita intervención humana";
// Por lente y contenido: hasta 3 veredictos (pass/fail) y 10 corridas en total, contando
// cancelaciones y errores del proveedor (unknown), que no gastan veredictos.
const MAX_LENS_VERDICTS = 3; const MAX_LENS_RUNS = 10;
const SECURITY_FAILED = "un hallazgo blocker del lente de seguridad sobre este contenido bloquea Verificar; corregí el cambio con retry. Si no aplica, pausá con el motivo: sólo una persona acepta el riesgo, con /omi-work accept-risk";
const RISK_ACCEPTED_KEEP = "una persona aceptó el riesgo de seguridad de este contenido: seguí con verified. Corregir un aviso ahora cambiaría el contenido y su aceptación dejaría de valer; lo que queda va como aviso en el PR. Un D o un gate rojo sí se corrige con amend";
const ADVISORY_RETRY = "retry gasta una vuelta y sólo corresponde si security marcó un blocker, o si falló un D o un gate y ya no quedan amend. Los hallazgos de esta vuelta sólo avisan: corregilos con amend, que no gasta vuelta, o dejalos como aviso en el PR";
const AMEND_FIRST = "un D o un gate rojo sobre este contenido se corrige con amend, que no gasta vuelta: agrega un paso con rojo, verde y commit. retry queda para un blocker de security o para cuando ya no quedan amend en la vuelta";
// Un lente que falló no se vuelve a tirar sobre el mismo contenido, salvo que un refuter
// posterior apruebe: el aviso no se borra tirándolo de nuevo, y el blocker de security sin aceptar sigue bloqueando aunque el refuter apruebe.
export function lensRunBlock(state: Workflow, lens: Review["lens"], fingerprint: string): string {
 const same = (r: Review) => r.lens === lens && r.fingerprint === fingerprint;
 const runs = executionReviews(state).filter(same); const last = runs.at(-1);
 if (last?.verdict === "fail") {
  const after = state.reviews.slice(state.reviews.lastIndexOf(last) + 1);
  const holds = lens === "security" && unacceptedBlockers(state, last).length > 0;
  if (lens === "refuter" || holds || !after.some(r => r.lens === "refuter" && r.fingerprint === fingerprint && r.verdict === "pass")) return holds ? "El lente de seguridad ya falló sobre este contenido con un blocker y bloquea Verificar; corregí el cambio con retry; si no aplica, pausá para que una persona decida con /omi-work accept-risk" : `El lente ${lens} ya falló sobre este contenido; queda como aviso y no bloquea Verificar`;
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
 assertCorrectionExecution(state);
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
  requirePhase(state, "explore", "decide", "diagnose");
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
   // En Resolver inferencias se puede volver a explorar: también reproducir, por ejemplo tras preparar la base.
   requirePhase(state, "explore", "decide", "diagnose");
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
 assertCorrectionExecution(state);
 const evidence = executionEvidence(state), reviews = executionReviews(state);
 requireCondition(state.status === "active" && !decisionBlock(state), "hay un bloqueo pendiente");
 requireCondition(isApproved(state) && state.recipe && state.steps.length && state.steps.every(s => s.status === "done" && s.commit), "faltan pasos o aprobación");
 for (const c of state.recipe.cases) {
  const latest = evidence.findLast(e => e.kind === "verification" && e.caseId === c.id);
  requireCondition(latest && successful(latest) && latest.command === c.command && latest.fingerprint === fingerprint && (head === undefined || latest.head === head), `falta verificación actual del caso ${c.id}`);
 }
 // Los lentes asesoran: cada uno pedido corre sobre este contenido y su fail/unknown queda como aviso.
 // Sólo un blocker de security que ninguna persona aceptó bloquea. Tras amend, un pass limpio del contenido de partida sigue valiendo.
 for (const lens of state.recipe.lenses) {
  const review = lensReview(reviews, lens, fingerprint, amendsOf(state))?.review;
  requireCondition(review, `falta correr el lente ${lens} sobre este contenido`);
  requireCondition(review.verdict !== "pass" || review.findings.length === 0, `el lente ${lens} no puede aprobar con hallazgos`);
  requireCondition(lens !== "security" || !unacceptedBlockers(state, review).length, SECURITY_FAILED);
 }
 // Gates de la vuelta: vale su última corrida sobre este contenido o, si no se repitió después de un amend, la última que
 // juzgó (pasó o falló de verdad). Un comando ausente (126/127) nunca corrió y no cuenta; una interrumpida sólo cuenta
 // sobre este contenido. La guía de Verificar dice esta misma regla.
 const gates = evidence.filter(e => e.kind === "gate" && !missingCommand(e));
 for (const command of new Set(gates.map(e => e.command))) {
  const latest = gates.findLast(e => e.command === command && e.fingerprint === fingerprint) ?? gates.findLast(e => e.command === command && (successful(e) || expectedFailure(e)));
  requireCondition(!latest || successful(latest), `gate fallido: ${command.slice(0, 200)}: su última corrida de esta vuelta falló; repetilo sobre este contenido`);
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
 assertCorrectionExecution(state);
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
// Lo ya commiteado sigue hecho: no puede volver a dar rojo. Una corrección agrega un paso que cubre
// todos los D y exige su propio rojo, verde y commit.
function correctionStep(state: Workflow, title: string): void {
 const next = Math.max(0, ...state.steps.map(s => Number(/^C(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1;
 state.steps.push({ id: `C${next}`, title: title.slice(0, 4000), cases: state.recipe!.cases.map(c => c.id), status: "pending", red: null, green: null, commit: null });
 state.phase = "implement"; state.publication = { status: "none" };
}
// Una vuelta entera es para lo que amend no corrige: un blocker de security, o un D o un gate rojo sin amend en la vuelta.
// Con el contenido limpio vale la última corrida de cada check, como en amend: retry se rechaza con sólo avisos, si un amend
// alcanza o si lo que no pasó se vuelve a correr (interrumpido o comando ausente); cortado con el tope del host, cuenta como
// rojo. Sin fingerprint (checkout sucio), amend no puede y vale toda la vuelta. Los topes siguen pidiendo retry o refresh.
function retryBlock(state: WorkflowV2, fingerprint: string | undefined): string {
 const evidence = executionEvidence(state), reviews = executionReviews(state);
 const blocker = reviews.some(r => unacceptedBlockers(state, r).length > 0);
 let red = evidence.some(e => (e.kind === "verification" || e.kind === "gate") && !successful(e));
 if (fingerprint) {
  const latest = latestChecks(state, fingerprint), pending = latest.filter(e => !successful(e));
  if (latest.some(expectedFailure) && !amendBlock(state, fingerprint)) return AMEND_FIRST;
  red = latest.some(e => expectedFailure(e) || cappedTimeout(e));
  if (pending.length && !red && !blocker && !roundFull(state)) return notRedReason(pending);
 }
 // Con el riesgo aceptado, una vuelta entera borraría esa decisión de la persona.
 const accepted = reviews.some(r => riskAccepted(state, r));
 const advisory = accepted || reviews.some(r => r.lens === "security" ? r.verdict === "fail" && !securityBlocks(r) : r.verdict === "fail" || r.findings.length > 0);
 return advisory && !red && !blocker && !roundFull(state) ? (accepted ? RISK_ACCEPTED_KEEP : ADVISORY_RETRY) : "";
}
function retry(state: WorkflowV2, reason: string, fingerprint: string | undefined, at: string): void {
 requireCondition(state.version !== 2 || state.pullRequest?.ownership !== "adopted", "post-PR usa corrección propia; retry no puede borrar publication ni presupuesto");
 requirePhase(state, "verify", "pr"); requireCondition(nonempty(reason), "falta motivo del reintento");
 requireCondition(state.status === "active" && !decisionBlock(state) && state.recipe, "hay un bloqueo pendiente");
 const blocked = retryBlock(state, fingerprint); requireCondition(!blocked, blocked);
 if (state.round >= state.maxRounds) { setBlock(state, EXHAUSTED); return; }
 requireCondition(state.steps.length < MAX_STEPS, "no quedan pasos para otra vuelta; dividí la tarea");
 archiveAttempt(state, reason, at);
 state.round++; correctionStep(state, `Corrección de la vuelta ${state.round}: ${reason}`); clearRound(state);
 state.evidence = []; state.reviews = [];
 // La aprobación se conserva sólo para exactamente el mismo source/receta/spec.
 if (!isApproved(state)) state.approval = null;
 setBlock(state, state.approval ? "" : "Falta aprobación humana vigente");
}
// La última corrida de cada D y de cada gate sobre este contenido.
function latestChecks(state: Workflow, fingerprint: string): Evidence[] {
 const runs = executionEvidence(state).filter(e => e.fingerprint === fingerprint && (e.kind === "verification" || e.kind === "gate"));
 return [...new Map(runs.map(e => [`${e.kind}:${e.kind === "gate" ? e.command : e.caseId}`, e])).values()];
}
const roundFull = (state: Workflow): boolean => state.evidence.length >= MAX_EVIDENCE || state.reviews.length >= MAX_REVIEWS;
const MISSING_COMMAND = "el comando no existe o no es ejecutable (exit 126 o 127): no es un rojo del cambio. Si es un gate, corregí el comando (ese no cuenta como gate); si es un D de la receta, pausá con el motivo: hay que corregir la receta";
const RERUN = "el D o el gate quedó interrumpido (sin código, por señal o por timeout): no es un rojo del cambio; volvé a correrlo con el timeoutSeconds que sugiere OMI";
// Lo que no pasó sin ser un rojo (comando ausente o interrumpido), igual en amend y retry; con el tope, más tiempo no hay.
const notRedReason = (pending: readonly Evidence[]): string => pending.some(missingCommand) ? MISSING_COMMAND : RERUN;
const cappedTimeout = (e: Evidence): boolean => e.outcome === "interrupted" && e.exitCode === null && Date.parse(e.finishedAt) - Date.parse(e.startedAt) >= MAX_CHECK_TIMEOUT_SECONDS * 1000;
// Por qué amend no corre sobre este contenido, o "" si corre.
function amendBlock(state: WorkflowV2, fingerprint: string): string {
 if (state.status !== "active" || decisionBlock(state) || !state.recipe) return "hay un bloqueo pendiente";
 if (contentSecurityBlocks(state, executionReviews(state), fingerprint)) return "hay un blocker de security sobre este contenido: eso pide retry, no amend";
 const red = latestChecks(state, fingerprint).filter(e => !successful(e));
 const finding = executionReviews(state).some(r => r.fingerprint === fingerprint && !r.noResult && (r.verdict === "fail" || r.findings.length > 0));
 if (!finding && !red.some(expectedFailure)) {
  return red.length ? notRedReason(red) : "sobre este contenido no hay ningún hallazgo de un lente ni un D o un gate rojo que corregir con amend";
 }
 if (acceptedRisksOf(state).some(a => a.fingerprint === fingerprint) && !red.some(expectedFailure)) return RISK_ACCEPTED_KEEP;
 if ((state.amends ?? []).length >= MAX_AMENDS) return `ya se usaron las ${MAX_AMENDS} correcciones livianas de esta vuelta: un aviso queda en el PR y un D o un gate rojo pide retry`;
 if (roundFull(state)) return "la evidencia o los lentes de esta vuelta llegaron al tope: usá retry";
 return state.steps.length < MAX_STEPS ? "" : "no quedan pasos para otra corrección; dividí la tarea";
}
// Corrección liviana, sin gastar vuelta ni borrar evidencia: un D o un gate rojo, o un hallazgo de un lente que sólo avisa
// (también de security). Después se repiten los D, el gate rojo, security y los lentes que no aprobaron limpio; el resto
// vale desde el contenido de partida.
function amend(state: WorkflowV2, reason: string, fingerprint: string, at: string): void {
 requireCondition(state.pullRequest?.ownership !== "adopted", "post-PR usa corrección propia; amend no aplica");
 requirePhase(state, "verify", "pr"); requireCondition(nonempty(reason), "falta motivo de la corrección");
 requireCondition(nonempty(fingerprint), "falta el contenido que se corrige");
 const blocked = amendBlock(state, fingerprint); requireCondition(!blocked, blocked);
 state.amends = [...(state.amends ?? []), { from: fingerprint, reason: reason.slice(0, 4000), at }];
 correctionStep(state, `Corrección liviana: ${reason}`);
}
// Lo que vale sólo para esta vuelta: las correcciones livianas y los riesgos aceptados. Sin ellos, el campo no queda.
function clearRound(state: Workflow): void { if (state.version === 2) { delete state.amends; delete state.acceptedRisks; } }
// Lo que frena este contenido aunque una persona acepte el riesgo: un D o un gate rojo, o un blocker sin aceptar.
function contentBlocked(state: Workflow, fingerprint: string): boolean {
 return latestChecks(state, fingerprint).some(e => !successful(e) && !missingCommand(e)) || contentSecurityBlocks(state, executionReviews(state), fingerprint);
}
function sourceChanged(state: Workflow, source: Workflow["source"], at: string): void {
 requireCondition(source.number === state.source.number && source.url === state.source.url, "no se puede cambiar la identidad del issue");
 archiveAttempt(state, "Cambió el pedido o se volvió a explorar", at);
 state.source = { ...source, hash: sourceHash(source.title, source.body) };
 state.observations = [];
 state.exploration = null; state.inferences = []; state.recipe = null; state.diagnosis = null; state.spec = null;
 state.steps = []; state.evidence = []; state.reviews = []; state.approval = null; state.round = 0; state.grants = []; clearRound(state);
 state.publication = { status: "none" }; state.phase = "explore"; setBlock(state, "");
}
// El chat vale como autorización: el host ya verificó la cita. Con un cambio de alcance (replan) la
// receta se rehace y se vuelve a aprobar; exploración, respuestas, acuerdos y commits siguen valiendo.
function agree(state: Workflow, event: Extract<WorkflowEvent, { type: "agreed" }>, at: string): void {
 // Con las vueltas agotadas el acuerdo sólo se anota: rehacer la receta reiniciaría las vueltas sin una persona.
 requireCondition(!event.replan || !retriesExhausted(state), "se agotaron las vueltas y un acuerdo del chat no las reinicia. Registralo sin replan; para seguir, una persona usa /omi-work refresh");
 const agreements = state.agreements ?? [];
 if (!agreements.some(a => a.quote === event.quote && a.summary === event.summary && a.replan === event.replan)) {
  requireCondition(agreements.length < MAX_AGREEMENTS, "se llegó al tope de acuerdos del chat; dividí el trabajo");
  agreements.push({ quote: event.quote, summary: event.summary, replan: event.replan, phase: state.phase, at });
 }
 state.agreements = agreements;
 // Sin receta todavía, el agente la arma con el acuerdo: no hay nada que rehacer.
 // Los permisos de comandos (grants) se conservan: son por comando y por pedido, no por receta.
 if (!event.replan || !state.recipe) return;
 archiveAttempt(state, `Acuerdo del chat: ${event.summary}`, at);
 // El host manda fingerprint sólo con el checkout limpio: lo que cambió desde Explorar son los pasos commiteados, base de la receta nueva.
 if (state.exploration && event.fingerprint && ["implement", "verify", "pr"].includes(state.phase)) state.exploration.fingerprint = event.fingerprint;
 state.observations = (state.observations ?? []).filter(o => !["implement", "verify", "pr"].includes(o.phase));
 state.approval = null; state.spec = null; state.steps = []; state.evidence = []; state.reviews = []; state.round = 0; clearRound(state);
 state.publication = { status: "none" }; state.phase = "recipe"; setBlock(state, "");
}
// Con 0 retry, una persona suma una vuelta sin perder receta, aprobación, pasos ni evidencia. No reanuda una pausa.
function addRound(state: Workflow, reason: string): void {
 requireCondition(state.version !== 2 || state.pullRequest?.ownership !== "adopted", "post-PR usa corrección propia; no suma vueltas");
 requirePhase(state, "implement", "verify", "pr"); requireCondition(nonempty(reason), "falta el motivo de la vuelta extra");
 requireCondition(state.round >= state.maxRounds, `todavía quedan ${state.maxRounds - state.round} retry: no hace falta otra vuelta`);
 requireCondition(state.maxRounds < MAX_ROUNDS, `el tope es de ${MAX_ROUNDS} vueltas; para seguir, /omi-work refresh`);
 const exhausted = retriesExhausted(state); state.maxRounds++; if (exhausted) releaseExhausted(state);
}
// Quita el bloqueo de vueltas agotadas sin reanudar una pausa: eso lo decide resume.
function releaseExhausted(state: Workflow): void { if (state.status === "paused") state.blockedReason = ""; else setBlock(state, ""); }
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
 requireCondition(!review.noResult || review.verdict === "unknown", "un lente sin resultado sólo puede quedar unknown");
 requireCondition(!review.severities || (review.lens === "security" && !review.noResult && review.severities.length === review.findings.length), "las severidades son de security: una por hallazgo");
 state.reviews.push(review);
}
// La UI/adapter es la única autoridad que puede emitir approved, risk_accepted, round_added o autorizar una reproducción.
// Este reducer puro no ejecuta comandos, verifica Git ni obtiene consentimiento.
export function transition(original: WorkflowV2, event: WorkflowEvent, at: string): WorkflowV2;
export function transition(original: Workflow, event: WorkflowEvent, at: string): Workflow;
export function transition(original: Workflow, event: WorkflowEvent, at: string): WorkflowV2 {
 const state = validate(original);
 requireCondition(nonempty(at), "falta fecha");
 // Un cierre sin cambio lo decide el modelo; volver a leer el pedido es la salida humana.
 // Un stack abierto se sigue actualizando: sus PRs cambian y se mergean después de terminar el trabajo.
 requireCondition(state.status !== "complete" || state.phase === "closed" && event.type === "source_changed" || state.phase === "done" && event.type === "stack_synced", "el trabajo ya está cerrado");
 // Una persona decide también con el trabajo pausado: aceptar un riesgo o sumar una vuelta no lo reanudan.
 requireCondition(state.status !== "paused" || ["resume", "source_changed", "risk_accepted", "round_added"].includes(event.type), "el trabajo está pausado");
 if (state.status === "waiting" && retriesExhausted(state)) requireCondition(["pause", "resume", "source_changed", "agreed", "command_granted", "risk_accepted", "round_added"].includes(event.type), "se agotaron las vueltas");
 applyEvent(state, event, at);
 state.revision++;
 state.activity = ("reason" in event ? `${event.type}: ${event.reason}` : event.type).slice(0, 4000);
 state.history = [...state.history, { at, phase: state.phase, activity: state.activity }].slice(-MAX_HISTORY);
 return validate(state);
}
// Tabla de eventos: los helpers mantienen juntas las invariantes de cada artefacto.
function applyEvent(state: WorkflowV2, event: WorkflowEvent, at: string): void {
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
   state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), at, ...(event.by === "foundations" ? { by: "foundations" as const, ...(event.foundations ? { foundations: event.foundations } : {}) } : {}) };
   state.phase = "implement"; setBlock(state, ""); return;
  case "command_granted":
   requireCondition(nonempty(event.key) && nonempty(event.command), "falta el comando autorizado");
   if (!state.grants?.some(g => g.key === event.key)) state.grants = [...(state.grants ?? []), { key: event.key, command: event.command, at }].slice(-MAX_GRANTS);
   return;
  case "step_started": startStep(state, event.id); return;
  case "evidence": recordEvidence(state, event.evidence); return;
  case "check_failed": recordFailedCheck(state, event.evidence); return;
  case "step_completed": completeStep(state, event); return;
  case "reviewed": recordReview(state, event.review); return;
  case "verified": requirePhase(state, "verify"); verifiedEvidence(state, event.fingerprint); state.phase = "pr"; return;
  case "retry": retry(state, event.reason, event.fingerprint, at); return;
  case "amend": amend(state, event.reason, event.fingerprint, at); return;
  // Con las vueltas agotadas sólo por este blocker, aceptarlo las destraba.
  case "risk_accepted": requirePhase(state, "verify"); recordAcceptedRisk(state, executionReviews(state), event, at); if (retriesExhausted(state) && !contentBlocked(state, event.fingerprint)) releaseExhausted(state); return;
  case "round_added": addRound(state, event.reason); return;
  case "pause":
   requireCondition(nonempty(event.reason), "falta motivo de pausa");
   // El motivo de pausa queda en activity/history; un bloqueo previo no debe perderse.
   if (state.status !== "waiting") state.blockedReason = "";
   state.status = "paused"; return;
  case "resume":
   requireCondition(state.status === "paused", "el trabajo no está pausado");
   setBlock(state, resumeBlock(state)); return;
  case "source_changed": sourceChanged(state, event.source, at); return;
  case "agreed": agree(state, event, at); return;
  case "publishing": {
   requireCondition(state.version !== 2 || state.pullRequest?.ownership !== "adopted", "post-PR conserva identidad: corresponde push normal, no otro PR");
   requirePhase(state, "pr"); const latest = state.evidence.findLast(e => e.kind === "verification");
   requireCondition(latest, "falta verificación"); verifiedEvidence(state, latest.fingerprint, event.head);
   requireCondition(nonempty(event.bodyHash), "falta hash del cuerpo");
   if (state.publication.status === "pending") requireCondition(state.publication.head === event.head && state.publication.bodyHash === (event.replaces ?? event.bodyHash), "publicación pendiente distinta");
   else requireCondition(event.replaces === undefined, "no hay publicación pendiente que renovar");
   const stack = stackGroups(state) ? planStack(state, event.head) : undefined;
   state.publication = { status: "pending", head: event.head, bodyHash: event.bodyHash, at, ...(stack ? { stack } : {}) }; return;
  }
  case "published": {
   requirePhase(state, "pr"); requireCondition(state.publication.status === "pending" && state.publication.head === event.head, "head no coincide con publicación pendiente");
   const stack = openedStack(state.publication.stack, event);
   state.publication = { status: "opened", head: event.head, url: event.url, number: event.number, ...(stack ? { stack } : {}) };
   if (state.version === 2) state.pullRequest = { number: event.number, url: event.url, head: event.head, branch: state.checkout.branch, base: "main", ownership: "unadopted" };
   state.phase = "done"; state.status = "complete"; return;
  }
  case "stack_synced":
   requirePhase(state, "done"); requireCondition(state.publication.status === "opened", "no hay PRs publicados");
   state.publication.stack = syncedStack(state.publication.stack, event.stack); return;
  default: { const unhandled: never = event; throw new Error(`Evento desconocido: ${JSON.stringify(unhandled)}`); }
 }
}
