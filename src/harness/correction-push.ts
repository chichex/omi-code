// Push host acotado: SHA literal a la misma rama propia, jamás HEAD móvil/main/force ni PR nuevo.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow, type WorkflowV2 } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { lifecycleAssert, sameData } from "./lifecycle-invariants.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
import { CorrectionPushRequestSchema, type CorrectionPushRequest } from "./correction-schema.ts";
import { PullSchema } from "./lifecycle-github-schema.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
import { fixedGitPush } from "./fixed-git-push.ts";
import { confirmLifecycleOperation } from "./lifecycle-state.ts";
import { isApproved, recipeApprovalHash } from "./state.ts";
export interface CorrectionPushStore { checkout: WorkflowV2["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow }
export interface CorrectionPushDeps {
 runner?: Runner; signal: AbortSignal; beforePush: (request: CorrectionPushRequest) => Promise<void>;
 repository: (signal: AbortSignal) => Promise<unknown>; currentPr: (signal: AbortSignal) => Promise<unknown>; snapshot: (signal: AbortSignal) => Promise<unknown>;
 recordRequest?: (request: CorrectionPushRequest) => Promise<void>; workflowStore?: CorrectionPushStore;
}
function context(original: unknown, operationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted", "falta PR adoptado");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId);
 const round = s.corrections?.find(r => ["verified", "pushed"].includes(r.status) && "newSubjectId" in r && r.newSubjectId === op?.subjectId);
 lifecycleAssert(op?.kind === "push" && round && (round.status === "verified" || round.status === "pushed"), "push sin corrección verificada");
 const before = s.subjects.find(x => x.id === round.subjectId), after = s.subjects.find(x => x.id === round.newSubjectId);
 lifecycleAssert(before && after && !after.mergedSha && before.number === after.number && after.number === state.pullRequest.number && after.branch === state.checkout.branch && after.base === state.pullRequest.base, "sujeto/PR/rama ajenos o mergeados");
 lifecycleAssert(lifecycleRef(after.branch) && !after.branch.startsWith("refs/") && !["main", "master", "HEAD", after.base].includes(after.branch), "nunca push a main/master/base/HEAD");
 const request: CorrectionPushRequest = { repo: s.root.repo, pr: after.number, branch: after.branch, base: after.base, beforeHead: before.headSha, head: round.head, fingerprint: round.fingerprint, correctionId: round.operationId, correlationId: op.correlationId };
 lifecycleAssert(Value.Check(CorrectionPushRequestSchema, request) && request.head === after.headSha && request.fingerprint === after.contentHash, "request push inválido");
 return { state, s, op, round, request };
}
function matchesPr(input: unknown, request: CorrectionPushRequest, head: string): boolean {
 return Value.Check(PullSchema, input) && input.number === request.pr && input.base.repo.full_name.toLowerCase() === request.repo && input.head.repo?.full_name.toLowerCase() === request.repo && input.head.ref === request.branch && input.base.ref === request.base && input.head.sha === head;
}
async function claim(store: CorrectionPushStore, request: CorrectionPushRequest): Promise<void> {
 const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "falta trabajo durable");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const c = context(saved, store.operationId);
  lifecycleAssert(isApproved(c.state) && recipeApprovalHash(c.state) === c.round.scopeHash && c.state.status === "active" && c.s.stage === "corrections" && c.op.status === "pending" && !c.op.pushRequest && c.op.configHash === c.s.pinHash && sameData(c.request, request), "push reservado/obsoleto; sólo observar, no replay");
  c.op.pushRequest = request; return { ...c.state, revision: c.state.revision + 1 };
 });
}
const Repository = Type.Object({ full_name: Type.String(), default_branch: Type.String() });
async function assertDestination(state: WorkflowV2, request: CorrectionPushRequest, deps: CorrectionPushDeps): Promise<string> {
 const repo = await deps.repository(deps.signal);
 lifecycleAssert(Value.Check(Repository, repo) && repo.full_name.toLowerCase() === request.repo && lifecycleRef(repo.default_branch) && repo.default_branch !== request.branch, "default branch/repo desconocidos o destino protegido");
 const origin = await (deps.runner ?? boundedGitHubRunner).run("git", ["-c", "core.fsmonitor=false", "remote", "get-url", "--push", "--all", "origin"], { cwd: state.checkout.root, signal: deps.signal });
 const urls = origin.stdout.trim().split("\n"), match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(urls[0] ?? "");
 lifecycleAssert(origin.code === 0 && urls.length === 1 && match?.[1]?.toLowerCase() === request.repo, "origin efectivo ajeno/múltiple; no se infiere destino");
 deps.signal.throwIfAborted(); const destination = urls[0]; lifecycleAssert(destination, "destino ausente"); return destination;
}
const GitSnapshot = Type.Object({ head: Type.String(), fingerprint: Type.String(), branch: Type.String(), clean: Type.Boolean(), ancestor: Type.Boolean() }, { additionalProperties: false });
export async function pushPostPrCorrection(original: unknown, operationId: string, deps: CorrectionPushDeps): Promise<{ status: "confirmed" | "unknown"; reason: string }> {
 const { state, s, op, round, request } = context(original, operationId);
 lifecycleAssert(isApproved(state) && recipeApprovalHash(state) === round.scopeHash, "la receta/alcance cambió antes del push");
 lifecycleAssert(state.status === "active" && state.phase === "pr" && s.stage === "corrections" && op.status === "pending" && !op.pushRequest && op.configHash === s.pinHash && s.currentSubject === op.subjectId, "falta push pending vigente o ya reclamado");
 const decision = s.decisions.find(d => d.id === op.decisionId);
 lifecycleAssert(decision && (decision.source === "person" || decision.authorityHash), "corrections:auto no autoriza push; falta permiso independiente");
 deps.signal.throwIfAborted(); await deps.beforePush(request); deps.signal.throwIfAborted();
 const before = await deps.currentPr(deps.signal);
 lifecycleAssert(Value.Check(PullSchema, before) && matchesPr(before, request, request.beforeHead) && before.state === "open" && !before.merged, "HEAD remoto ajeno/PR mergeado: no sobrescribir humano");
 const snapshot = await deps.snapshot(deps.signal);
 lifecycleAssert(Value.Check(GitSnapshot, snapshot) && snapshot.clean && snapshot.ancestor && snapshot.head === request.head && snapshot.fingerprint === request.fingerprint && snapshot.branch === request.branch, "Git cambió/no está limpio o no es fast-forward");
 await deps.beforePush(request); deps.signal.throwIfAborted(); const destination = await assertDestination(state, request, deps);
 const finalPr = await deps.currentPr(deps.signal); const finalSnapshot = await deps.snapshot(deps.signal);
 lifecycleAssert(Value.Check(PullSchema, finalPr) && finalPr.state === "open" && !finalPr.merged && matchesPr(finalPr, request, request.beforeHead) && Value.Check(GitSnapshot, finalSnapshot) && sameData(snapshot, finalSnapshot), "cambió PR/Git durante confirmación: renovar decisión");
 if (deps.recordRequest) await deps.recordRequest(request);
 else { lifecycleAssert(deps.workflowStore?.operationId === operationId, "falta claim durable del push"); await claim(deps.workflowStore, request); }
 deps.signal.throwIfAborted();
 try {
  await fixedGitPush(state.checkout, destination, request, deps.runner ?? boundedGitHubRunner, deps.signal);
 } catch { /* Puede haber llegado: sólo leer la identidad, nunca repetir push. */ }
 try {
  const after = await deps.currentPr(deps.signal); deps.signal.throwIfAborted();
  if (matchesPr(after, request, request.head)) return { status: "confirmed", reason: "HEAD del mismo PR confirmado por lectura" };
 } catch { /* Unknown conserva reserva/request. */ }
 return { status: "unknown", reason: "Push incierto/HEAD ajeno; conservar request y observar sin replay" };
}
/** Reconoce el efecto observado, incluso al reconciliar después de una respuesta perdida. No hace push. */
export function acceptCorrectionPush(original: unknown, operationId: string, observedPr: unknown, at: string): WorkflowV2 {
 const { state, s, op, round, request } = context(original, operationId);
 lifecycleAssert(op.pushRequest && sameData(op.pushRequest, request) && matchesPr(observedPr, request, request.head), "recibo no prueba el HEAD del mismo PR");
 if (op.status === "confirmed") { lifecycleAssert(op.receipt.outcome === "succeeded", "resultado de push conflictivo"); return state; }
 let lifecycle = confirmLifecycleOperation(s, { operationId, correlationId: op.correlationId, subjectId: op.subjectId, targetId: null, verifiedSubjectId: op.subjectId, externalId: `pull:${request.pr}:${request.head}`, outcome: "succeeded", at });
 lifecycleAssert(lifecycle.corrections && state.pullRequest, "identidad/ronda perdida");
 const index = lifecycle.corrections.findIndex(r => r.operationId === round.operationId); lifecycle.corrections[index] = { ...round, status: "pushed", pushOperationId: operationId };
 lifecycle.stage = "review"; state.lifecycle = lifecycle; state.pullRequest = { ...state.pullRequest, head: request.head }; state.phase = "review";
 state.revision++; state.activity = "Push al mismo PR confirmado; requiere nueva Review del SHA actual";
 return parseWorkflow(JSON.stringify(state));
}
