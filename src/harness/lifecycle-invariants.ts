// Invariantes del agregado: se aplican al leer disco, no sólo desde los reducers.
import { Value } from "typebox/value";
import { checkLifecycleConfig, lifecycleHash } from "./lifecycle-config.ts";
import { lifecycleKeyValid } from "./lifecycle-trust.ts";
import { LifecycleStateSchema, type LifecycleState, type EnabledLifecycle } from "./lifecycle-state-schema.ts";
import { dataHash, sameData } from "./lifecycle-value.ts";
export { dataHash, sameData } from "./lifecycle-value.ts";
import { validateCorrectionFacts, assertCorrectionContinuity } from "./correction-invariants.ts";
export function lifecycleAssert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Lifecycle: ${message}`); }
export const subjectIdentity = (s: EnabledLifecycle["subjects"][number]): string => JSON.stringify([s.repo, s.number, s.headSha, s.baseSha, s.contentHash, s.mergedSha]);
export function sourceKey(provider: string, externalId: string, operationId: string, subject: EnabledLifecycle["subjects"][number]): string {
 return JSON.stringify([provider, subject.repo, subject.number, externalId, provider === "github" ? null : operationId]);
}
function unique(values: string[], name: string): void { lifecycleAssert(new Set(values).size === values.length, `IDs duplicados: ${name}`); }
export function validateLifecycleState(value: unknown, root?: { workflowId: string; issue: number; repo: string }): LifecycleState {
 lifecycleAssert(Value.Check(LifecycleStateSchema, value), "estado durable inválido o incompleto");
 if (value.status === "disabled") return value;
 const s = value;
 if (root) lifecycleAssert(sameData(s.root, root), "identidad de raíz del lifecycle pertenece a otro workflow/issue/repo");
 unique(s.pins.map(p => p.accepted.blockHash), "pins");
 for (const pin of s.pins) {
  lifecycleAssert(lifecycleKeyValid(pin.key) && pin.key.repo === s.root.repo && pin.accepted.block.repo === s.root.repo, "identidad del pin ajena");
  lifecycleAssert("block" in checkLifecycleConfig(pin.accepted.block) && lifecycleHash(pin.accepted.block) === pin.accepted.blockHash, "hash/config del pin inválidos");
  lifecycleAssert(sameData(pin.key, s.pins[0]?.key), "el pin cambió de KB/producto/repo");
 }
 lifecycleAssert(s.pins.some(p => p.accepted.blockHash === s.pinHash), "falta el pin vigente");
 unique(s.subjects.map(x => x.id), "subjects"); unique(s.subjects.map(subjectIdentity), "snapshots");
 for (const subject of s.subjects) lifecycleAssert(subject.repo === s.root.repo, "sujeto de otro repo");
 const subject = (id: string) => { const found = s.subjects.find(x => x.id === id); lifecycleAssert(found, "referencia a sujeto inexistente"); return found; };
 if (s.currentSubject !== null) subject(s.currentSubject);
 unique(s.operations.map(x => x.id), "operations"); unique(s.operations.map(x => x.correlationId), "correlations"); unique(s.decisions.map(x => x.id), "decisions");
 unique(s.segments.map(x => x.id), "segments"); unique(s.ledger.map(x => x.id), "findings"); unique(s.ledger.map(x => x.key), "finding keys"); unique(s.evidence.map(x => x.id), "evidence");
 const operation = (id: string) => { const found = s.operations.find(x => x.id === id); lifecycleAssert(found, "referencia a operación inexistente"); return found; };
 const effectKey = (o: EnabledLifecycle["operations"][number]) => JSON.stringify([o.kind, subjectIdentity(subject(o.subjectId)), o.targetId]);
 for (const [index, op] of s.operations.entries()) {
  subject(op.subjectId);
  const pin = s.pins.find(p => p.accepted.blockHash === op.configHash); lifecycleAssert(pin, "config de operación inexistente");
  const d = s.decisions.find(d => d.id === op.decisionId);
  lifecycleAssert(d && d.kind === op.kind && d.subjectId === op.subjectId && d.targetId === op.targetId && d.configHash === op.configHash, "decisión ajena a la operación");
  if (op.targetId !== null) lifecycleAssert(pin.accepted.block.ship.targets.some(t => t.id === op.targetId), "destino de operación inexistente");
  if (op.providerRequest) {
   const req = op.providerRequest, sub = subject(op.subjectId), provider = pin.accepted.block.review.provider;
   lifecycleAssert(op.kind === "review" && req.repo === s.root.repo && req.pr === sub.number && req.headSha === sub.headSha && req.baseSha === sub.baseSha && req.correlationId === op.correlationId, "request de otra operación/sujeto");
   if ("provider" in req) lifecycleAssert(req.provider === "local" && provider.kind === "local" && req.contentHash === sub.contentHash, "request local de otra config/contenido");
   else lifecycleAssert(provider.kind === "gha" && req.workflow.ref === provider.ref && req.workflow.path === `.github/workflows/${provider.workflow.replace(/^\.github\/workflows\//, "")}` && Number.isFinite(Date.parse(req.createdAfter)), "request GHA de otra configuración");
  }
  const previous = s.operations.slice(0, index).findLast(old => effectKey(old) === effectKey(op));
  if (previous) lifecycleAssert(previous.status === "confirmed" && previous.receipt.outcome === "failed" && op.retryOf === previous.id, "efecto duplicado/pendiente/incierto o retry no enlazado");
  else lifecycleAssert(op.retryOf === null, "retry referencia otro efecto");
  lifecycleAssert(op.history[0]?.status === "pending" && op.history.at(-1)?.status === op.status, "historial de operación incoherente");
  lifecycleAssert(op.status === "confirmed" || op.history.length < 1000, "historial sin espacio reservado para recibo terminal");
  if (op.status === "confirmed") {
   lifecycleAssert(op.receipt.operationId === op.id && op.receipt.correlationId === op.correlationId && op.receipt.subjectId === op.subjectId && op.receipt.targetId === op.targetId, "recibo de otra operación/sujeto/correlación");
   if (op.receipt.verifiedSubjectId !== null) subject(op.receipt.verifiedSubjectId);
  }
 }
 lifecycleAssert(s.budget.attemptsUsed === s.operations.length, "contador de intentos incoherente");
 lifecycleAssert(s.budget.roundsUsed === s.operations.filter(o => o.kind === "correction").length, "contador de rondas incoherente");
 lifecycleAssert(s.budget.fixForwardPRsUsed === s.operations.filter(o => o.kind === "fix-forward").length, "contador fix-forward incoherente");
 lifecycleAssert(s.segments.filter(x => x.mode !== "closed").length <= 1, "hay actividades superpuestas");
 for (const segment of s.segments) lifecycleAssert(segment.chargedMilliseconds <= segment.elapsedMilliseconds, "tiempo activo incoherente");
 lifecycleAssert(s.budget.activeMilliseconds === s.segments.reduce((n, segment) => n + segment.chargedMilliseconds, 0), "contador de tiempo activo incoherente");
 for (const e of s.evidence) { subject(e.subjectId); const op = operation(e.operationId); lifecycleAssert(op.status === "confirmed" && op.receipt.outcome === "succeeded" && (op.receipt.verifiedSubjectId ?? op.subjectId) === e.subjectId, "evidencia sin resultado confirmado del sujeto"); }
 for (const f of s.ledger) {
  for (const [index, observation] of f.observations.entries()) {
   lifecycleAssert(observation.sequence === index + 1, "secuencia de observaciones incoherente");
   const { hash, at: _at, sequence: _sequence, ...content } = observation; const sub = subject(observation.subjectId); const op = operation(observation.operationId);
   lifecycleAssert(op.kind === "review" && op.subjectId === sub.id && hash === dataHash(content), "procedencia/hash de hallazgo inválidos");
   lifecycleAssert(f.key === sourceKey(observation.provider, observation.externalId, observation.operationId, sub), "identidad externa del hallazgo cambió");
  }
  for (const d of f.dispositions) {
   subject(d.subjectId); lifecycleAssert(d.findingId === f.id && f.observations[d.observationSequence - 1]?.hash === d.observationHash, "disposición de otro hallazgo/observación");
   for (const id of d.evidenceIds) {
    const e = s.evidence.find(e => e.id === id); lifecycleAssert(e && e.subjectId === d.subjectId && e.outcome === "pass", "evidencia ausente, obsoleta o no aprobada");
    lifecycleAssert(d.status === "corrected" ? e.kind === "verification" : d.status === "refuted-with-evidence" && e.kind === "refutation", "clase de evidencia no acredita la disposición");
   }
  }
 }
 validateCorrectionFacts(s);
 for (const collection of [s.checks, s.approvals]) { unique(collection.map(x => x.id), "checks/aprobaciones"); for (const item of collection) subject(item.subjectId); }
 return value;
}
/** Escrow del estado completo, también durante callbacks/observaciones concurrentes. */
export function lifecycleReceiptReserveBytes(s: LifecycleState): number {
 if (s.status === "disabled") return 0;
 return s.operations.reduce((bytes, op) => bytes + (op.status === "pending" ? 65536 : op.status === "unknown" ? 32768 : 0), 0)
  + (s.segments.some(segment => segment.mode !== "closed") ? 8192 : 0);
}
function prefix(previous: readonly unknown[], next: readonly unknown[], name: string): void {
 lifecycleAssert(next.length >= previous.length && previous.every((item, index) => sameData(item, next[index])), `no se borra ni reescribe historia: ${name}`);
}
/** Defensa adicional del store: refresh/replan o un callback no pueden reiniciar la raíz. */
export function assertLifecycleContinuity(before: LifecycleState, after: LifecycleState): void {
 if (before.status === "disabled") return;
 lifecycleAssert(after.status === "enabled" && sameData(before.root, after.root), "no se deshabilita ni reinicia el lifecycle inicializado");
 assertCorrectionContinuity(before, after);
 prefix(before.pins, after.pins, "pins"); prefix(before.subjects, after.subjects, "subjects"); prefix(before.decisions, after.decisions, "decisions"); prefix(before.evidence, after.evidence, "evidence"); prefix(before.checks, after.checks, "checks"); prefix(before.approvals, after.approvals, "approvals");
 lifecycleAssert(after.operations.length >= before.operations.length, "no se borra el journal");
 for (const [index, old] of before.operations.entries()) {
  const next = after.operations[index]; lifecycleAssert(next, "operación perdida");
  const immutable = (op: typeof old) => [op.id, op.key, op.kind, op.subjectId, op.targetId, op.correlationId, op.retryOf, op.configHash, op.decisionId];
  lifecycleAssert(sameData(immutable(old), immutable(next)), "identidad de operación reescrita"); prefix(old.history, next.history, "journal history");
  if (old.pushRequest) lifecycleAssert(sameData(old.pushRequest, next.pushRequest), "request push reclamado no se borra ni reescribe");
  if (old.providerRequest) lifecycleAssert(sameData(old.providerRequest, next.providerRequest), "request fijado antes del efecto no se borra ni reescribe");
  if (old.status === "confirmed") lifecycleAssert(sameData(old, next), "recibo confirmado reescrito");
  if (old.status === "unknown") lifecycleAssert(next.status !== "pending", "unknown no vuelve a pending");
 }
 lifecycleAssert(after.ledger.length >= before.ledger.length && after.segments.length >= before.segments.length, "no se recorta ledger/actividad");
 for (const [index, old] of before.ledger.entries()) {
  const next = after.ledger[index]; lifecycleAssert(next && old.id === next.id && old.key === next.key, "identidad de hallazgo reescrita");
  prefix(old.observations, next.observations, "observaciones"); prefix(old.dispositions, next.dispositions, "disposiciones");
 }
 for (const [index, old] of before.segments.entries()) {
  const next = after.segments[index]; lifecycleAssert(next && next.id === old.id && next.owner === old.owner && next.elapsedMilliseconds >= old.elapsedMilliseconds && next.chargedMilliseconds >= old.chargedMilliseconds, "actividad reescrita o consumo reiniciado");
  if (old.mode === "closed") lifecycleAssert(sameData(old, next), "actividad cerrada no se reabre");
  else {
   const charge = old.mode === "active" ? next.elapsedMilliseconds - old.elapsedMilliseconds : 0;
   lifecycleAssert(next.chargedMilliseconds - old.chargedMilliseconds === charge, "consumo de tiempo incoherente: cada entrada/salida de espera debe ser durable");
  }
 }
}
