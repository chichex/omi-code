// Integridad de evidencia y finalización: succeeded genérico nunca basta para afirmar entrega.
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { sameData } from "./lifecycle-value.ts";
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Ship: ${message}`); }
export function validateShipFacts(s: EnabledLifecycle): void {
 for (const op of s.operations) if (op.shipRequest) {
  const r = op.shipRequest, sub = s.subjects.find(x => x.id === op.subjectId), cfg = s.pins.find(p => p.accepted.blockHash === op.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === op.targetId);
  requireFact(op.kind === "ship" && sub?.mergedSha && target?.provider.kind === "gha" && r.repo === sub.repo && r.pr === sub.number && r.subjectId === sub.id && r.integratedSha === sub.mergedSha && r.targetId === target.id && r.configHash === op.configHash && r.correlationId === op.correlationId && r.mode === target.provider.mode && r.workflow.ref === target.provider.ref && r.workflow.path === `.github/workflows/${target.provider.workflow.replace(/^\.github\/workflows\//, "")}` && r.kind === (target.evidence.kind === "github-release" ? "gha-release" : "gha-receipt"), "request de otro target/merge/config");
 }
 const deliveries = s.deliveries ?? []; requireFact(new Set(deliveries.map(d => d.id)).size === deliveries.length, "IDs de evidencia duplicados");
 for (const d of deliveries) {
  const op = s.operations.find(o => o.id === d.operationId), sub = s.subjects.find(x => x.id === d.subjectId), cfg = s.pins.find(p => p.accepted.blockHash === d.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === d.targetId), proof = d.result.proof;
  requireFact(op?.kind === "ship" && op.subjectId === d.subjectId && op.targetId === d.targetId && op.configHash === d.configHash && sub?.mergedSha && target, "evidencia de otra operación/destino");
  if (proof) {
   requireFact(proof.subjectId === sub.id && proof.operationId === op.id && proof.targetId === target.id && proof.configHash === op.configHash && proof.integratedSha === sub.mergedSha, "prueba de otro merge/destino");
   if (proof.kind === "github-release" || proof.kind === "gha-receipt") requireFact(proof.repo === s.root.repo, "prueba de otro repositorio");
   if (proof.kind === "gha-receipt") requireFact(proof.correlationId === op.correlationId && (!op.shipRequest || proof.workflowSha === op.shipRequest.workflow.sha && (op.shipRequest.mode !== "dispatch" || proof.providerCorrelationId === op.correlationId && proof.sourceSha === sub.mergedSha)), "recibo de otra correlación/workflow");
   if (proof.kind === "github-release") requireFact(target.evidence.kind === "github-release" && proof.assets.length === target.evidence.assets.length && new Set(proof.assets.map(a => a.id)).size === proof.assets.length && new Set(proof.assets.map(a => a.name)).size === proof.assets.length && target.evidence.assets.every(name => proof.assets.some(a => a.name === name)), "assets requeridos omitidos/duplicados");
   requireFact(proof.kind === "not-applicable" || proof.kind === "github-release" && target.evidence.kind === "github-release" || proof.kind === "gha-receipt" && target.evidence.kind === "receipt", "tipo de evidencia no corresponde a configuración");
  }
  if (d.result.state === "verified") requireFact(op.status === "confirmed" && op.receipt.outcome === "succeeded" && proof && proof.kind !== "not-applicable" && (!target.evidence.health || proof.probes.health === "pass") && (!target.evidence.version || proof.probes.version === "pass") && !Object.values(proof.probes).some(p => p === "fail" || p === "unknown"), "entrega sin recibo/probes verificados");
  if (d.result.state === "not-applicable") requireFact(op.status === "confirmed" && op.receipt.outcome === "not-applicable" && proof?.kind === "not-applicable", "no-aplica sin evidencia explícita");
 }
 const completion = s.completion;
 if (completion) {
  const sub = s.subjects.find(x => x.id === completion.subjectId), cfg = s.pins.find(p => p.accepted.blockHash === completion.configHash)?.accepted.block;
  requireFact(sub?.mergedSha === completion.integratedSha && cfg && cfg.ship.status !== "unconfigured", "finalización sin merge/config");
  if (cfg.ship.status === "configured") for (const target of cfg.ship.targets) {
   const d = deliveries.findLast(d => d.targetId === target.id && d.subjectId === sub?.id && d.configHash === completion.configHash);
   requireFact(d && ["verified", "not-applicable"].includes(d.result.state) && completion.evidenceIds.includes(d.id), "finalización con destino pendiente/fallido/rollback");
  }
  if (completion.outcome === "manual-attested") requireFact(cfg.ship.status === "manual" && completion.attestation.source === "person" && completion.attestation.subjectId === sub?.id && completion.attestation.integratedSha === sub.mergedSha && completion.attestation.configHash === completion.configHash, "manual sin declaración específica de persona");
  requireFact(completion.outcome !== "verified" || cfg.ship.status === "configured" && completion.evidenceIds.some(id => deliveries.find(d => d.id === id)?.result.state === "verified"), "verified no aplica a un vacío/manual");
  requireFact(s.stage === (completion.outcome === "verified" ? "delivered" : "complete"), "etapa final incoherente");
 }
}
export function assertShipContinuity(before: EnabledLifecycle, after: EnabledLifecycle): void {
 const deliveries = after.deliveries ?? [], previous = before.deliveries ?? [];
 requireFact(deliveries.length >= previous.length && previous.every((d, i) => sameData(d, deliveries[i])), "no borrar/reescribir evidencia anterior");
 for (const op of before.operations) if (op.shipRequest) requireFact(sameData(op.shipRequest, after.operations.find(o => o.id === op.id)?.shipRequest), "claim no se borra ni reescribe");
 if (before.completion) requireFact(sameData(before.completion, after.completion), "no reemplazar finalización verificada");
}
