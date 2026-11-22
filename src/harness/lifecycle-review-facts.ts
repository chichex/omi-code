// Hechos de una Review ya confirmada: hallazgos al ledger, checks y opinión separados. Nunca permiso de Land.
import { validateLifecycleState, lifecycleAssert } from "./lifecycle-invariants.ts";
import { ingestLifecycleFinding } from "./lifecycle-state.ts";
import type { EnabledLifecycle } from "./lifecycle-state-schema.ts";

export interface ReviewFinding { externalId: string; text: string; severity: "low" | "medium" | "high" | "critical" | "unknown"; resolved: boolean; outdated: boolean }
export interface ReviewCheck { context: string; appId: number | null; state: "success" | "failure" | "pending" | "unknown"; externalId: string }
export interface ReviewFacts {
 operationId: string; provider: "github" | "gha" | "local"; at: string;
 findings: ReviewFinding[]; checks: ReviewCheck[];
 /** null: el proveedor no opina (por ejemplo, GitHub sin reviewers que hayan respondido). */
 approval: { reviewer: string; state: "approved" | "changes-requested" | "unknown"; externalId: string } | null;
}
const bounded = (value: string, max = 256) => value.slice(0, max);
/** Sólo para una operación review confirmada del sujeto actual; un hecho repetido no se duplica. */
export function recordLifecycleReview(original: unknown, facts: ReviewFacts): EnabledLifecycle {
 const initial = validateLifecycleState(original); lifecycleAssert(initial.status === "enabled", "lifecycle deshabilitado");
 const op = initial.operations.find(o => o.id === facts.operationId);
 lifecycleAssert(op?.kind === "review" && op.status === "confirmed" && op.receipt.outcome === "succeeded" && op.subjectId === initial.currentSubject, "Review sin recibo confirmado del sujeto actual");
 let s = structuredClone(initial);
 for (const finding of facts.findings) {
  if (!finding.text.trim()) continue;
  s = ingestLifecycleFinding(s, { id: bounded(`${facts.operationId}:${finding.externalId}`), provider: facts.provider, externalId: bounded(finding.externalId), operationId: op.id, subjectId: op.subjectId,
   text: finding.text.slice(0, 4000), severity: finding.severity, resolved: finding.resolved, outdated: finding.outdated, at: facts.at });
 }
 for (const check of facts.checks) {
  // Un status sin app no identifica al emisor: queda en la lectura, no como check acreditado.
  if (check.appId === null) continue;
  // Un cambio de estado (pending → success) es otro hecho, append-only; la proyección usa el último por check.
  const externalId = bounded(check.externalId), previous = s.checks.filter(c => c.subjectId === op.subjectId && c.externalId === externalId);
  if (previous.at(-1)?.state === check.state) continue;
  s.checks.push({ id: bounded(`${op.id}:check:${externalId}:${previous.length + 1}`), subjectId: op.subjectId, context: bounded(check.context, 1000), appId: check.appId, state: check.state, externalId, at: facts.at });
 }
 if (facts.approval) {
  const previous = s.approvals.filter(a => a.subjectId === op.subjectId && a.provider === facts.provider);
  if (previous.at(-1)?.state !== facts.approval.state) s.approvals.push({ id: bounded(`${op.id}:approval:${previous.length + 1}`), subjectId: op.subjectId, provider: facts.provider, reviewer: bounded(facts.approval.reviewer), state: facts.approval.state, externalId: bounded(facts.approval.externalId), at: facts.at });
 }
 const checked = validateLifecycleState(s); lifecycleAssert(checked.status === "enabled", "lifecycle inválido después de la Review"); return checked;
}
