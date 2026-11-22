// Integridad del ledger Land: snapshots/claims/merge no se validan desde declaraciones del modelo.
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { dataHash, sameData } from "./lifecycle-value.ts";
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Land: ${message}`); }
export function landLedgerHash(s: EnabledLifecycle): string { return dataHash({ ledger: s.ledger, approvals: s.approvals, reviews: s.operations.filter(o => o.kind === "review") }); }
export function validateLandFacts(s: EnabledLifecycle): void {
 const snapshots = [...(s.readyHistory ?? []), ...(s.ready ? [s.ready] : [])];
 for (const ready of snapshots) {
  const sub = s.subjects.find(x => x.id === ready.subjectId), pin = s.pins.find(p => p.accepted.blockHash === ready.configHash);
  requireFact(sub && pin && ready.facts.repo === sub.repo && ready.facts.number === sub.number && ready.facts.headSha === sub.headSha && ready.facts.baseSha === sub.baseSha && ready.facts.contentHash === sub.contentHash, "snapshot de otro sujeto/config");
  const hash = dataHash({ subjectId: ready.subjectId, configHash: ready.configHash, sourceHash: ready.sourceHash, recipeHash: ready.recipeHash, ledgerHash: ready.ledgerHash, facts: ready.facts, risk: ready.risk });
  requireFact(ready.hash === hash && ready.risk.scopeHash === ready.recipeHash, "hash/riesgo del snapshot inválido");
 }
 for (const op of s.operations) if (op.readyRequest) {
  const r = op.readyRequest, sub = s.subjects.find(x => x.id === op.subjectId);
  requireFact(op.kind === "ready" && sub && r.repo === sub.repo && r.pr === sub.number && r.subjectId === sub.id && r.headSha === sub.headSha && r.baseSha === sub.baseSha && r.branch === sub.branch && r.base === sub.base && r.configHash === op.configHash && r.correlationId === op.correlationId, "request ready de otro PR/operación");
 }
 for (const op of s.operations) if (op.landRequest) {
  const r = op.landRequest, sub = s.subjects.find(x => x.id === op.subjectId), ready = snapshots.find(x => x.hash === r.snapshotHash), pin = s.pins.find(p => p.accepted.blockHash === op.configHash), decision = s.decisions.find(d => d.id === op.decisionId);
  requireFact(op.kind === "land" && sub && pin && ready && ready.subjectId === sub.id && r.subjectId === sub.id && r.repo === sub.repo && r.pr === sub.number && r.headSha === sub.headSha && r.baseSha === sub.baseSha && r.branch === sub.branch && r.base === sub.base && r.method === pin.accepted.block.land.method && r.base === pin.accepted.block.land.base && r.configHash === op.configHash && r.correlationId === op.correlationId && decision?.effectHash === r.snapshotHash, "request/decisión de otro PR/SHA/snapshot");
  requireFact(s.root.repo !== "chichex/omi-code" || decision.source === "person", "merge omi-code exige persona");
 }
 for (const merge of s.merges ?? []) {
  const before = s.subjects.find(x => x.id === merge.subjectId), after = s.subjects.find(x => x.id === merge.mergedSubjectId);
  requireFact(before && after && before.number === after.number && merge.pr === before.number && merge.repo === before.repo && merge.headSha === before.headSha && merge.base === before.base && after.headSha === before.headSha && after.mergedSha === merge.mergeSha, "hecho merge de otro sujeto/SHA");
  if (merge.source === "operation") { const op = s.operations.find(o => o.id === merge.operationId); requireFact(op?.kind === "land" && op.landRequest?.headSha === before.headSha && op.subjectId === before.id, "merge sin claim de la operación"); }
  else requireFact(merge.operationId === undefined, "observación externa no atribuye permiso/intento");
 }
}
export function assertLandContinuity(before: EnabledLifecycle, after: EnabledLifecycle): void {
 const prefix = (old: readonly unknown[], next: readonly unknown[]) => requireFact(old.length <= next.length && old.every((x, i) => sameData(x, next[i])), "historia de Land no se borra ni reescribe");
 prefix(before.readyHistory ?? [], after.readyHistory ?? []); prefix(before.merges ?? [], after.merges ?? []);
 if (before.ready) {
  if (before.ready.hash === after.ready?.hash) requireFact(sameData(before.ready, after.ready), "snapshot ready reescrito");
  else requireFact(after.readyHistory?.some(x => sameData(x, before.ready)), "ready previo perdido sin archivo");
 }
 for (const op of before.operations) if (op.readyRequest) requireFact(sameData(op.readyRequest, after.operations.find(x => x.id === op.id)?.readyRequest), "claim ready no se borra ni reescribe");
 for (const op of before.operations) if (op.landRequest) requireFact(sameData(op.landRequest, after.operations.find(x => x.id === op.id)?.landRequest), "claim Land no se borra ni reescribe");
}
