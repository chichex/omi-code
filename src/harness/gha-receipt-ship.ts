// omi-ship-v1: workflow de código confiable distinto del SHA realmente desplegado, ambos comprobados.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseWorkflow } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash, sameData } from "./lifecycle-value.ts";
import { GhaRunSchema, type GhaRun } from "./gha-review-contract.ts";
import { GhaShipReceiptSchema, ReceiptShipProofSchema, type GhaShipRequest, type ShipVerification } from "./ship-schema.ts";
import { shipContext, ghaShipRequest, shipScope, shipProbes, shipProofBase, type GhaShipDeps } from "./ship-context.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
export const shipRunName = (r: GhaShipRequest): string => `omi-ship-v1 ${r.targetId} ${r.correlationId}`;
function selectedRun(raw: unknown, r: GhaShipRequest): { state: "found"; run: GhaRun } | { state: "missing" | "invalid" } {
 if (!Value.Check(Type.Array(GhaRunSchema, { maxItems: 1000 }), raw)) return { state: "invalid" };
 const prefix = `omi-ship-v1 ${r.targetId} `;
 const matching = raw.filter(x => r.mode === "dispatch" ? x.display_title === shipRunName(r) : x.display_title.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/.test(x.display_title.slice(prefix.length))); if (!matching.length) return { state: "missing" }; const run = matching[0];
 const normalize = (v: string) => v.replace(/^refs\/(?:heads|tags)\//, ""), parts = run?.path.split("@");
 if (matching.length !== 1 || !run || run.workflow_id !== r.workflow.id || run.repository.full_name.toLowerCase() !== r.repo || !(r.mode === "observe" ? ["push", "workflow_dispatch", "workflow_run", "release"].includes(run.event) : run.event === "workflow_dispatch") || run.head_sha !== r.workflow.sha || normalize(run.head_branch) !== normalize(r.workflow.ref) || parts?.[0] !== r.workflow.path || parts[1] && normalize(parts[1]) !== normalize(r.workflow.ref)) return { state: "invalid" };
 return { state: "found", run };
}
export async function observeGhaShipReceipt(original: unknown, operationId: string, deps: GhaShipDeps): Promise<ShipVerification> {
 let scope: ReturnType<typeof shipScope> | undefined;
 try {
  const c = shipContext(original, operationId); lifecycleAssert(c.target.provider.kind === "gha" && c.target.provider.contract === "omi-ship-v1" && c.target.evidence.kind === "receipt", "no hay contrato de recibo Ship configurado");
  scope = shipScope(deps, c.target.timeoutSeconds); const signal = scope.signal, r = await ghaShipRequest(c, deps, signal); scope.check();
  while (true) {
   const selected = selectedRun(await deps.listRuns(signal), r); scope.check(); lifecycleAssert(selected.state !== "invalid", "correlación/run ambiguos o ajenos");
   if (selected.state === "found" && selected.run.status === "completed") {
    const run = selected.run, raw = await deps.loadReceipt(run, r, signal); scope.check(); lifecycleAssert(typeof raw === "string" && Buffer.byteLength(raw) <= 8 * 1024 * 1024 - 65536, "recibo ausente/grande"); const receipt: unknown = JSON.parse(raw);
    lifecycleAssert(Value.Check(GhaShipReceiptSchema, receipt) && receipt.repo === r.repo && receipt.pr === r.pr && receipt.targetId === r.targetId && receipt.workflowSha === r.workflow.sha && receipt.correlationId === (r.mode === "dispatch" ? r.correlationId : run.display_title.slice(`omi-ship-v1 ${r.targetId} `.length)) && receipt.runId === run.id && receipt.runAttempt === run.run_attempt, "identidad del recibo ajena a target/merge/run/attempt");
    if (receipt.state === "failed") return { state: "failed", proof: null, reason: "Workflow/recibo Ship informó fallo, no entrega" };
    lifecycleAssert(run.conclusion === "success" && receipt.state === "delivered" && (r.mode === "dispatch" ? receipt.integratedSha === r.integratedSha : receipt.integratedSha === r.integratedSha || await deps.containsCommit(r.integratedSha, receipt.integratedSha, signal)) && (receipt.integratedSha === receipt.deployedSha || await deps.containsCommit(receipt.integratedSha, receipt.deployedSha, signal)), "run/recibo/provenance incompletos; no-aplica exige prueba/elección aparte"); scope.check();
    const probes = await shipProbes(c, deps, receipt.deployedSha, receipt.versionTag, signal); scope.check();
    const proof = { ...shipProofBase(c, probes), kind: "gha-receipt", repo: r.repo, workflowSha: r.workflow.sha, runId: run.id, runAttempt: run.run_attempt, correlationId: r.correlationId, providerCorrelationId: receipt.correlationId, sourceSha: receipt.integratedSha, deployedSha: receipt.deployedSha, versionTag: receipt.versionTag, deploymentId: receipt.deploymentId, artifactHash: dataHash(receipt) };
    lifecycleAssert(Value.Check(ReceiptShipProofSchema, proof), "prueba de recibo inválida");
    return { state: probes.health === "fail" || probes.version === "fail" ? "failed" : probes.health === "unknown" || probes.version === "unknown" ? "unknown" : "verified", proof, reason: "Recibo y probes independientes comprobados" };
   }
   await deps.wait(1000, signal); scope.check();
  }
 } catch { return { state: "unknown", proof: null, reason: "Recibo/correlación/provenance incompletos o timeout; observar sin redispatch" }; }
 finally { scope?.close(); }
}
async function claim(original: unknown, operationId: string, request: GhaShipRequest, deps: GhaShipDeps): Promise<void> {
 const store = deps.workflowStore; lifecycleAssert(store?.operationId === operationId, "falta claim durable Ship"); const current = await readWorkflow(store.checkout, store.issue); lifecycleAssert(current, "falta trabajo");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  const c = shipContext(saved, operationId); lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && !c.op.shipRequest && c.op.configHash === c.s.pinHash && c.subject.id === c.s.currentSubject, "Ship ya reservado/obsoleto: sólo observar");
  const expected = shipContext(original, operationId); lifecycleAssert(sameData(c.subject, expected.subject) && c.op.correlationId === request.correlationId && request.configHash === c.op.configHash, "cambió Ship durante el claim");
  c.op.shipRequest = request; return { ...parseWorkflow(JSON.stringify(c.state)), revision: c.state.revision + 1 };
 });
}
export async function dispatchGhaShip(original: unknown, operationId: string, deps: GhaShipDeps): Promise<ShipVerification> {
 const c = shipContext(original, operationId); lifecycleAssert(c.target.provider.kind === "gha" && c.target.provider.mode === "dispatch" && c.target.provider.contract === "omi-ship-v1", "dispatch requiere contrato omi-ship-v1 suficiente, no github-release legacy");
 const r = await ghaShipRequest(c, deps, deps.signal); deps.signal.throwIfAborted(); const selected = selectedRun(await deps.listRuns(deps.signal), r); deps.signal.throwIfAborted();
 lifecycleAssert(selected.state !== "invalid", "no elegir último run ni redisparar una correlación ambigua");
 if (selected.state === "found" || c.op.shipRequest) return observeGhaShipReceipt(original, operationId, deps);
 lifecycleAssert(c.state.status === "active" && c.s.stage === "ship" && c.op.status === "pending" && c.op.configHash === c.s.pinHash && c.subject.id === c.s.currentSubject, "falta Ship pending vigente");
 const decision = c.s.decisions.find(d => d.id === c.op.decisionId); lifecycleAssert(decision && (decision.source === "person" || c.target.mode === "auto"), "falta permiso Ship independiente");
 lifecycleAssert(r.repo !== "chichex/omi-code" || decision.source === "person", "omi-code requiere persona para dispatch");
 lifecycleAssert(deps.beforeDispatch, "falta gate host vivo"); await deps.beforeDispatch(r); deps.signal.throwIfAborted();
 const refreshed = await deps.workflow(deps.signal, true); deps.signal.throwIfAborted();
 lifecycleAssert(sameData(refreshed, r.workflow), "workflow/ref cambió durante confirmación: renovar permiso antes del efecto");
 if (deps.recordRequest) await deps.recordRequest(r); else await claim(original, operationId, r, deps); deps.signal.throwIfAborted();
 try { await (deps.runner ?? boundedGitHubRunner).run("gh", ["workflow", "run", String(r.workflow.id), "--repo", r.repo, "--ref", r.workflow.ref, "-f", `expected_workflow_sha=${r.workflow.sha}`, "-f", `expected_merge_sha=${r.integratedSha}`, "-f", `target_id=${r.targetId}`, "-f", `correlation_id=${r.correlationId}`, "-f", `pr=${r.pr}`], { cwd: c.state.checkout.root, signal: deps.signal, env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } }); }
 catch { /* Una invocación y nonce durable; sólo reconciliación. */ }
 return observeGhaShipReceipt(original, operationId, deps);
}
