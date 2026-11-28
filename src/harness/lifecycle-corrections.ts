// Transiciones host post-PR: no reutilizan retry ni descartan publicación, evidencia o presupuesto.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseWorkflow, MAX_STEPS, MAX_HISTORY, type WorkflowV2 } from "./model.ts";
import { isApproved, recipeApprovalHash, successful } from "./state.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { unacceptedBlockers } from "./security-blockers.ts";
import { initializeLifecycle, bindLifecycleSubject, confirmLifecycleOperation, registerLifecycleEvidence, disposeLifecycleFinding } from "./lifecycle-state.ts";
import { SubjectSchema, AdoptionSchema, type EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { CorrectionProposalSchema, type CorrectionRound } from "./correction-schema.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
function requireCurrentGroup(s: EnabledLifecycle, round: CorrectionRound): void {
 for (const ref of round.findings) {
  const f = s.ledger.find(f => f.id === ref.id), o = f?.observations.at(-1), d = f?.dispositions.at(-1);
  lifecycleAssert(o && o.hash === ref.hash && o.sequence === ref.sequence && f?.dispositions.length === ref.dispositionSequence && d?.status === "accepted" && d.subjectId === round.subjectId, "cambió disposición/observación del grupo: requiere nueva validación humana");
 }
}
function finish(state: WorkflowV2, activity: string, at: string): WorkflowV2 {
 state.revision++; state.activity = activity; state.history = [...state.history, { phase: state.phase, at, activity }].slice(-MAX_HISTORY); return parseWorkflow(JSON.stringify(state));
}
export function adoptPostPrWorkflow(original: unknown, pin: unknown, input: unknown, observedAdoption: unknown, publication?: { head: string; number: number; revision: number }): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(Value.Check(SubjectSchema, input) && Value.Check(AdoptionSchema, observedAdoption), "adopción/sujeto inválidos");
 lifecycleAssert(state.publication.status === "opened" && state.pullRequest?.ownership === "unadopted" && state.phase === "done" && state.status === "complete" && isApproved(state), "sólo un draft finalizado propio puede adoptarse");
 if (observedAdoption.source === "publication" && state.lifecycle.status === "disabled" && publication) {
  lifecycleAssert(publication.revision === state.revision && publication.head === state.pullRequest.head && publication.number === state.pullRequest.number, "la publicación fresca cambió; no se adopta");
  const initialized = initializeLifecycle({ workflowId: state.id, issue: state.source.number, repo: input.repo }, pin);
  const entry = initialized.pins[0]?.accepted.block.continuity?.entry;
  lifecycleAssert(entry === "auto" || entry === "ask", "entrada de continuidad no habilitada explícitamente");
  state.lifecycle = initialized;
 }
 lifecycleAssert(observedAdoption.source === "person" || observedAdoption.source === "publication" && state.lifecycle.status === "enabled", "histórico exige adopción humana explícita; restaurar no adopta");
 lifecycleAssert(!input.mergedSha && input.number === state.pullRequest.number && input.headSha === state.pullRequest.head && input.branch === state.checkout.branch && input.base === state.pullRequest.base && lifecycleRef(input.branch), "ownership/HEAD/PR/base ajenos o ya mergeados");
 const lifecycle = state.lifecycle.status === "enabled" ? state.lifecycle : initializeLifecycle({ workflowId: state.id, issue: state.source.number, repo: input.repo }, pin);
 state.lifecycle = bindLifecycleSubject(lifecycle, input, observedAdoption); state.pullRequest = { ...state.pullRequest, ownership: "adopted" };
 // Adoptar deja atrás el motivo de una pausa de entrada: lo que sigue es otra etapa.
 delete state.continuityPause;
 state.phase = "review"; state.status = "active"; state.blockedReason = ""; return finish(state, "PR adoptado explícitamente para lifecycle", observedAdoption.at);
}
function current(original: unknown) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted" && state.status === "active" && isApproved(state), "falta trabajo/PR adoptado y receta aprobada");
 const lifecycle = state.lifecycle, subject = lifecycle.subjects.find(s => s.id === lifecycle.currentSubject);
 lifecycleAssert(subject && !subject.mergedSha && subject.number === state.pullRequest.number && subject.branch === state.checkout.branch && subject.base === state.pullRequest.base, "sujeto ajeno/mergeado; después del merge requiere nuevo PR");
 return { state, lifecycle, subject };
}
export function preparePostPrCorrection(original: unknown, input: unknown): WorkflowV2 {
 const { state, lifecycle, subject } = current(original); lifecycleAssert(Value.Check(CorrectionProposalSchema, input), "propuesta host inválida");
 lifecycleAssert(state.phase === "review" && lifecycle.stage === "review" && state.steps.every(s => s.status === "done") && !(lifecycle.corrections ?? []).some(r => r.status !== "pushed" && r.status !== "failed"), "hay una corrección pendiente o no corresponde");
 // El riesgo bajo lo exige la política (el evaluador aislado). El sí de una persona acepta el riesgo de la receta, pero no
 // un alcance nuevo (2026-11-25: una receta de riesgo alto no podía corregirse ni con el sí de la persona).
 lifecycleAssert(input.scope.withinScope && input.scope.scopeHash === recipeApprovalHash(state) && (input.scope.source === "person" || input.scope.risk === "low" && !!input.scope.authorityHash), "nuevo alcance/riesgo o falta validación de alcance: requiere humano");
 const pin = lifecycle.pins.find(p => p.accepted.blockHash === lifecycle.pinHash); lifecycleAssert(pin && lifecycle.budget.roundsUsed < pin.accepted.block.corrections.maxRounds, "rondas post-PR agotadas");
 lifecycleAssert(state.steps.length < MAX_STEPS && !(lifecycle.corrections ?? []).some(r => r.operationId === input.operationId), "sin espacio o ID de corrección reutilizado");
 const findings = input.findingIds.map(id => {
  const finding = lifecycle.ledger.find(f => f.id === id), observation = finding?.observations.at(-1), disposition = finding?.dispositions.at(-1);
  const op = lifecycle.operations.find(o => o.id === observation?.operationId);
  lifecycleAssert(finding && observation && observation.subjectId === subject.id && disposition?.status === "accepted" && disposition.subjectId === subject.id && disposition.observationHash === observation.hash && disposition.observationSequence === observation.sequence && op?.status === "confirmed", "hallazgo ajeno/obsoleto/no validado o requiere humano");
  return { id, hash: observation.hash, sequence: observation.sequence, dispositionSequence: finding.dispositions.length };
 });
 const failed = lifecycle.corrections?.findLast(r => r.status === "failed");
 lifecycle.corrections = [...(lifecycle.corrections ?? []), { startHead: failed?.status === "failed" ? failed.failedHead : subject.headSha, startFingerprint: failed?.status === "failed" ? failed.failedFingerprint : subject.contentHash, operationId: input.operationId, subjectId: subject.id, findings, scopeHash: input.scope.scopeHash, scopeSource: input.scope.source, ...(input.scope.authorityHash ? { authorityHash: input.scope.authorityHash } : {}), evidenceOffset: state.evidence.length, reviewOffset: state.reviews.length, at: input.at, status: "planned" }];
 lifecycle.stage = "corrections"; return finish(state, "Hallazgos agrupados y validados; falta autorización independiente de corrección", input.at);
}
export function activatePostPrCorrection(original: unknown, operationId: string, at: string): WorkflowV2 {
 const { state, lifecycle, subject } = current(original), index = lifecycle.corrections?.findIndex(r => r.operationId === operationId) ?? -1;
 const round = lifecycle.corrections?.[index], op = lifecycle.operations.find(o => o.id === operationId);
 lifecycleAssert(round?.status === "planned" && round.subjectId === subject.id && round.scopeHash === recipeApprovalHash(state) && lifecycle.stage === "corrections" && op?.kind === "correction" && op.status === "pending" && op.subjectId === subject.id && op.configHash === lifecycle.pinHash, "falta reserva correction pending vigente");
 lifecycleAssert(state.steps.length < MAX_STEPS && !state.steps.some(s => s.status !== "done"), "pasos previos pendientes");
 requireCurrentGroup(lifecycle, round);
 const next = Math.max(0, ...state.steps.map(s => Number(/^C(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1, stepId = `C${next}`;
 lifecycleAssert(state.recipe && lifecycle.corrections, "falta receta/ronda");
 state.steps.push({ id: stepId, title: `Corrección post-PR #${subject.number} · ronda ${lifecycle.budget.roundsUsed}`, cases: state.recipe.cases.map(c => c.id), status: "pending", red: null, green: null, commit: null });
 lifecycle.corrections[index] = { ...round, status: "coding", stepId }; state.phase = "implement"; return finish(state, "Corrección autorizada: exige rojo, verde, commit y verificación nueva", at);
}
const VerifiedGitSchema = Type.Object({ clean: Type.Boolean(), ancestor: Type.Boolean() }, { additionalProperties: false });
export function verifyPostPrCorrection(original: unknown, operationId: string, input: unknown, observedGit: unknown, at: string): WorkflowV2 {
 const { state, lifecycle, subject } = current(original); lifecycleAssert(Value.Check(SubjectSchema, input) && Value.Check(VerifiedGitSchema, observedGit), "snapshot Git de corrección inválido");
 const index = lifecycle.corrections?.findIndex(r => r.operationId === operationId) ?? -1, round = lifecycle.corrections?.[index];
 lifecycleAssert(round?.status === "coding" && round.scopeHash === recipeApprovalHash(state) && state.phase === "pr" && observedGit.clean && observedGit.ancestor, "falta verificar código actual/ancestría limpia");
 requireCurrentGroup(lifecycle, round);
 lifecycleAssert(input.number === subject.number && input.repo === subject.repo && input.branch === subject.branch && input.base === subject.base && input.baseSha === subject.baseSha && input.headSha !== round.startHead && input.contentHash !== round.startFingerprint && !input.mergedSha, "sin progreso, HEAD/base ajeno o PR mergeado");
 const step = state.steps.find(s => s.id === round.stepId), fresh = state.evidence.slice(round.evidenceOffset);
 lifecycleAssert(step?.status === "done" && step.commit === input.headSha && step.red && step.green && fresh.some(e => e.id === step.red && e.kind === "red") && fresh.some(e => e.id === step.green && e.kind === "green" && successful(e)), "falta TDD/commit propio de corrección");
 lifecycleAssert(state.recipe?.cases.every(c => { const evidence = fresh.findLast(e => e.kind === "verification" && e.caseId === c.id); return evidence && successful(evidence) && evidence.command === c.command && evidence.head === input.headSha && evidence.fingerprint === input.contentHash; }), "faltan todos los D actuales después de corregir");
 let changed = bindLifecycleSubject(lifecycle, input, { id: `correction:${operationId}`, source: "correction", at });
 const op = changed.operations.find(o => o.id === operationId); lifecycleAssert(op?.status === "pending" && changed.corrections, "ronda/operación ya finalizada");
 changed = confirmLifecycleOperation(changed, { operationId, correlationId: op.correlationId, subjectId: op.subjectId, targetId: null, verifiedSubjectId: input.id, externalId: `commit:${input.headSha}`, outcome: "succeeded", at });
 changed = registerLifecycleEvidence(changed, { id: `verification:${operationId}`, subjectId: input.id, operationId, kind: "verification", outcome: "pass", at });
 for (const finding of round.findings) changed = disposeLifecycleFinding(changed, { findingId: finding.id, subjectId: input.id, observationHash: finding.hash, status: "corrected", evidenceIds: [`verification:${operationId}`], reason: "TDD y todos los D verificados sobre el commit de corrección", at });
 lifecycleAssert(changed.corrections, "ronda perdida"); changed.corrections[index] = { ...round, status: "verified", newSubjectId: input.id, head: input.headSha, fingerprint: input.contentHash };
 state.lifecycle = changed; return finish(state, "Corrección verificada; falta permiso de push independiente al mismo PR", at);
}
export function retryPostPrCorrection(original: unknown, operationId: string, observed: unknown, reason: string, at: string): WorkflowV2 {
 const { state, lifecycle } = current(original), index = lifecycle.corrections?.findIndex(r => r.operationId === operationId) ?? -1, round = lifecycle.corrections?.[index];
 const snapshot = Type.Object({ head: Type.String(), fingerprint: Type.String(), clean: Type.Boolean() }, { additionalProperties: false });
 lifecycleAssert(round?.status === "coding" && state.phase === "verify" && Value.Check(snapshot, observed) && observed.clean && reason.trim().length > 0, "retry post-PR sólo tras commit y fallo observado");
 const step = state.steps.find(s => s.id === round.stepId), op = lifecycle.operations.find(o => o.id === operationId);
 lifecycleAssert(step?.status === "done" && step.commit === observed.head && op?.status === "pending", "falta commit/reserva de la corrección");
 const checks = state.evidence.slice(round.evidenceOffset).filter(e => ["verification", "gate"].includes(e.kind) && e.head === observed.head && e.fingerprint === observed.fingerprint);
 const failed = checks.some(e => !successful(e)) || state.reviews.slice(round.reviewOffset).some(r => r.fingerprint === observed.fingerprint && unacceptedBlockers(state, r).length > 0);
 lifecycleAssert(failed, "no hay fallo de D/gate/seguridad observado");
 let changed = confirmLifecycleOperation(lifecycle, { operationId, correlationId: op.correlationId, subjectId: op.subjectId, targetId: null, verifiedSubjectId: null, externalId: `verification-failed:${observed.head}`, outcome: "failed", at });
 lifecycleAssert(changed.corrections, "ronda perdida"); changed.corrections[index] = { ...round, status: "failed", failedHead: observed.head, failedFingerprint: observed.fingerprint, reason: reason.slice(0, 256) };
 changed.stage = "review"; state.lifecycle = changed; state.phase = "review";
 return finish(state, "Verificación falló: ronda consumida, historial/PR intactos; requiere otra corrección autorizada", at);
}
