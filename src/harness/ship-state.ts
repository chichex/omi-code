// Resultados Ship observados por host. Recuperar servicio no demuestra entregar el cambio.
import { Value } from "typebox/value";
import { parseWorkflow, MAX_HISTORY, type WorkflowV2 } from "./model.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { confirmLifecycleOperation, markLifecycleUnknown } from "./lifecycle-state.ts";
import { ShipVerificationSchema, ManualShipSchema } from "./ship-schema.ts";
export function recordShipVerification(original: unknown, operationId: string, result: unknown, at: string): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && Value.Check(ShipVerificationSchema, result), "resultado Ship inválido");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), sub = s.subjects.find(x => x.id === op?.subjectId), pin = s.pins.find(p => p.accepted.blockHash === op?.configHash), target = pin?.accepted.block.ship.targets.find(t => t.id === op?.targetId);
 lifecycleAssert(op?.kind === "ship" && sub?.mergedSha && target, "resultado de otra operación/destino/merge");
 const proof = result.proof;
 if (proof) lifecycleAssert(proof.subjectId === sub.id && proof.integratedSha === sub.mergedSha && proof.operationId === op.id && proof.targetId === target.id && proof.configHash === op.configHash, "prueba Ship de otro destino/sujeto/merge");
 lifecycleAssert(result.state !== "verified" || proof && proof.kind !== "not-applicable" && !Object.values(proof.probes).some(v => ["fail", "unknown"].includes(v)), "verified exige prueba y probes completos");
 lifecycleAssert(result.state !== "not-applicable" || proof?.kind === "not-applicable", "no-aplica requiere evidencia explícita");
 const previous = s.deliveries?.findLast(d => d.operationId === op.id); if (previous && sameData(previous.result, result)) return state;
 const externalId = proof?.kind === "github-release" ? `release:${proof.releaseId}:${proof.commitSha}` : proof?.kind === "gha-receipt" ? `run:${proof.runId}:${proof.runAttempt}` : `ship:${op.correlationId}`;
 let changed = result.state === "unknown" ? markLifecycleUnknown(s, op.id, result.reason || "Resultado Ship desconocido; observar sin replay", at)
  : confirmLifecycleOperation(s, { operationId: op.id, correlationId: op.correlationId, subjectId: op.subjectId, targetId: op.targetId, verifiedSubjectId: op.subjectId, externalId, outcome: result.state === "verified" ? "succeeded" : result.state === "not-applicable" ? "not-applicable" : "failed", at });
 changed.deliveries = [...(changed.deliveries ?? []), { id: `delivery:${op.id}:${(changed.deliveries ?? []).length + 1}`, subjectId: sub.id, targetId: target.id, operationId: op.id, configHash: op.configHash, result: structuredClone(result), at }];
 state.lifecycle = changed; state.revision++; state.activity = `Ship ${target.id}: ${result.state}; merge permanece hecho`;
 return parseWorkflow(JSON.stringify(state));
}
export function completeShip(original: unknown, at: string, explicit?: unknown): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no habilitado");
 const s = state.lifecycle, sub = s.subjects.find(x => x.id === s.currentSubject), config = currentLifecyclePin(s).accepted.block;
 lifecycleAssert(sub?.mergedSha && config.ship.status !== "unconfigured", "Ship no configurado o merge no observado; no es éxito");
 let outcome: "verified" | "externally-attested" | "not-applicable" | "manual-attested"; const evidenceIds: string[] = [];
 if (config.ship.status === "manual") {
  lifecycleAssert(Value.Check(ManualShipSchema, explicit) && explicit.subjectId === sub.id && explicit.integratedSha === sub.mergedSha && explicit.configHash === s.pinHash, "manual pendiente: falta declaración humana explícita del destino/merge"); outcome = "manual-attested";
 } else if (config.ship.status === "not-applicable") outcome = "not-applicable";
 else {
  lifecycleAssert(config.ship.targets.length > 0, "vacío no es entrega"); let verified = false, attested = false;
  for (const target of config.ship.targets) {
   const d = s.deliveries?.findLast(d => d.targetId === target.id && d.subjectId === sub.id && d.configHash === s.pinHash);
   lifecycleAssert(d && ["verified", "not-applicable"].includes(d.result.state), "falta verificar un destino actual; fallido/unknown/rollback no entrega"); evidenceIds.push(d.id); verified ||= d.result.state === "verified"; attested ||= d.result.proof?.kind === "omi" && d.result.proof.origin.kind === "attested";
  }
  outcome = attested ? "externally-attested" : verified ? "verified" : "not-applicable";
 }
 const completion = { subjectId: sub.id, integratedSha: sub.mergedSha, configHash: s.pinHash, evidenceIds, at };
 if (outcome === "manual-attested") { lifecycleAssert(Value.Check(ManualShipSchema, explicit), "falta declaración manual"); s.completion = { ...completion, outcome, attestation: structuredClone(explicit) }; }
 else s.completion = { ...completion, outcome };
 s.stage = outcome === "verified" ? "delivered" : "complete"; state.status = "complete"; state.phase = outcome === "verified" ? "delivered" : "ship";
 state.revision++; state.activity = outcome === "verified" ? "Entrega verificada en todos los destinos aplicables" : outcome === "not-applicable" ? "Lifecycle finalizado: Ship no aplica por evidencia/elección explícita" : "Entrega declarada manualmente por persona, no origen demostrado";
 state.history = [...state.history, { phase: state.phase, at, activity: state.activity }].slice(-MAX_HISTORY); return parseWorkflow(JSON.stringify(state));
}
