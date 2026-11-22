// Reducers puros post-PR. Sus hechos los emite el host: no se registran como acciones del modelo.
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { LifecycleRootSchema, LifecyclePinSchema, SubjectSchema, AdoptionSchema, IntentSchema, DecisionSchema, ReceiptSchema, EvidenceFactSchema, FindingInputSchema, DispositionSchema, type EnabledLifecycle, type LifecycleIntent } from "./lifecycle-state-schema.ts";
import { validateLifecycleState, lifecycleAssert, dataHash, sameData, sourceKey, subjectIdentity } from "./lifecycle-invariants.ts";
import { lifecycleBudgetBlock, assertLifecycleDecision } from "./lifecycle-budget.ts";
export { lifecycleBudgetBlock } from "./lifecycle-budget.ts";
export type { EnabledLifecycle, LifecycleIntent, LifecycleReceipt, LifecycleDecision } from "./lifecycle-state-schema.ts";
function checked<S extends TSchema>(schema: S, value: unknown): Static<S> { lifecycleAssert(Value.Check(schema, value), "hecho host inválido/incompleto"); return structuredClone(value); }
function enabled(value: unknown): EnabledLifecycle { const state = validateLifecycleState(value); lifecycleAssert(state.status === "enabled", "lifecycle deshabilitado"); return structuredClone(state); }
const finish = (state: EnabledLifecycle): EnabledLifecycle => enabled(state);
export function initializeLifecycle(root: unknown, pin: unknown): EnabledLifecycle {
 const accepted = checked(LifecyclePinSchema, pin);
 return finish({ status: "enabled", root: checked(LifecycleRootSchema, root), pins: [accepted], pinHash: accepted.accepted.blockHash,
  stage: "review", currentSubject: null, subjects: [], decisions: [], operations: [],
  budget: { attemptsUsed: 0, fixForwardPRsUsed: 0, roundsUsed: 0, activeMilliseconds: 0 }, segments: [], ledger: [], evidence: [], checks: [], approvals: [] });
}
export function bindLifecycleSubject(original: unknown, input: unknown, adoption: unknown): EnabledLifecycle {
 const s = enabled(original); const sub = checked(SubjectSchema, input); const fact = checked(AdoptionSchema, adoption);
 lifecycleAssert(sub.repo === s.root.repo, "sujeto de otro repositorio");
 const existing = s.subjects.find(x => x.id === sub.id);
 if (existing) {
  const { adoption: _adoption, ...snapshot } = existing; lifecycleAssert(sameData(snapshot, sub), "sujeto cambió sin nueva identidad");
 } else {
  const knownPRs = new Set(s.subjects.map(x => x.number));
  lifecycleAssert(!knownPRs.size || knownPRs.has(sub.number) || knownPRs.size <= s.operations.filter(o => o.kind === "fix-forward" && o.status === "confirmed" && o.receipt.outcome === "succeeded").length, "nuevo PR sin fix-forward reservado y confirmado");
  s.subjects.push({ ...sub, adoption: fact });
 }
 s.currentSubject = sub.id;
 return finish(s);
}
export function applyLifecyclePin(original: unknown, input: unknown): EnabledLifecycle {
 const s = enabled(original); const pin = checked(LifecyclePinSchema, input);
 lifecycleAssert(sameData(pin.key, s.pins[0]?.key), "no se cambia identidad KB/producto/repo");
 const previous = s.pins.find(p => p.accepted.blockHash === pin.accepted.blockHash);
 if (!previous) s.pins.push(pin);
 s.pinHash = pin.accepted.blockHash; return finish(s);
}
function effectKey(s: EnabledLifecycle, op: LifecycleIntent): string {
 const sub = s.subjects.find(x => x.id === op.subjectId); lifecycleAssert(sub, "sujeto inexistente");
 return JSON.stringify([op.kind, subjectIdentity(sub), op.targetId]);
}
export function reserveLifecycleOperation(original: unknown, input: unknown, observedDecision: unknown, owner: string, at: string): EnabledLifecycle {
 const s = enabled(original); const intent = checked(IntentSchema, input); const decision = checked(DecisionSchema, observedDecision);
 const block = lifecycleBudgetBlock(s, intent, owner); lifecycleAssert(!block, block);
 assertLifecycleDecision(s, intent, decision);
 lifecycleAssert(!s.operations.some(o => o.id === intent.id || o.correlationId === intent.correlationId), "operación/correlación duplicada o pendiente");
 lifecycleAssert(!s.decisions.some(d => d.id === decision.id), "la decisión ya acredita otro intento");
 const prior = s.operations.findLast(o => effectKey(s, o) === effectKey(s, intent));
 if (prior) lifecycleAssert(prior.status === "confirmed" && prior.receipt.outcome === "failed" && intent.retryOf === prior.id, "efecto pendiente/incierto/duplicado: reconciliar antes de repetir");
 else lifecycleAssert(intent.retryOf === null, "retry de otro efecto");
 s.decisions.push(decision);
 s.operations.push({ ...intent, configHash: s.pinHash, decisionId: decision.id, status: "pending", history: [{ status: "pending", at }] });
 s.budget.attemptsUsed++;
 if (intent.kind === "correction") s.budget.roundsUsed++;
 if (intent.kind === "fix-forward") s.budget.fixForwardPRsUsed++;
 return finish(s);
}
function operationBase(op: EnabledLifecycle["operations"][number]) {
 return { id: op.id, key: op.key, kind: op.kind, subjectId: op.subjectId, targetId: op.targetId, correlationId: op.correlationId, retryOf: op.retryOf, configHash: op.configHash, decisionId: op.decisionId, history: op.history, ...(op.providerRequest ? { providerRequest: op.providerRequest } : {}) };
}
export function confirmLifecycleOperation(original: unknown, observed: unknown): EnabledLifecycle {
 const s = enabled(original); const receipt = checked(ReceiptSchema, observed); const index = s.operations.findIndex(o => o.id === receipt.operationId); const op = s.operations[index];
 lifecycleAssert(op, "recibo de operación inexistente");
 lifecycleAssert(op.correlationId === receipt.correlationId && op.subjectId === receipt.subjectId && op.targetId === receipt.targetId, "recibo de otra correlación/sujeto/destino");
 if (op.status === "confirmed") {
  const { at: _oldAt, ...old } = op.receipt; const { at: _newAt, ...next } = receipt;
  lifecycleAssert(sameData(old, next), "recibo confirmado conflictivo"); return s;
 }
 s.operations[index] = { ...operationBase(op), status: "confirmed", receipt, history: [...op.history, { status: "confirmed", at: receipt.at }] };
 return finish(s);
}
export function markLifecycleUnknown(original: unknown, id: string, reason: string, at: string): EnabledLifecycle {
 const s = enabled(original); const index = s.operations.findIndex(o => o.id === id); const op = s.operations[index];
 lifecycleAssert(op && op.status !== "confirmed", "no se pierde un recibo confirmado");
 if (op.status === "unknown" && op.reason === reason) return s;
 lifecycleAssert(op.history.length < 999, "historial lleno: se reserva una entrada para el recibo terminal");
 s.operations[index] = { ...operationBase(op), status: "unknown", reason, history: [...op.history, { status: "unknown", at }] }; return finish(s);
}
export function beginLifecycleActivity(original: unknown, id: string, owner: string): EnabledLifecycle {
 const s = enabled(original);
 lifecycleAssert(!s.segments.some(x => x.mode !== "closed" || x.id === id), "actividad abierta/interrumpida o ID reutilizado; reconciliar antes de continuar");
 s.segments.push({ id, owner, mode: "active", elapsedMilliseconds: 0, chargedMilliseconds: 0 }); return finish(s);
}
/** elapsed es monotónico del proceso propietario, nunca tiempo de pared desde el último arranque. */
export function checkpointLifecycleActivity(original: unknown, id: string, owner: string, elapsed: number, mode: "active" | "human-wait" | "closed"): EnabledLifecycle {
 const s = enabled(original); const segment = s.segments.find(x => x.id === id);
 lifecycleAssert(segment && segment.owner === owner, "actividad de otro proceso; requiere reconciliación host");
 lifecycleAssert(Number.isSafeInteger(elapsed) && elapsed >= segment.elapsedMilliseconds, "reloj/checkpoint atrasado o inválido");
 if (segment.mode === "closed") { lifecycleAssert(elapsed === segment.elapsedMilliseconds && mode === "closed", "actividad cerrada no se reabre ni modifica"); return s; }
 const charged = segment.mode === "active" ? elapsed - segment.elapsedMilliseconds : 0;
 segment.elapsedMilliseconds = elapsed; segment.chargedMilliseconds += charged; segment.mode = mode; s.budget.activeMilliseconds += charged;
 return finish(s);
}
export function registerLifecycleEvidence(original: unknown, observed: unknown): EnabledLifecycle {
 const s = enabled(original); const fact = checked(EvidenceFactSchema, observed); const old = s.evidence.find(e => e.id === fact.id);
 if (old) { lifecycleAssert(sameData(old, fact), "evidencia reescrita"); return s; }
 s.evidence.push(fact); return finish(s);
}
export function ingestLifecycleFinding(original: unknown, observed: unknown): EnabledLifecycle {
 const s = enabled(original); const input = checked(FindingInputSchema, observed); const sub = s.subjects.find(x => x.id === input.subjectId); lifecycleAssert(sub, "sujeto de hallazgo inexistente");
 const key = sourceKey(input.provider, input.externalId, input.operationId, sub);
 let finding = s.ledger.find(f => f.key === key);
 if (!finding) { lifecycleAssert(!s.ledger.some(f => f.id === input.id), "ID de hallazgo reutilizado"); finding = { id: input.id, key, observations: [], dispositions: [] }; s.ledger.push(finding); }
 const { id: _id, at, ...content } = input; const hash = dataHash(content);
 if (finding.observations.at(-1)?.hash === hash) return s;
 finding.observations.push({ ...content, at, hash, sequence: finding.observations.length + 1 }); return finish(s);
}
export function disposeLifecycleFinding(original: unknown, observed: unknown): EnabledLifecycle {
 const s = enabled(original); const disposition = checked(DispositionSchema, observed); const finding = s.ledger.find(f => f.id === disposition.findingId);
 lifecycleAssert(finding && disposition.subjectId === s.currentSubject && finding.observations.at(-1)?.hash === disposition.observationHash, "disposición de hallazgo/sujeto obsoleto");
 const stored = { ...disposition, observationSequence: finding.observations.length };
 const { at: _at, ...content } = stored;
 const last = finding.dispositions.at(-1);
 if (last) { const { at: _oldAt, ...old } = last; if (sameData(old, content)) return s; }
 finding.dispositions.push(stored); return finish(s);
}
/** Sólo bloqueos de hallazgos. Vacío no prueba checks, aprobación GitHub ni permiso de Land. */
export function lifecycleFindingBlocks(original: unknown): string[] {
 const s = enabled(original);
 return s.ledger.flatMap(f => {
  const disposition = f.dispositions.at(-1);
  return disposition && disposition.subjectId === s.currentSubject && disposition.observationHash === f.observations.at(-1)?.hash && disposition.observationSequence === f.observations.length
   && ["corrected", "refuted-with-evidence"].includes(disposition.status) ? [] : [`${f.id}: pendiente, requiere humano o disposición obsoleta`];
 });
}
