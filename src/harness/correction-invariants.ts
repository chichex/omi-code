// Integridad de rondas y límites de ejecución post-PR; no ejecuta Git ni interpreta hallazgos.
import type { WorkflowV2 } from "./model.ts";
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { sameData } from "./lifecycle-value.ts";
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Corrección: ${message}`); }
export function validateCorrectionFacts(s: EnabledLifecycle): void {
 const rounds = s.corrections ?? [];
 requireFact(new Set(rounds.map(r => r.operationId)).size === rounds.length && rounds.filter(r => r.status !== "pushed" && r.status !== "failed").length <= 1, "rondas duplicadas/simultáneas");
 for (const round of rounds) {
  const before = s.subjects.find(x => x.id === round.subjectId), op = s.operations.find(o => o.id === round.operationId);
  requireFact(before && (!op ? round.status === "planned" : op.kind === "correction" && op.subjectId === before.id), "ronda sin operación/sujeto coherente");
  requireFact(round.scopeSource !== "policy" || round.authorityHash, "scope policy sin autoridad host");
  for (const ref of round.findings) { const f = s.ledger.find(f => f.id === ref.id), observation = f?.observations[ref.sequence - 1]; requireFact(observation && observation.hash === ref.hash && observation.subjectId === before.id, "ronda con hallazgo/observación ajenos"); }
  if (round.status === "failed") requireFact(op?.status === "confirmed" && op.receipt.outcome === "failed", "ronda fallida sin resultado confirmado");
  if (round.status === "verified" || round.status === "pushed") {
   const after = s.subjects.find(x => x.id === round.newSubjectId);
   requireFact(after && after.number === before.number && after.branch === before.branch && after.base === before.base && after.headSha === round.head && after.contentHash === round.fingerprint && op?.status === "confirmed" && op.receipt.outcome === "succeeded" && op.receipt.verifiedSubjectId === after.id, "verificación de ronda no confirmada");
   if (round.status === "pushed") { const push = s.operations.find(o => o.id === round.pushOperationId); requireFact(push?.kind === "push" && push.subjectId === after.id && push.status === "confirmed" && push.receipt.outcome === "succeeded" && push.pushRequest?.correctionId === round.operationId, "push de ronda no confirmado"); }
  }
 }
 for (const op of s.operations) if (op.pushRequest) {
  const r = op.pushRequest, sub = s.subjects.find(x => x.id === op.subjectId), round = rounds.find(x => x.operationId === r.correctionId);
  const before = s.subjects.find(x => x.id === round?.subjectId);
  requireFact(op.kind === "push" && sub && before && round && (round.status === "verified" || round.status === "pushed") && round.newSubjectId === sub.id && r.repo === s.root.repo && r.pr === sub.number && r.branch === sub.branch && r.base === sub.base && r.head === sub.headSha && r.fingerprint === sub.contentHash && r.beforeHead === before.headSha && r.correlationId === op.correlationId, "request push de otra operación/PR/SHA");
 }
}
export function assertCorrectionContinuity(before: EnabledLifecycle, after: EnabledLifecycle): void {
 const rounds = after.corrections ?? [];
 requireFact(rounds.length >= (before.corrections ?? []).length, "no se borra historia de correcciones");
 for (const [index, old] of (before.corrections ?? []).entries()) {
  const next = rounds[index]; requireFact(next, "ronda perdida");
  const input = (r: typeof old) => [r.operationId, r.subjectId, r.findings, r.startHead, r.startFingerprint, r.scopeHash, r.scopeSource, r.authorityHash, r.evidenceOffset, r.reviewOffset, r.at];
  requireFact(sameData(input(old), input(next)), "input/ámbito de ronda reescrito");
  const order = { planned: 0, coding: 1, verified: 2, failed: 2, pushed: 3 };
  requireFact(order[next.status] >= order[old.status] && (old.status === "planned" || "stepId" in next && old.stepId === next.stepId), "ronda retrocedió o cambió C");
  if (old.status === "verified" || old.status === "pushed") requireFact((next.status === "verified" || next.status === "pushed") && old.newSubjectId === next.newSubjectId && old.head === next.head && old.fingerprint === next.fingerprint, "snapshot verificado reescrito");
  if (old.status === "pushed" || old.status === "failed") requireFact(sameData(old, next), "push confirmado reescrito");
 }
}
export function validateCorrectionWorkflow(w: WorkflowV2): void {
 if (w.pullRequest?.ownership !== "adopted") return;
 requireFact(w.lifecycle.status === "enabled" && w.publication.status === "opened" && w.publication.number === w.pullRequest.number && w.publication.url === w.pullRequest.url, "ownership sin identidad durable de PR");
 const subjects = w.lifecycle.subjects.filter(s => s.number === w.pullRequest?.number && s.branch === w.pullRequest.branch && s.base === w.pullRequest.base);
 requireFact(subjects.some(s => s.headSha === w.pullRequest?.head), "HEAD remoto sin sujeto conocido");
 for (const r of w.lifecycle.corrections ?? []) {
  requireFact(r.evidenceOffset <= w.evidence.length && r.reviewOffset <= w.reviews.length, "ámbito de evidencia/reviews fuera del estado");
  if (r.status !== "planned") requireFact(w.steps.some(s => s.id === r.stepId), "ronda sin paso C");
 }
}
export function preserveCorrectionWorkflow(before: WorkflowV2, after: WorkflowV2): void {
 if (before.pullRequest?.ownership !== "adopted") return;
 requireFact(sameData(before.publication, after.publication) && after.pullRequest?.ownership === "adopted" && sameData([before.pullRequest.number, before.pullRequest.url, before.pullRequest.branch, before.pullRequest.base], [after.pullRequest.number, after.pullRequest.url, after.pullRequest.branch, after.pullRequest.base]), "no se borra ni reemplaza identidad/publication del PR");
 requireFact(before.evidence.every((e, i) => sameData(e, after.evidence[i])) && before.reviews.every((r, i) => sameData(r, after.reviews[i])), "evidencia/reviews históricos no se borran ni reescriben");
 requireFact(before.steps.every((s, i) => s.status === "done" ? sameData(s, after.steps[i]) : after.steps[i]?.id === s.id && sameData(after.steps[i]?.cases, s.cases)), "C previos no se borran ni reescriben");
}
