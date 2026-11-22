// Draft→ready se reserva y confirma aparte. No solicita merge ni transforma CI verde en permiso.
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow, type WorkflowV2 } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { PullSchema } from "./lifecycle-github-schema.ts";
import { DraftReadyRequestSchema, type DraftReadyRequest } from "./land-schema.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
export interface DraftReadyDeps { runner?: Runner; signal: AbortSignal; beforeReady: (request: DraftReadyRequest) => Promise<void>; readPull: (signal: AbortSignal) => Promise<unknown>; recordRequest?: (request: DraftReadyRequest) => Promise<void>;
 workflowStore?: { checkout: WorkflowV2["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow } }
function requestFor(original: unknown, operationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted" && state.status === "active", "PR no adoptado/activo");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), sub = s.subjects.find(x => x.id === op?.subjectId);
 lifecycleAssert(op?.kind === "ready" && op.status === "pending" && !op.readyRequest && op.configHash === s.pinHash && sub && !sub.mergedSha && sub.id === s.currentSubject, "falta reserva ready exclusiva vigente");
 const request: DraftReadyRequest = { repo: sub.repo, pr: sub.number, subjectId: sub.id, headSha: sub.headSha, baseSha: sub.baseSha, branch: sub.branch, base: sub.base, configHash: s.pinHash, correlationId: op.correlationId };
 lifecycleAssert(Value.Check(DraftReadyRequestSchema, request), "request ready inválido"); return { state, op, request };
}
function matches(input: unknown, r: DraftReadyRequest): boolean { return Value.Check(PullSchema, input) && input.state === "open" && !input.merged && input.number === r.pr && input.head.sha === r.headSha && input.base.sha === r.baseSha && input.head.ref === r.branch && input.base.ref === r.base && input.head.repo?.full_name.toLowerCase() === r.repo && input.base.repo.full_name.toLowerCase() === r.repo; }
export async function markDraftReady(original: unknown, operationId: string, deps: DraftReadyDeps): Promise<{ status: "ready" | "unknown"; reason: string }> {
 const c = requestFor(original, operationId); deps.signal.throwIfAborted();
 const pull = await deps.readPull(deps.signal); lifecycleAssert(matches(pull, c.request), "PR/HEAD ajeno antes de ready");
 if (Value.Check(PullSchema, pull) && !pull.draft) return { status: "ready", reason: "Estado ready ya observado; no mutación" };
 await deps.beforeReady(c.request); deps.signal.throwIfAborted(); const fresh = await deps.readPull(deps.signal); lifecycleAssert(matches(fresh, c.request), "PR/HEAD cambió durante permiso ready");
 if (deps.recordRequest) await deps.recordRequest(c.request);
 else {
  const store = deps.workflowStore; lifecycleAssert(store?.operationId === operationId, "falta store del claim ready"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "falta trabajo");
  await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => { const changed = requestFor(saved, operationId); lifecycleAssert(sameData(c.request, changed.request), "ready cambió antes del claim"); changed.op.readyRequest = c.request; return { ...changed.state, revision: changed.state.revision + 1 }; });
 }
 deps.signal.throwIfAborted();
 try { await (deps.runner ?? boundedGitHubRunner).run("gh", ["pr", "ready", String(c.request.pr), "--repo", c.request.repo], { cwd: c.state.checkout.root, signal: deps.signal, env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } }); } catch { /* No replay; observar draft/HEAD. */ }
 try { const observed = await deps.readPull(deps.signal); deps.signal.throwIfAborted(); if (Value.Check(PullSchema, observed) && matches(observed, c.request) && !observed.draft) return { status: "ready", reason: "Draft→ready observado; ningún permiso de merge" }; } catch { /* Unknown. */ }
 return { status: "unknown", reason: "Draft→ready incierto; observar sin repetir, nunca mergear por este recibo" };
}
