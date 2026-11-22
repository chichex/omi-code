// Mutaciones OMI de host: enforce existente → gate vivo → claim durable → una llamada → sólo observación.
import { Value } from "typebox/value";
import { enforce } from "../guardrails/policy.ts";
import { assertVersion } from "../publish/version.ts";
import { runDeployment } from "../tools/deploy.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { parseWorkflow } from "./model.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { omiShipContext, omiRequest, type OmiShipDeps, type OmiShipContext } from "./omi-ship-context.ts";
import { PublicationInputSchema, OmiAttestationSchema, type OmiRequest } from "./omi-ship-schema.ts";
import { probeOmi } from "./omi-probes.ts";
import { revalidateOmiPublication } from "./omi-registry.ts";
export async function assertOmiVersionOrigin(c: OmiShipContext, deps: OmiShipDeps): Promise<void> {
 if (Value.Check(PublicationInputSchema, deps.publication) && deps.publication.version === deps.version && deps.publication.commitSha === c.integratedSha) {
  const pub = deps.publication;
  if (pub.kind === "endpoint") { const observed = await probeOmi(c, deps); lifecycleAssert(observed.commit === c.integratedSha && observed.version === deps.version && observed.probes.version === "pass", "endpoint no demuestra origen de versión"); return; }
  const publication = c.s.publications?.find(p => p.id === pub.id && p.version === deps.version && p.commitSha === c.integratedSha && p.digest === pub.digest && p.image === pub.image && p.destination.projectPath === c.destination.projectPath && p.destination.apiOrigin === c.destination.apiOrigin && p.destination.service === c.service.name);
  lifecycleAssert(publication, "falta recibo de publicación del mismo destino/SHA"); await revalidateOmiPublication(c, deps, publication); return;
 }
 const decision = c.s.decisions.find(d => d.id === c.op.decisionId);
 lifecycleAssert(Value.Check(OmiAttestationSchema, deps.attestation) && deps.attestation.subjectId === c.sub.id && deps.attestation.integratedSha === c.integratedSha && deps.attestation.version === deps.version && deps.attestation.targetId === c.target.id && decision?.source === "person", "versión sin origen: sólo vínculo humano explícito, no autonomía por SHA");
}
export function assertOmiPending(c: OmiShipContext, action: "publish" | "deploy" | "promote"): void {
 lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.kind === action && c.op.status === "pending" && !c.op.shipRequest && c.op.configHash === c.s.pinHash && c.sub.id === c.s.currentSubject && c.provider.mode !== "observe", "no hay operación OMI pending vigente o destino observe");
 lifecycleAssert(c.s.root.repo !== "chichex/omi-code" || action !== "publish", "omi-code no publica tags/releases ni HEAD a mano; sólo pipeline");
}
export async function claimOmi(original: unknown, operationId: string, request: OmiRequest, deps: OmiShipDeps): Promise<void> {
 if (deps.recordRequest) { await deps.recordRequest(request); return; }
 const expected = parseWorkflow(JSON.stringify(original)); lifecycleAssert(expected.lifecycle.status === "enabled", "lifecycle no esperado");
 const expectedOperation = expected.lifecycle.operations.find(o => o.id === operationId), expectedSubject = expected.lifecycle.subjects.find(s => s.id === request.subjectId);
 const store = deps.workflowStore; lifecycleAssert(store?.operationId === operationId, "falta store del claim OMI"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "falta trabajo durable");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const state = parseWorkflow(JSON.stringify(saved)); lifecycleAssert(state.lifecycle.status === "enabled" && state.status === "active" && state.lifecycle.stage === "ship", "OMI cambió durante permiso");
  const op = state.lifecycle.operations.find(o => o.id === operationId);
  lifecycleAssert(state.source.hash === expected.source.hash && sameData(state.recipe, expected.recipe) && sameData(state.approval, expected.approval) && sameData(state.lifecycle.subjects.find(s => s.id === request.subjectId), expectedSubject) && sameData(op, expectedOperation), "fuente/receta/aprobación/sujeto/operación cambió durante permiso");
  lifecycleAssert(op?.status === "pending" && !op.shipRequest && op.configHash === state.lifecycle.pinHash && op.correlationId === request.correlationId && op.subjectId === state.lifecycle.currentSubject && op.subjectId === request.subjectId && op.targetId === request.targetId, "claim OMI existente/obsoleto: observar, no replay");
  op.shipRequest = request; return { ...state, revision: state.revision + 1 };
 });
}
export async function recordOmiQueued(operationId: string, receipt: { mutationId: string; state: string }, deps: OmiShipDeps): Promise<void> {
 if (deps.recordQueued) { await deps.recordQueued(receipt); return; }
 const store = deps.workflowStore; lifecycleAssert(store?.operationId === operationId, "falta store del recibo OMI"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "trabajo perdido");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const state = parseWorkflow(JSON.stringify(saved)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle perdido"); const op = state.lifecycle.operations.find(o => o.id === operationId); lifecycleAssert(op?.shipRequest?.kind === "omi", "cola sin request OMI");
  if (!op.queued?.some(q => q.mutationId === receipt.mutationId)) op.queued = [...(op.queued ?? []), { ...receipt, at: new Date().toISOString() }];
  return { ...state, revision: state.revision + 1 };
 });
}
async function recordDeployment(c: OmiShipContext, id: string, deps: OmiShipDeps): Promise<void> {
 const receipt = { id, service: c.service.name, environment: c.provider.environment, version: deps.version };
 if (deps.recordDeployment) { await deps.recordDeployment(receipt); return; }
 const store = deps.workflowStore; lifecycleAssert(store?.operationId === c.op.id, "falta store deployment"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "trabajo perdido");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const state = parseWorkflow(JSON.stringify(saved)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle perdido"); const op = state.lifecycle.operations.find(o => o.id === c.op.id); lifecycleAssert(op?.shipRequest?.kind === "omi", "deployment sin claim");
  if (!op.deployments?.some(d => d.id === id)) op.deployments = [...(op.deployments ?? []), { ...receipt, at: new Date().toISOString() }];
  return { ...state, revision: state.revision + 1 };
 });
}
export async function deployOmiVersion(original: unknown, operationId: string, deps: OmiShipDeps) {
 assertVersion(deps.version); const c = await omiShipContext(original, operationId, deps); lifecycleAssert(c.op.kind === "deploy" || c.op.kind === "promote", "sólo deploy/promote"); assertOmiPending(c, c.op.kind);
 lifecycleAssert(c.view.versions.some(v => v.tag === deps.version), "versión no publicada"); await assertOmiVersionOrigin(c, deps);
 if (c.op.kind === "promote") lifecycleAssert(c.provider.environment === "prod" && c.environment.promotion?.version === deps.version && !c.environment.promotion.blocked_reason, "promoción bloqueada/versión stage no coincide");
 const request = omiRequest(c, c.op.kind, deps.version);
 await enforce({ operation: c.op.kind === "promote" ? "promote" : "deploy", environment: c.provider.environment, summary: `Lifecycle ${c.op.kind}: ${c.service.name} en ${c.provider.environment}`, diff: `${c.environment.current_version ?? "sin versión"} → ${deps.version} · commit ${c.integratedSha}` }, deps.runtime.guard);
 await deps.beforeMutation(request); c.signal.throwIfAborted();
 // Después de cualquier espera humana se relee destino/versión, no se hereda una autorización vieja.
 const fresh = await omiShipContext(original, operationId, { ...deps, signal: c.signal }); lifecycleAssert(sameData(c.destination, fresh.destination) && fresh.environment.current_version === c.environment.current_version && fresh.view.versions.some(v => v.tag === deps.version), "destino/current cambió durante confirmación");
 if (c.op.kind === "promote") lifecycleAssert(sameData(fresh.environment.promotion, c.environment.promotion) && fresh.environment.promotion?.version === deps.version && !fresh.environment.promotion.blocked_reason, "promoción cambió durante confirmación");
 await assertOmiVersionOrigin(fresh, deps);
 await claimOmi(original, operationId, request, deps); c.signal.throwIfAborted();
 try {
  const result = await runDeployment(c.scope, c.service.name, c.provider.environment, deps.version, { ...deps.runtime, signal: c.signal }, { idempotencyKey: request.idempotencyKey, onReceipt: receipt => recordOmiQueued(operationId, receipt, deps), onStarted: async started => {
   lifecycleAssert(started.service === c.service.name && started.environment === c.provider.environment && started.to_version === deps.version, "respuesta deployment de otro servicio/ambiente/versión"); await recordDeployment(c, started.id, deps);
  } });
  return { state: "confirmed", deployment: result.data, reason: "Deploy observado por core OMI; entrega requiere probes/provenance aparte" };
 } catch { return { state: "unknown", deployment: null, reason: "Mutación OMI incierta/fallida; conservar clave/recibo y observar sin reenviar" }; }
}
