// Identidad OMI también se comprueba al leer estado: ni semver, ni tag ni un succeeded genérico son SHA.
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { sameData } from "./lifecycle-value.ts";
function fact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`OMI: ${message}`); }
export function validateOmiFacts(s: EnabledLifecycle): void {
 for (const op of s.operations) {
  const r = op.shipRequest; if (r?.kind !== "omi") { fact(!op.queued?.length && !op.deployments?.length, "cola/deployment sin request OMI"); continue; }
  const sub = s.subjects.find(x => x.id === op.subjectId), cfg = s.pins.find(p => p.accepted.blockHash === op.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === op.targetId);
  fact(sub?.mergedSha && target?.provider.kind === "omi" && r.repo === sub.repo && r.subjectId === sub.id && r.integratedSha === sub.mergedSha && r.targetId === target.id && r.configHash === op.configHash && r.correlationId === op.correlationId && r.idempotencyKey === op.correlationId && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.idempotencyKey), "request de otro sujeto/SHA/config/correlación");
  fact(r.destination.service === target.provider.service && r.destination.environment === target.provider.environment && (op.kind === "publish" && r.action === `publish-${target.provider.mode}` || op.kind === r.action), "request de otro servicio/ambiente/operación");
  fact((target.provider.mode !== "observe" || op.kind === "rollback" && target.onFailure.action === "rollback") && (s.root.repo !== "chichex/omi-code" || op.kind !== "publish"), "efecto prohibido en observe/omi-code");
  fact(new Set(op.queued?.map(q => q.mutationId) ?? []).size === (op.queued?.length ?? 0), "IDs de cola duplicados");
  fact(new Set(op.deployments?.map(d => d.id) ?? []).size === (op.deployments?.length ?? 0), "IDs deployment duplicados");
  for (const d of op.deployments ?? []) fact(["deploy", "promote", "rollback"].includes(r.action) && d.service === r.destination.service && d.environment === r.destination.environment && d.version === r.version, "deployment de otra mutación/destino/versión");
 }
 const publications = s.publications ?? [];
 fact(new Set(publications.map(p => p.id)).size === publications.length && new Set(publications.map(p => p.operationId)).size === publications.length, "recibos de publicación duplicados");
 for (const p of publications) {
  const op = s.operations.find(o => o.id === p.operationId), sub = s.subjects.find(x => x.id === p.subjectId), req = op?.shipRequest;
  fact(op?.kind === "publish" && op.status === "confirmed" && op.receipt.outcome === "succeeded" && req?.kind === "omi" && req.action === `publish-${p.via}` && req.version === p.version && op.subjectId === p.subjectId && op.targetId === p.targetId && op.configHash === p.configHash && sub?.mergedSha === p.commitSha && sameData(req.destination, p.destination), "publicación sin recibo/claim/SHA del destino");
 }
 for (const d of s.deliveries ?? []) {
  const p = d.result.proof; if (p?.kind !== "omi") continue;
  const sub = s.subjects.find(x => x.id === d.subjectId), cfg = s.pins.find(x => x.accepted.blockHash === d.configHash)?.accepted.block, target = cfg?.ship.targets.find(t => t.id === d.targetId);
  fact(target?.provider.kind === "omi" && p.destination.service === target.provider.service && p.destination.environment === target.provider.environment, "evidencia de otro servicio/ambiente");
  if (p.origin.kind === "endpoint") fact(target.evidence.kind === "omi" && target.evidence.version?.commitField === p.origin.field && p.origin.commitSha === sub?.mergedSha, "commit endpoint ajeno/no configurado");
  if (p.origin.kind === "publication") {
   const origin = p.origin, publication = publications.find(x => x.id === origin.publicationId);
   fact(publication && publication.commitSha === sub?.mergedSha && origin.commitSha === publication.commitSha && publication.version === p.version && publication.image === origin.image && publication.digest === origin.digest && publication.destination.apiOrigin === p.destination.apiOrigin && publication.destination.projectPath === p.destination.projectPath && publication.destination.service === p.destination.service, "publicación no demuestra origen en destino");
  }
  if (p.origin.kind === "attested") { const a = p.origin.attestation; fact(a.source === "person" && a.subjectId === sub?.id && a.targetId === target.id && a.integratedSha === sub.mergedSha && a.version === p.version, "atestiguación de otra persona/destino/SHA"); }
 }
 if (s.completion) {
  const completion = s.completion, attested = (s.deliveries ?? []).some(d => completion.evidenceIds.includes(d.id) && d.result.proof?.kind === "omi" && d.result.proof.origin.kind === "attested");
  fact((completion.outcome === "externally-attested") === attested || completion.outcome === "manual-attested" && !attested, "origen atestiguado no es entrega con origen demostrado");
 }
}
export function assertOmiContinuity(before: EnabledLifecycle, after: EnabledLifecycle): void {
 const next = after.publications ?? [], previous = before.publications ?? [];
 fact(next.length >= previous.length && previous.every((p, i) => sameData(p, next[i])), "no borrar/reescribir recibos de publicación");
 for (const op of before.operations) {
  const deployments = after.operations.find(o => o.id === op.id)?.deployments ?? []; fact(deployments.length >= (op.deployments?.length ?? 0) && (op.deployments ?? []).every((d, i) => sameData(d, deployments[i])), "no borrar/reescribir IDs de deployment");
  const queued = after.operations.find(o => o.id === op.id)?.queued ?? []; fact(queued.length >= (op.queued?.length ?? 0) && (op.queued ?? []).every((q, i) => sameData(q, queued[i])), "no borrar/reescribir IDs de cola"); }
}
