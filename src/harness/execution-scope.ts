// Ámbito de evidencia actual: conserva historia sin usarla para acreditar una ronda post-PR nueva.
import type { Phase, Workflow } from "./model.ts";
import { currentRecoveryWorkspace } from "./workflow-context.ts";
export function currentCorrection(state: Workflow) {
 return state.version === 2 && state.lifecycle.status === "enabled" ? state.lifecycle.corrections?.findLast(r => r.status !== "pushed" && r.status !== "failed") : undefined;
}
export function executionEvidence(state: Workflow) { const round = currentCorrection(state), workspace = currentRecoveryWorkspace(state); return round ? state.evidence.slice(round.evidenceOffset) : workspace?.status === "coding" ? state.evidence.slice(workspace.evidenceOffset) : state.evidence; }
export function executionReviews(state: Workflow) { const round = currentCorrection(state), workspace = currentRecoveryWorkspace(state); return round ? state.reviews.slice(round.reviewOffset) : workspace?.status === "coding" ? state.reviews.slice(workspace.reviewOffset) : state.reviews; }
export function correctionExecutionBlock(state: Workflow): string {
 const workspace = currentRecoveryWorkspace(state);
 if (workspace?.status === "coding" && state.version === 2 && state.lifecycle.status === "enabled") {
  const op = state.lifecycle.operations.find(o => o.id === workspace.operationId);
  return op?.status === "pending" && op.kind === "fix-forward" && op.configHash === state.lifecycle.pinHash && workspace.sourceSubjectId === state.lifecycle.currentSubject && state.steps.some(s => s.id === workspace.stepId) ? "" : "Reserva fix-forward incierta/obsoleta: no ejecutar código";
 }
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
/** Etapas que sólo existen después del PR draft. */
const AFTER_DRAFT: ReadonlySet<Phase> = new Set(["done", "review", "land", "ship", "delivered"]);
/** Una corrección en curso: la ronda en coding o planned, o el fix-forward en su checkout. Una ronda verificada ya no lo es. */
export function correctionInProgress(state: Workflow): boolean {
 const round = currentCorrection(state);
 return round?.status === "coding" || round?.status === "planned" || currentRecoveryWorkspace(state)?.status === "coding";
}
/** Después del draft (una etapa posterior o el PR adoptado), los comandos del agente sólo corren durante una corrección en
 * curso. Si no, un setup sería un camino para disparar workflows por fuera del lifecycle y de sus permisos. */
export function afterDraft(state: Workflow): boolean {
 if (correctionInProgress(state)) return false;
 return AFTER_DRAFT.has(state.phase) || state.version === 2 && state.pullRequest?.ownership === "adopted";
}
