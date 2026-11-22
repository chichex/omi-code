// Baselines y recibos de recuperación append-only en la raíz única. Modelo/UI no emiten estos hechos.
import { Value } from "typebox/value";
import { parseWorkflow } from "./model.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { RecoveryBaselineSchema, RecoveryResultSchema, type RecoveryBaseline } from "./recovery-schema.ts";
import { confirmLifecycleOperation, markLifecycleUnknown } from "./lifecycle-state.ts";
export function recoveryCause(original: unknown, deliveryId: string, exceptOperation?: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && !state.lifecycle.completion, "trabajo completo/no recuperable");
 const s = state.lifecycle, config = currentLifecyclePin(s).accepted.block, d = s.deliveries?.find(d => d.id === deliveryId), sub = s.subjects.find(x => x.id === s.currentSubject), target = config.ship.targets.find(t => t.id === d?.targetId);
 lifecycleAssert(d && sub?.mergedSha && d.subjectId === sub.id && d.configHash === s.pinHash && d.result.state === "failed" && target && s.deliveries?.findLast(x => x.targetId === d.targetId && x.subjectId === sub.id)?.id === d.id, "fallo desconocido/obsoleto: reconciliar antes de recuperar");
 lifecycleAssert(!s.operations.some(o => o.id !== exceptOperation && o.subjectId === sub.id && o.targetId === target.id && ["ship", "publish", "deploy", "promote", "rollback", "fix-forward"].includes(o.kind) && o.status !== "confirmed"), "mutación pendiente/incierta puede pisar recuperación: observar antes, sin replay");
 const baseline = s.recoveryBaselines?.findLast(b => b.subjectId === sub.id && b.targetId === target.id && b.configHash === s.pinHash);
 return { state, s, config, d, sub, target, baseline };
}
export function recordRecoveryBaseline(original: unknown, observed: unknown) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && Value.Check(RecoveryBaselineSchema, observed), "baseline inválida"); const s = state.lifecycle, b = observed;
 lifecycleAssert(b.previousCommitSha === null || b.previousCommitSha !== b.integratedSha, "commit previo no puede ser el merge a recuperar");
 const old = s.recoveryBaselines?.find(x => x.id === b.id); if (old) { lifecycleAssert(sameData(old, b), "baseline no se reemplaza"); return state; }
 const op = s.operations.find(o => o.id === b.beforeOperationId), sub = s.subjects.find(x => x.id === b.subjectId), cfg = s.pins.find(p => p.accepted.blockHash === b.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === b.targetId);
 lifecycleAssert(state.status === "active" && s.stage === "ship" && sub?.mergedSha === b.integratedSha && s.currentSubject === sub.id && op?.status === "pending" && !op.shipRequest && !op.recoveryRequest && op.subjectId === sub.id && op.targetId === b.targetId && op.configHash === b.configHash && s.pinHash === b.configHash && target, "baseline debe preceder efecto del sujeto/destino actual");
 lifecycleAssert(!s.deliveries?.some(d => d.subjectId === sub.id && d.targetId === b.targetId) && !s.operations.some(o => o.subjectId === sub.id && o.targetId === b.targetId && (o.shipRequest || o.recoveryRequest)), "baseline tardía tras intento/efecto");
 lifecycleAssert((!!target.evidence.health || !!target.evidence.version) && !Object.values(b.probes).some(p => ["fail", "unknown"].includes(p)) && (!target.evidence.health || b.probes.health === "pass") && (!target.evidence.version || b.probes.version === "pass"), "sin previa sana/verificador conocido");
 s.recoveryBaselines = [...(s.recoveryBaselines ?? []), structuredClone(b)]; state.revision++; return parseWorkflow(JSON.stringify(state));
}
export function recordRecoveryVerification(original: unknown, operationId: string, failureDeliveryId: string, observed: unknown, at: string) {
 const c = recoveryCause(original, failureDeliveryId, operationId); lifecycleAssert(Value.Check(RecoveryResultSchema, observed), "resultado de recuperación inválido");
 const op = c.s.operations.find(o => o.id === operationId); lifecycleAssert(op?.kind === "rollback" && op.subjectId === c.sub.id && op.targetId === c.target.id && op.configHash === c.d.configHash, "recuperación de otra operación/destino");
 const proof = observed.proof;
 if (observed.state === "recovered") lifecycleAssert(proof && c.baseline && proof.baselineId === c.baseline.id && proof.integratedSha === c.sub.mergedSha && proof.previousVersion === c.baseline.previousVersion && proof.subjectId === c.sub.id && proof.operationId === op.id && proof.targetId === c.target.id && proof.configHash === op.configHash && !Object.values(proof.probes).some(p => ["fail", "unknown"].includes(p)) && (proof.probes.health === "pass" || proof.probes.version === "pass"), "recuperado requiere previa/verificador, no entrega del cambio");
 const old = c.s.recoveryObservations?.findLast(r => r.operationId === op.id); if (old && sameData(old.result, observed)) return c.state;
 const changed = observed.state === "unknown" ? markLifecycleUnknown(c.s, op.id, observed.reason, at) : confirmLifecycleOperation(c.s, { operationId: op.id, correlationId: op.correlationId, subjectId: op.subjectId, targetId: op.targetId, verifiedSubjectId: op.subjectId, externalId: proof?.kind === "omi-rollback" ? proof.deploymentId : proof?.kind === "gha-rollback" ? `run:${proof.runId}:${proof.runAttempt}` : `recovery:${op.correlationId}`, outcome: observed.state === "recovered" ? "succeeded" : "failed", at });
 changed.recoveryObservations = [...(changed.recoveryObservations ?? []), { id: `recovery:${op.id}:${(changed.recoveryObservations?.length ?? 0) + 1}`, operationId: op.id, subjectId: c.sub.id, targetId: c.target.id, configHash: op.configHash, failureDeliveryId, result: structuredClone(observed), at }];
 changed.stage = "paused"; c.state.status = "paused";
 c.state.lifecycle = changed; c.state.revision++; c.state.activity = observed.state === "recovered" ? "Servicio recuperado; merge no entregado" : "Recuperación fallida/incierta: detener y observar"; c.state.blockedReason = c.state.activity; return parseWorkflow(JSON.stringify(c.state));
}
export function rollbackBaseline(c: ReturnType<typeof recoveryCause>): RecoveryBaseline {
 lifecycleAssert(c.target.onFailure.action === "rollback" && c.baseline && (c.target.provider.kind === "omi" ? c.baseline.kind === "omi" : c.baseline.kind === "gha" && c.target.provider.rollback), "rollback sin capacidad/previa identificada"); return c.baseline;
}
