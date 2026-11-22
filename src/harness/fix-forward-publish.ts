// PR de fix-forward: draft nuevo desde el checkout de recuperación con la publicación existente (publishDraft).
// Claim durable antes del efecto; con claim previo sólo se observa. El PR mergeado no se reabre ni edita.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { MAX_HISTORY, parseWorkflow, type WorkflowV2 } from "./model.ts";
import { findPublishedDraft, publishDraft, renderPullRequestBody, type Published } from "./github.ts";
import { pullRequestBody } from "./pr-body.ts";
import { lifecycleAssert, sameData } from "./lifecycle-invariants.ts";
import { bindLifecycleSubject, confirmLifecycleOperation } from "./lifecycle-state.ts";
import { isApproved, recipeApprovalHash } from "./state.ts";
import type { FixForwardPush, FixForwardRequest } from "./recovery-workspace-schema.ts";
export interface FixForwardPublishDeps { runner: Runner; signal: AbortSignal; persistClaim: (claimed: WorkflowV2) => Promise<void> }
export type FixForwardPublishResult = { state: "opened"; pullRequest: Published } | { state: "unknown"; pullRequest: null; reason: string };
const PublishedSchema = Type.Object({ number: Type.Integer({ minimum: 1 }), url: Type.String(), head: Type.String() }, { additionalProperties: false });
function context(original: unknown, workspaceId: string, pushOperationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no habilitado"); const s = state.lifecycle;
 const w = s.recoveryWorkspaces?.find(w => w.id === workspaceId), op = s.operations.find(o => o.id === w?.operationId), push = s.operations.find(o => o.id === pushOperationId), sub = s.subjects.find(x => x.id === w?.sourceSubjectId), decision = s.decisions.find(d => d.id === push?.decisionId);
 lifecycleAssert(w && w.head && w.fingerprint && w.status === "verified" && s.activeRecoveryId === w.id && sub?.mergedSha && s.currentSubject === sub.id && op?.kind === "fix-forward" && op.status !== "confirmed" && op.configHash === s.pinHash && push?.kind === "fix-forward-push" && push.status !== "confirmed" && push.subjectId === sub.id && push.targetId === w.targetId && push.configHash === s.pinHash, "fix-forward sin workspace verificado o reserva de push/PR vigente");
 lifecycleAssert(decision && (decision.source === "person" || decision.authorityHash), "fix-forward/onFailure auto no autoriza push ni PR; falta permiso independiente");
 // publishDraft abre contra main: otra base queda fuera hasta que la publicación la soporte.
 lifecycleAssert(isApproved(state) && w.scopeHash === recipeApprovalHash(state) && w.base === "main", "receta/alcance cambió o base distinta de main");
 const draft: WorkflowV2 = { ...state, phase: "pr", checkout: w.checkout }, bodyHash = pullRequestBody(draft, w.head).bodyHash;
 const view: WorkflowV2 = { ...draft, publication: { status: "pending", head: w.head, bodyHash, at: w.at } }, body = renderPullRequestBody(view), branch = w.checkout.branch;
 const request: FixForwardRequest = { kind: "fix-forward", rootWorkflowId: s.root.workflowId, workspaceId: w.id, operationId: op.id, failureDeliveryId: w.failureDeliveryId, sourceSubjectId: sub.id, targetId: w.targetId, configHash: op.configHash, repo: s.root.repo, sourcePr: sub.number, integratedSha: sub.mergedSha, branch, base: w.base, baseSha: w.baseSha, head: w.head, fingerprint: w.fingerprint, body, bodyHash, title: state.source.title, correlationId: op.correlationId };
 const pushRequest: FixForwardPush = { kind: "fix-forward-push", workspaceId: w.id, fixForwardOperationId: op.id, repo: s.root.repo, branch, base: w.base, baseSha: w.baseSha, head: w.head, fingerprint: w.fingerprint, correlationId: push.correlationId };
 const claimed = w.pushOperationId === push.id && sameData(op.fixForwardRequest, request) && sameData(push.fixForwardPush, pushRequest);
 lifecycleAssert(claimed || (w.pushOperationId === null && !op.fixForwardRequest && !push.fixForwardPush), "claim fix-forward ajeno/obsoleto: observar, no replay");
 return { state, s, w, op, push, sub, view, request, pushRequest, claimed };
}
function claim(c: ReturnType<typeof context>): WorkflowV2 {
 lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && c.push.status === "pending", "reserva incierta: observar antes de publicar");
 c.op.fixForwardRequest = c.request; c.push.fixForwardPush = c.pushRequest; c.w.pushOperationId = c.push.id; c.state.revision++; return parseWorkflow(JSON.stringify(c.state));
}
/** persistClaim guarda el claim con CAS sobre la revisión leída antes del push/create. */
export async function publishFixForward(original: unknown, workspaceId: string, pushOperationId: string, deps: FixForwardPublishDeps): Promise<FixForwardPublishResult> {
 const c = context(original, workspaceId, pushOperationId);
 if (!c.claimed) {
  await deps.persistClaim(claim(c)); deps.signal.throwIfAborted();
  try { return { state: "opened", pullRequest: await publishDraft(c.view, deps.runner, deps.signal) }; } catch { /* Respuesta perdida o fallo: sólo observar. */ }
 }
 try { const found = await findPublishedDraft(c.view, deps.runner, deps.signal); if (found) return { state: "opened", pullRequest: found }; } catch { /* Ajeno/ilegible: unknown. */ }
 return { state: "unknown", pullRequest: null, reason: "PR fix-forward no observado; conservar claim y observar sin push ni create" };
}
/** Adopta el PR nuevo observado en la misma raíz: recibos, sujeto sin merge y Review del SHA nuevo. */
export function acceptFixForwardPull(original: unknown, workspaceId: string, pushOperationId: string, observed: unknown, at: string): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)), opened = state.lifecycle.status === "enabled" ? state.lifecycle.recoveryWorkspaces?.find(w => w.id === workspaceId && w.status === "opened") : undefined;
 if (opened) { lifecycleAssert(opened.pushOperationId === pushOperationId && Value.Check(PublishedSchema, observed) && opened.pullRequest?.number === observed.number && opened.pullRequest.url === observed.url && opened.pullRequest.head === observed.head, "PR fix-forward adoptado conflictivo"); return state; }
 const c = context(state, workspaceId, pushOperationId), { request } = c;
 lifecycleAssert(c.claimed && Value.Check(PublishedSchema, observed) && observed.head === request.head && observed.url === `https://github.com/${request.repo}/pull/${observed.number}`, "PR observado ajeno o de otro HEAD");
 lifecycleAssert(!c.s.subjects.some(x => x.number === observed.number), "PR ya conocido/mergeado: no se reabre ni adopta como fix-forward");
 let s = confirmLifecycleOperation(c.s, { operationId: c.push.id, correlationId: c.push.correlationId, subjectId: c.push.subjectId, targetId: c.push.targetId, verifiedSubjectId: null, externalId: `push:${request.branch}:${request.head}`, outcome: "succeeded", at });
 s = confirmLifecycleOperation(s, { operationId: c.op.id, correlationId: c.op.correlationId, subjectId: c.op.subjectId, targetId: c.op.targetId, verifiedSubjectId: null, externalId: `pull:${observed.number}`, outcome: "succeeded", at });
 s = bindLifecycleSubject(s, { id: `fix-forward:${observed.number}:${request.head}`, repo: request.repo, number: observed.number, branch: request.branch, base: request.base, headSha: request.head, baseSha: request.baseSha, contentHash: request.fingerprint, mergedSha: null }, { id: `fix-forward:${c.op.id}`, source: "publication", at });
 const w = s.recoveryWorkspaces?.find(w => w.id === workspaceId); lifecycleAssert(w, "workspace perdido");
 w.status = "opened"; w.pullRequest = { number: observed.number, url: observed.url, head: request.head, branch: request.branch, base: request.base, ownership: "adopted" };
 s.stage = "review"; state.lifecycle = s; state.phase = "review"; state.revision++; state.activity = `PR #${observed.number} de fix-forward en la raíz #${s.root.issue}; PR #${request.sourcePr} mergeado intacto; requiere Review`;
 state.history = [...state.history, { at, phase: state.phase, activity: state.activity }].slice(-MAX_HISTORY); return parseWorkflow(JSON.stringify(state));
}
