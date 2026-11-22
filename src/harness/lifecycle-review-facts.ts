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
  const id = bounded(`${op.id}:check:${check.externalId}`);
  if (!s.checks.some(c => c.id === id)) s.checks.push({ id, subjectId: op.subjectId, context: bounded(check.context, 1000), appId: check.appId, state: check.state, externalId: bounded(check.externalId), at: facts.at });
 }
 if (facts.approval) {
  const id = bounded(`${op.id}:approval`);
  if (!s.approvals.some(a => a.id === id)) s.approvals.push({ id, subjectId: op.subjectId, provider: facts.provider, reviewer: bounded(facts.approval.reviewer), state: facts.approval.state, externalId: bounded(facts.approval.externalId), at: facts.at });
 }
 const checked = validateLifecycleState(s); lifecycleAssert(checked.status === "enabled", "lifecycle inválido después de la Review"); return checked;
}
