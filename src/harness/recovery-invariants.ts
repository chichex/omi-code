// Validación también al leer disco y continuidad de baselines/recibos de recuperación.
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { sameData } from "./lifecycle-value.ts";
function fact(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Recovery: ${reason}`); }
export function validateRecoveryFacts(s: EnabledLifecycle): void {
 const baselines = s.recoveryBaselines ?? [], observations = s.recoveryObservations ?? [];
 fact(new Set(baselines.map(b => b.id)).size === baselines.length && new Set(observations.map(r => r.id)).size === observations.length, "IDs repetidos");
 for (const b of baselines) {
  fact(b.previousCommitSha === null || b.previousCommitSha !== b.integratedSha, "baseline previa contiene el propio merge fallido");
  const op = s.operations.find(o => o.id === b.beforeOperationId), sub = s.subjects.find(x => x.id === b.subjectId), config = s.pins.find(p => p.accepted.blockHash === b.configHash)?.accepted.block, target = config?.ship.targets.find(t => t.id === b.targetId);
  fact(op && sub?.mergedSha === b.integratedSha && op.subjectId === b.subjectId && op.targetId === b.targetId && op.configHash === b.configHash && target && target.provider.kind === b.kind, "previa de otra operación/sujeto/config");
  fact((target.evidence.health || target.evidence.version) && (!target.evidence.health || b.probes.health === "pass") && (!target.evidence.version || b.probes.version === "pass") && !Object.values(b.probes).some(p => ["fail", "unknown"].includes(p)), "previa sin salud/verificador");
  if (b.kind === "omi") fact(target.provider.kind === "omi" && b.destination.service === target.provider.service && b.destination.environment === target.provider.environment, "previa OMI de otro destino");
 }
 for (const op of s.operations) {
  const r = op.shipRequest;
  if (r?.kind === "omi" && r.action === "rollback") {
   const b = baselines.find(b => b.id === r.baselineId), d = s.deliveries?.find(d => d.id === r.failureDeliveryId), cfg = s.pins.find(p => p.accepted.blockHash === op.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === op.targetId);
   fact(op.kind === "rollback" && target?.onFailure.action === "rollback" && b?.kind === "omi" && b.subjectId === op.subjectId && b.targetId === op.targetId && b.configHash === op.configHash && b.integratedSha === r.integratedSha && b.previousVersion === r.version && sameData(b.destination, r.destination) && d?.result.state === "failed" && d.subjectId === op.subjectId && d.targetId === op.targetId, "claim rollback sin previa/fallo/destino enlazados");
  }
  if (op.recoveryRequest) {
   const r = op.recoveryRequest, b = baselines.find(b => b.id === r.baselineId), d = s.deliveries?.find(d => d.id === r.failureDeliveryId), cfg = s.pins.find(p => p.accepted.blockHash === op.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === op.targetId);
   fact(op.kind === "rollback" && r.operationId === op.id && target?.provider.kind === "gha" && target.provider.rollback && target.onFailure.action === "rollback" && b?.kind === "gha" && b.previousCommitSha === r.previousCommitSha && b.previousVersion === r.previousVersion && b.subjectId === op.subjectId && b.targetId === op.targetId && r.configHash === op.configHash && r.correlationId === op.correlationId && r.workflow.ref === target.provider.rollback.ref && r.workflow.path === `.github/workflows/${target.provider.rollback.workflow.replace(/^\.github\/workflows\//, "")}` && d?.result.state === "failed", "request GHA recovery ajeno/incompleto");
  }
 }
 for (const r of observations) {
  const op = s.operations.find(o => o.id === r.operationId), d = s.deliveries?.find(d => d.id === r.failureDeliveryId), proof = r.result.proof, b = baselines.find(b => b.id === proof?.baselineId);
  fact(op?.kind === "rollback" && op.subjectId === r.subjectId && op.targetId === r.targetId && op.configHash === r.configHash && d?.result.state === "failed" && d.subjectId === r.subjectId && d.targetId === r.targetId, "recibo sin fallo/operación causal");
  if (proof) fact(b && b.subjectId === r.subjectId && b.targetId === r.targetId && proof.subjectId === r.subjectId && proof.targetId === r.targetId && proof.operationId === r.operationId && proof.configHash === r.configHash && proof.integratedSha === b.integratedSha && proof.previousVersion === b.previousVersion && proof.previousCommitSha === b.previousCommitSha, "prueba de otra previa/sujeto");
  const cfg = s.pins.find(p => p.accepted.blockHash === r.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === r.targetId);
  if (proof) {
   fact(proof.failureDeliveryId === r.failureDeliveryId && b && proof.kind === `${b.kind}-rollback`, "prueba de otro fallo/proveedor");
   if (proof.kind === "omi-rollback") fact(b.kind === "omi" && sameData(proof.destination, b.destination) && op.shipRequest?.kind === "omi" && op.shipRequest.action === "rollback" && op.shipRequest.baselineId === b.id && op.shipRequest.failureDeliveryId === r.failureDeliveryId && op.deployments?.some(d => d.id === proof.deploymentId), "prueba OMI de otro destino/deployment/claim");
   if (proof.kind === "gha-rollback") fact(op.recoveryRequest && proof.repo === op.recoveryRequest.repo && proof.workflowSha === op.recoveryRequest.workflow.sha && proof.correlationId === op.recoveryRequest.correlationId, "prueba GHA de otra correlación/workflow/repo");
  }
  if (r.result.state === "recovered") fact(op.status === "confirmed" && op.receipt.outcome === "succeeded" && proof && target && (!target.evidence.health || proof.probes.health === "pass") && (!target.evidence.version || proof.probes.version === "pass") && !Object.values(proof.probes).some(p => ["fail", "unknown"].includes(p)) && Object.values(proof.probes).includes("pass"), "recuperado sin recibo/verificadores exigidos");
 }
}
export function assertRecoveryContinuity(before: EnabledLifecycle, after: EnabledLifecycle): void {
 for (const [old, next] of [[before.recoveryBaselines ?? [], after.recoveryBaselines ?? []], [before.recoveryObservations ?? [], after.recoveryObservations ?? []]] as const) fact(next.length >= old.length && old.every((item, index) => sameData(item, next[index])), "no borrar/reescribir baselines ni recibos");
 for (const op of before.operations) {
  const next = after.operations.find(o => o.id === op.id);
  if (op.recoveryRequest) fact(sameData(op.recoveryRequest, next?.recoveryRequest), "request recovery no se reemplaza");
  if (op.fixForwardRequest || op.fixForwardPush) fact(sameData(op.fixForwardRequest, next?.fixForwardRequest) && sameData(op.fixForwardPush, next?.fixForwardPush), "claim fix-forward no se reemplaza");
 }
}
