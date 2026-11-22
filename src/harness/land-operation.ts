// Efecto de Land reservado por el host: una mutación PUT SHA-bound y luego sólo observación.
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow, type WorkflowV2 } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { landReadiness } from "./lifecycle-land.ts";
import { isApproved, recipeApprovalHash } from "./state.ts";
import { landLedgerHash } from "./land-invariants.ts";
import { LandRequestSchema, type LandRequest } from "./land-schema.ts";
import { PullSchema } from "./lifecycle-github-schema.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
export interface LandOperationStore { checkout: WorkflowV2["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow }
export interface LandOperationDeps {
 runner?: Runner; signal: AbortSignal; beforeLand: (request: LandRequest) => Promise<void>;
 readFacts: (signal: AbortSignal) => Promise<unknown>; readPull: (signal: AbortSignal) => Promise<unknown>;
 recordRequest?: (request: LandRequest) => Promise<void>; workflowStore?: LandOperationStore;
}
function pending(original: unknown, operationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted" && state.status === "active" && state.phase === "land", "Land no activo");
 const s = state.lifecycle, ready = s.ready, op = s.operations.find(o => o.id === operationId), subject = s.subjects.find(x => x.id === op?.subjectId);
 lifecycleAssert(isApproved(state) && ready?.sourceHash === state.source.hash && ready.recipeHash === recipeApprovalHash(state) && ready.ledgerHash === landLedgerHash(s) && ["ready", "land"].includes(s.stage), "alcance/ready obsoleto antes de Land");
 lifecycleAssert(ready && op?.kind === "land" && op.status === "pending" && !op.landRequest && subject && !subject.mergedSha && subject.id === s.currentSubject && ready.subjectId === subject.id && ready.configHash === s.pinHash && op.configHash === s.pinHash, "falta reserva/ready vigente o efecto ya reclamado");
 const decision = s.decisions.find(d => d.id === op.decisionId); lifecycleAssert(decision?.effectHash === ready.hash, "decisión no vinculada al snapshot PR/SHA/reglas");
 const config = currentLifecyclePin(s).accepted.block;
 lifecycleAssert(subject.base === config.land.base && state.pullRequest.base === config.land.base, "land.base cambió: renovar identidad/decisión");
 lifecycleAssert(s.root.repo !== "chichex/omi-code" || decision.source === "person", "omi-code exige confirmación humana/persona para merge");
 if (decision.source === "policy") lifecycleAssert(landReadiness(state, ready.facts, ready.risk).auto, "auto-Land no habilitado por condiciones verificables/Ship/riesgo");
 else lifecycleAssert(decision.source === "person", "falta permiso específico de Land");
 const request: LandRequest = { repo: s.root.repo, pr: subject.number, subjectId: subject.id, headSha: subject.headSha, baseSha: subject.baseSha, branch: subject.branch, base: subject.base, method: config.land.method, snapshotHash: ready.hash, configHash: s.pinHash, correlationId: op.correlationId };
 lifecycleAssert(Value.Check(LandRequestSchema, request), "request Land inválido"); return { state, s, ready, op, request };
}
async function claim(store: LandOperationStore, request: LandRequest): Promise<void> {
 const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "falta trabajo durable");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const c = pending(saved, store.operationId); lifecycleAssert(sameData(request, c.request), "Land cambió antes del claim");
  c.op.landRequest = request; c.s.stage = "land"; return { ...c.state, revision: c.state.revision + 1 };
 });
}
function mergedPull(input: unknown, request: LandRequest): boolean {
 return Value.Check(PullSchema, input) && input.merged && input.state === "closed" && input.merge_commit_sha !== null && input.number === request.pr && input.head.sha === request.headSha && input.head.ref === request.branch && input.base.ref === request.base && input.base.repo.full_name.toLowerCase() === request.repo && input.head.repo?.full_name.toLowerCase() === request.repo;
}
export async function landPullRequest(original: unknown, operationId: string, deps: LandOperationDeps): Promise<{ status: "merged" | "unknown"; pull: unknown; reason: string }> {
 const c = pending(original, operationId); deps.signal.throwIfAborted();
 const before = landReadiness(c.state, await deps.readFacts(deps.signal), c.ready.risk); lifecycleAssert(before.ready && before.hash === c.ready.hash, "hechos/HEAD/reglas cambiaron antes de confirmar");
 await deps.beforeLand(c.request); deps.signal.throwIfAborted();
 const after = landReadiness(c.state, await deps.readFacts(deps.signal), c.ready.risk); lifecycleAssert(after.ready && after.hash === c.ready.hash, "hechos/HEAD/reglas cambiaron durante confirmación: renovar decisión");
 if (deps.recordRequest) await deps.recordRequest(c.request);
 else { lifecycleAssert(deps.workflowStore?.operationId === operationId, "falta claim durable de Land"); await claim(deps.workflowStore, c.request); }
 deps.signal.throwIfAborted();
 try { await (deps.runner ?? boundedGitHubRunner).run("gh", ["api", "--hostname", "github.com", "--method", "PUT", `repos/${c.request.repo}/pulls/${c.request.pr}/merge`, "-f", `sha=${c.request.headSha}`, "-f", `merge_method=${c.request.method}`], { cwd: c.state.checkout.root, signal: deps.signal, env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } }); }
 catch { /* Resultado incierto: jamás replay automático del PUT. */ }
 try { const observed = await deps.readPull(deps.signal); deps.signal.throwIfAborted(); if (mergedPull(observed, c.request)) return { status: "merged", pull: observed, reason: "Merge confirmado por lectura de PR/SHA" }; } catch { /* Sigue pendiente/unknown. */ }
 return { status: "unknown", pull: null, reason: "Merge no confirmado; observar PR/SHA sin repetir el efecto" };
}
