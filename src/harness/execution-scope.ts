// Ámbito de evidencia actual: conserva historia sin usarla para acreditar una ronda post-PR nueva.
import type { Workflow } from "./model.ts";
export function currentCorrection(state: Workflow) {
 return state.version === 2 && state.lifecycle.status === "enabled" ? state.lifecycle.corrections?.findLast(r => r.status !== "pushed" && r.status !== "failed") : undefined;
}
export function executionEvidence(state: Workflow) { const round = currentCorrection(state); return round ? state.evidence.slice(round.evidenceOffset) : state.evidence; }
export function executionReviews(state: Workflow) { const round = currentCorrection(state); return round ? state.reviews.slice(round.reviewOffset) : state.reviews; }
export function correctionExecutionBlock(state: Workflow): string {
 if (state.version !== 2 || state.pullRequest?.ownership !== "adopted" || !["implement", "verify", "pr"].includes(state.phase)) return "";
 const round = currentCorrection(state); if (!round || round.status === "planned" || state.lifecycle.status !== "enabled") return "Falta corrección activa autorizada";
 const s = state.lifecycle, op = s.operations.find(o => o.id === round.operationId);
 if (round.status === "coding" && (op?.status !== "pending" || op.configHash !== s.pinHash)) return "Reserva de corrección incierta/obsoleta: no ejecutar checks ni commit";
 if (round.status === "coding" && round.findings.some(ref => {
  const f = s.ledger.find(f => f.id === ref.id), o = f?.observations.at(-1), d = f?.dispositions.at(-1);
  return o?.hash !== ref.hash || o.sequence !== ref.sequence || f?.dispositions.length !== ref.dispositionSequence || d?.status !== "accepted" || d.subjectId !== round.subjectId;
 })) return "Cambió la disposición/observación del grupo; requiere humano y nueva validación";
 return "";
}
export function assertCorrectionExecution(state: Workflow): void { const blocked = correctionExecutionBlock(state); if (blocked) throw new Error(blocked); }
export function assertCorrectionHead(state: Workflow, head: string): void {
 const round = currentCorrection(state); if (!round || round.status === "planned" || state.version !== 2 || state.lifecycle.status !== "enabled") return;
 const step = state.steps.find(s => s.id === round.stepId), subject = state.lifecycle.subjects.find(s => s.id === round.subjectId);
 const expected = step?.status === "done" ? step.commit : round.startHead ?? subject?.headSha;
 if (!expected || head !== expected) throw new Error("HEAD ajeno a la corrección activa; pausar sin reset/rebase ni sobrescribir humano");
}
