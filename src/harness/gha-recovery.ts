// Rollback GHA: workflow confiable y recibo del commit PREVIO, nunca descendencia del merge fallido.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { recoveryCause, rollbackBaseline } from "./recovery-state.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash, sameData } from "./lifecycle-value.ts";
import { GhaRollbackRequestSchema, RecoveryProofSchema, type GhaRollbackRequest, type RecoveryResult } from "./recovery-schema.ts";
import { GhaRunSchema, type GhaRun } from "./gha-review-contract.ts";
import { ShipWorkflowSchema, GhaShipReceiptSchema, ShipProbesSchema } from "./ship-schema.ts";
import { shipScope, type GhaShipDeps } from "./ship-context.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
import { withinSignal } from "./host-deadline.ts";
export interface GhaRecoveryDeps {
 signal: AbortSignal; timeoutSeconds: number; now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<void>; runner?: Runner;
 workflow: (signal: AbortSignal, refresh?: boolean) => Promise<unknown>; listRuns: (signal: AbortSignal) => Promise<unknown>;
 loadReceipt: (run: GhaRun, request: GhaRollbackRequest, signal: AbortSignal) => Promise<unknown>;
 verifyProbes?: (expected: { targetId: string; integratedSha: string; deployedSha: string; version: string }, signal: AbortSignal) => Promise<unknown>;
 beforeDispatch?: (request: GhaRollbackRequest) => Promise<void>; recordRequest?: (request: GhaRollbackRequest) => Promise<void>; workflowStore?: GhaShipDeps["workflowStore"];
}
export function ghaRecoveryContext(original: unknown, operationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle deshabilitado");
 const op = state.lifecycle.operations.find(o => o.id === operationId); lifecycleAssert(op?.kind === "rollback", "no rollback GHA");
 const failure = op.recoveryRequest?.failureDeliveryId ?? state.lifecycle.deliveries?.findLast(d => d.subjectId === op.subjectId && d.targetId === op.targetId)?.id; lifecycleAssert(failure, "falta fallo causal");
 const c = recoveryCause(state, failure, op.id), b = rollbackBaseline(c); lifecycleAssert(c.target.provider.kind === "gha" && c.target.provider.rollback && b.kind === "gha", "falta capacidad/previa GHA");
 return { ...c, op, baseline: b, provider: c.target.provider, rollback: c.target.provider.rollback };
}
export const rollbackRunName = (r: GhaRollbackRequest) => `omi-ship-v1 rollback ${r.targetId} ${r.correlationId}`;
function selected(raw: unknown, r: GhaRollbackRequest): GhaRun | undefined {
 lifecycleAssert(Value.Check(Type.Array(GhaRunSchema, { maxItems: 1000 }), raw), "runs incompletos"); const matches = raw.filter(x => x.display_title === rollbackRunName(r)); lifecycleAssert(matches.length <= 1, "correlación recovery duplicada"); const run = matches[0];
 if (run) { const path = run.path.split("@"), normalize = (v: string) => v.replace(/^refs\/(?:heads|tags)\//, ""); lifecycleAssert(run.workflow_id === r.workflow.id && run.repository.full_name.toLowerCase() === r.repo && run.event === "workflow_dispatch" && run.head_sha === r.workflow.sha && normalize(run.head_branch) === normalize(r.workflow.ref) && path[0] === r.workflow.path && (!path[1] || normalize(path[1]) === normalize(r.workflow.ref)), "run rollback de otro workflow/ref/repo"); }
 return run;
}
async function claim(original: unknown, id: string, r: GhaRollbackRequest, deps: GhaRecoveryDeps) {
 if (deps.recordRequest) { await deps.recordRequest(r); return; }
 const store = deps.workflowStore; lifecycleAssert(store?.operationId === id, "falta store de claim rollback"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "trabajo perdido");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const c = ghaRecoveryContext(saved, id), expected = ghaRecoveryContext(original, id);
  lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && !c.op.recoveryRequest && c.op.configHash === c.s.pinHash && c.s.currentSubject === c.sub.id && sameData(c.op, expected.op) && sameData(c.baseline, expected.baseline) && c.state.source.hash === expected.state.source.hash, "claim rollback existente/obsoleto: sólo observar");
  c.op.recoveryRequest = r; return { ...c.state, revision: c.state.revision + 1 };
 });
}
export async function rollbackGhaTarget(original: unknown, operationId: string, deps: GhaRecoveryDeps): Promise<RecoveryResult> {
 const c = ghaRecoveryContext(original, operationId), scope = shipScope(deps, c.target.timeoutSeconds), signal = scope.signal;
 try {
  lifecycleAssert((c.target.evidence.health || c.target.evidence.version) && deps.verifyProbes, "rollback requiere verificador identificado");
  const wf = c.op.recoveryRequest?.workflow ?? await withinSignal(deps.workflow(signal), signal); scope.check();
  lifecycleAssert(Value.Check(ShipWorkflowSchema, wf) && wf.ref === c.rollback.ref && wf.path === `.github/workflows/${c.rollback.workflow.replace(/^\.github\/workflows\//, "")}`, "workflow recovery/ref no confiable");
  const request = { kind: "gha-rollback", operationId: c.op.id, baselineId: c.baseline.id, failureDeliveryId: c.d.id, repo: c.s.root.repo, pr: c.sub.number, subjectId: c.sub.id, targetId: c.target.id, configHash: c.op.configHash, integratedSha: c.baseline.integratedSha, previousVersion: c.baseline.previousVersion, previousCommitSha: c.baseline.previousCommitSha, correlationId: c.op.correlationId, workflow: wf };
  lifecycleAssert(Value.Check(GhaRollbackRequestSchema, request) && (!c.op.recoveryRequest || sameData(c.op.recoveryRequest, request)), "request rollback incompleto/cambiado");
  let run = selected(await withinSignal(deps.listRuns(signal), signal), request); scope.check();
  if (!run && !c.op.recoveryRequest) {
   const decision = c.s.decisions.find(d => d.id === c.op.decisionId);
   lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && c.op.configHash === c.s.pinHash && decision && (decision.source === "person" || c.target.onFailure.mode === "auto") && (request.repo !== "chichex/omi-code" || decision.source === "person"), "falta permiso recovery independiente/persona omi-code");
   lifecycleAssert(deps.beforeDispatch, "falta gate host"); await withinSignal(deps.beforeDispatch(request), signal); scope.check();
   lifecycleAssert(sameData(await withinSignal(deps.workflow(signal, true), signal), wf), "workflow/ref recovery cambió durante permiso"); await claim(original, operationId, request, deps); scope.check();
   try { await withinSignal((deps.runner ?? boundedGitHubRunner).run("gh", ["workflow", "run", String(wf.id), "--repo", request.repo, "--ref", wf.ref, "-f", "action=rollback", "-f", `expected_workflow_sha=${wf.sha}`, "-f", `expected_merge_sha=${request.integratedSha}`, "-f", `expected_previous_sha=${request.previousCommitSha}`, "-f", `previous_version=${request.previousVersion}`, "-f", `target_id=${request.targetId}`, "-f", `correlation_id=${request.correlationId}`, "-f", `pr=${request.pr}`], { cwd: c.state.checkout.root, signal, env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } }), signal); } catch { /* Claim conservado: nunca redispatch. */ }
  }
  while (true) {
   scope.check(); if (!run) run = selected(await withinSignal(deps.listRuns(signal), signal), request);
   if (run?.status === "completed") {
    const raw = await withinSignal(deps.loadReceipt(run, request, signal), signal); scope.check(); lifecycleAssert(typeof raw === "string" && Buffer.byteLength(raw) <= 8 * 1024 * 1024 - 65536, "recibo recovery incompleto/grande"); const receipt: unknown = JSON.parse(raw);
    lifecycleAssert(Value.Check(GhaShipReceiptSchema, receipt) && receipt.repo === request.repo && receipt.pr === request.pr && receipt.targetId === request.targetId && receipt.integratedSha === request.integratedSha && receipt.workflowSha === wf.sha && receipt.correlationId === request.correlationId && receipt.runId === run.id && receipt.runAttempt === run.run_attempt, "recibo rollback ajeno a request/run/attempt");
    if (receipt.state === "failed") return { state: "failed", proof: null, reason: "Workflow de recuperación informó fallo" };
    lifecycleAssert(run.conclusion === "success" && receipt.state === "delivered" && receipt.versionTag === request.previousVersion && receipt.deployedSha === request.previousCommitSha, "recibo no acredita versión/commit PREVIOS");
    const probes = await withinSignal(deps.verifyProbes({ targetId: request.targetId, integratedSha: request.integratedSha, deployedSha: request.previousCommitSha, version: request.previousVersion }, signal), signal); scope.check(); lifecycleAssert(Value.Check(ShipProbesSchema, probes), "probes recovery incompletos");
    const proof = { kind: "gha-rollback", subjectId: request.subjectId, targetId: request.targetId, operationId: c.op.id, baselineId: request.baselineId, failureDeliveryId: request.failureDeliveryId, configHash: request.configHash, integratedSha: request.integratedSha, previousVersion: request.previousVersion, previousCommitSha: request.previousCommitSha, probes, repo: request.repo, workflowSha: wf.sha, runId: run.id, runAttempt: run.run_attempt, correlationId: request.correlationId, artifactHash: dataHash(receipt) };
    lifecycleAssert(Value.Check(RecoveryProofSchema, proof), "prueba recovery inválida");
    return { state: Object.values(probes).includes("fail") ? "failed" : (c.target.evidence.health && probes.health !== "pass") || (c.target.evidence.version && probes.version !== "pass") || !Object.values(probes).includes("pass") ? "unknown" : "recovered", proof, reason: "Recibo y verificador de la versión previa: servicio recuperado, no merge entregado" };
   }
   await withinSignal(deps.wait(1000, signal), signal); scope.check(); run = undefined;
  }
 } catch { return { state: "unknown", proof: null, reason: "Recuperación GHA no comprobada/timeout; conservar claim, no redispatch" }; }
 finally { scope.close(); }
}
