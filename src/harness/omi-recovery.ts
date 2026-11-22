// Rollback OMI = redeploy anterior por core/guardrails. No promueve el merge fallido a delivered.
import { Value } from "typebox/value";
import { enforce } from "../guardrails/policy.ts";
import { runDeployment } from "../tools/deploy.ts";
import { assertVersion } from "../publish/version.ts";
import { DeploymentsSchema } from "../client/views.ts";
import { environmentPath } from "../tools/scope.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { omiShipContext, omiRequest, type OmiShipDeps, type OmiShipContext } from "./omi-ship-context.ts";
import { probeOmi } from "./omi-probes.ts";
import { RecoveryBaselineSchema, RecoveryProofSchema, type RecoveryBaseline, type RecoveryResult } from "./recovery-schema.ts";
import { recoveryCause, rollbackBaseline } from "./recovery-state.ts";
import { claimOmi, recordOmiQueued, recordOmiDeployment } from "./omi-operation.ts";
import { reconcileOmiOperation } from "./omi-reconcile.ts";
export async function captureOmiRecoveryBaseline(original: unknown, operationId: string, deps: OmiShipDeps): Promise<{ state: "ready" | "unknown"; baseline: RecoveryBaseline | null }> {
 try {
  const c = await omiShipContext(original, operationId, deps), env = c.environment, last = env.last_deployment;
  lifecycleAssert(c.op.status === "pending" && !c.op.shipRequest && !c.s.deliveries?.some(d => d.targetId === c.target.id && d.subjectId === c.sub.id), "baseline tardía");
  lifecycleAssert(env.current_version && env.current_version !== deps.version && last?.status === "exitoso" && last.service === c.service.name && last.environment === c.provider.environment && last.to_version === env.current_version, "previa no identificada/sana"); assertVersion(env.current_version);
  const observed = await probeOmi(c, { ...deps, version: env.current_version }, { commit: null });
  lifecycleAssert((observed.probes.health === "pass" || observed.probes.version === "pass") && !Object.values(observed.probes).some(v => ["fail", "unknown"].includes(v)), "previa sin verificador/salud");
  const baseline = { id: `baseline:${c.op.id}`, beforeOperationId: c.op.id, subjectId: c.sub.id, targetId: c.target.id, configHash: c.op.configHash, integratedSha: c.integratedSha, previousVersion: env.current_version, probes: observed.probes, at: new Date().toISOString(), kind: "omi", destination: c.destination, previousCommitSha: observed.commit, previousDeploymentId: last.id };
  lifecycleAssert(Value.Check(RecoveryBaselineSchema, baseline), "baseline OMI inválida"); return { state: "ready", baseline };
 } catch { return { state: "unknown", baseline: null }; }
}
async function observe(c: OmiShipContext, deliveryId: string, b: Extract<RecoveryBaseline, { kind: "omi" }>, deps: OmiShipDeps, id: string | undefined): Promise<RecoveryResult> {
 lifecycleAssert(id && c.environment.current_version === b.previousVersion, "sin deployment identificado/current previo"); const rows = await c.scope.client.request("GET", `${environmentPath(c.scope, c.service.name, c.provider.environment)}/deployments`, DeploymentsSchema, { signal: c.signal });
 lifecycleAssert(rows.deployments.length <= 1000 && !rows.deployments.some(d => d.id !== id && d.status === "en_curso"), "historial incompleto/otra mutación en curso"); const matching = rows.deployments.filter(d => d.id === id), d = matching[0];
 lifecycleAssert(matching.length === 1 && d?.id === id && d.service === c.service.name && d.environment === c.provider.environment && d.to_version === b.previousVersion && d.status === "exitoso", "rollback deployment incompleto/ajeno");
 const observed = await probeOmi(c, { ...deps, version: b.previousVersion }, { commit: b.previousCommitSha });
 const proof = { kind: "omi-rollback", subjectId: c.sub.id, targetId: c.target.id, operationId: c.op.id, baselineId: b.id, failureDeliveryId: deliveryId, configHash: c.op.configHash, integratedSha: c.integratedSha, previousVersion: b.previousVersion, previousCommitSha: b.previousCommitSha, destination: c.destination, deploymentId: d.id, probes: observed.probes };
 lifecycleAssert(Value.Check(RecoveryProofSchema, proof), "prueba rollback OMI inválida"); const values = Object.values(observed.probes);
 return { state: values.some(p => p === "fail") ? "failed" : values.some(p => p === "unknown") || !values.includes("pass") ? "unknown" : "recovered", proof, reason: "Verificación de versión/commit previos y servicio; no entrega del merge" };
}
async function assertRemoteQuiescent(c: OmiShipContext): Promise<void> {
 const response = await c.scope.client.request("GET", `${environmentPath(c.scope, c.service.name, c.provider.environment)}/deployments`, DeploymentsSchema, { signal: c.signal });
 lifecycleAssert(response.deployments.length <= 1000 && !response.deployments.some(d => !["exitoso", "fallido"].includes(d.status)), "deployment remoto concurrente/en curso/desconocido: no compensar");
}
export async function rollbackOmiVersion(original: unknown, operationId: string, deps: OmiShipDeps): Promise<RecoveryResult> {
 const c = await omiShipContext(original, operationId, deps); lifecycleAssert(c.op.kind === "rollback", "sólo rollback OMI");
 const recorded = c.op.shipRequest; const deliveryId = recorded?.kind === "omi" ? recorded.failureDeliveryId : c.s.deliveries?.findLast(d => d.subjectId === c.sub.id && d.targetId === c.target.id)?.id;
 lifecycleAssert(deliveryId, "falta fallo causal"); const cause = recoveryCause(original, deliveryId, operationId), b = rollbackBaseline(cause);
 lifecycleAssert(b.kind === "omi" && sameData(b.destination, c.destination) && c.view.versions.some(v => v.tag === b.previousVersion), "previa/destino cambió o ya no existe");
 const request = { ...omiRequest(c, "rollback", b.previousVersion), baselineId: b.id, failureDeliveryId: deliveryId };
 if (recorded) {
  lifecycleAssert(sameData(recorded, request), "request rollback cambió; no replay");
  try {
   const reconciled = await reconcileOmiOperation(original, operationId, deps);
   if (reconciled.state === "confirmed" && reconciled.receipt?.outcome === "failed") return { state: "failed", proof: null, reason: `Deployment rollback ${reconciled.receipt.externalId} falló de forma confirmada; no reenviar` };
   return await observe(await omiShipContext(original, operationId, { ...deps, signal: c.signal }), deliveryId, b, deps, reconciled.receipt?.outcome === "succeeded" ? reconciled.receipt.externalId : undefined);
  }
  catch { return { state: "unknown", proof: null, reason: "Rollback reclamado: observar deployment/cola, nunca reenviar" }; }
 }
 await assertRemoteQuiescent(c);
 lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && c.op.configHash === c.s.pinHash && c.sub.id === c.s.currentSubject, "rollback no vigente");
 await enforce({ operation: "deploy", environment: c.provider.environment, summary: `Recuperar ${c.service.name} en ${c.provider.environment}`, diff: `${c.environment.current_version ?? "sin versión"} → previa ${b.previousVersion}; merge ${c.integratedSha} seguirá no entregado` }, deps.runtime.guard);
 await deps.beforeMutation(request); c.signal.throwIfAborted();
 const fresh = await omiShipContext(original, operationId, { ...deps, signal: c.signal }); lifecycleAssert(sameData(c.destination, fresh.destination) && c.environment.current_version === fresh.environment.current_version && fresh.view.versions.some(v => v.tag === b.previousVersion), "rollback cambió durante permiso");
 await assertRemoteQuiescent(fresh);
 await claimOmi(original, operationId, request, deps);
 try {
  let id: string | undefined;
  await runDeployment(c.scope, c.service.name, c.provider.environment, b.previousVersion, { ...deps.runtime, signal: c.signal }, { idempotencyKey: request.idempotencyKey, onReceipt: receipt => recordOmiQueued(operationId, receipt, deps), onStarted: async d => {
   lifecycleAssert(d.service === c.service.name && d.environment === c.provider.environment && d.to_version === b.previousVersion, "deployment rollback ajeno"); id = d.id; await recordOmiDeployment(c, id, { ...deps, version: b.previousVersion });
  } });
  return await observe(await omiShipContext(original, operationId, { ...deps, signal: c.signal }), deliveryId, b, deps, id);
 } catch { return { state: "unknown", proof: null, reason: "Rollback incierto/fallido: conservar claim/cola/deployment; no repetir" }; }
}
