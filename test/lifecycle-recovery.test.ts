import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, recipeApprovalHash, transition } from "../src/harness/state.ts";
import { prepareFixForwardWorkspace, verifyFixForwardWorkspace, publishFixForward, acceptFixForwardPull } from "../src/harness/fix-forward.ts";
import { activePullRequest } from "../src/harness/workflow-context.ts";
import type { Runner } from "../src/core/exec.ts";
import { sourceHash, parseWorkflow, type Evidence } from "../src/harness/model.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { acceptObservedMerge } from "../src/harness/lifecycle-land.ts";
import { recordShipVerification, completeShip } from "../src/harness/ship-state.ts";
import { recoveryPlan, stopShipRecovery, reconcileOmiOperation, captureOmiRecoveryBaseline, recordRecoveryBaseline, recordRecoveryVerification, rollbackOmiVersion, rollbackGhaTarget } from "../src/harness/lifecycle-recovery.ts";
import { Value } from "typebox/value";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { claimOmi } from "../src/harness/omi-operation.ts";
import { GhaRollbackRequestSchema } from "../src/harness/recovery-schema.ts";
import { fakeRunner } from "./helpers/runner.ts";
import { OmiRequestSchema } from "../src/harness/omi-ship-schema.ts";
import { omiShipContext, omiRequest } from "../src/harness/omi-ship-context.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";
const repo = "acme/tienda", at = "2026-01-01T00:00:00Z", base = "a".repeat(40), head = "b".repeat(40), merge = "c".repeat(40), previous = "d".repeat(40), nonce = "12345678-1234-4234-8234-123456789abc";
function fixture(action: "stop" | "rollback" | "fix-forward" = "stop", failed = true, provider: "omi" | "gha" = "omi") {
 const target = defaultLifecycleTarget({ id: "delivery", mode: "auto", timeoutSeconds: 60, onFailure: { action, mode: "ask" }, provider: provider === "omi" ? { kind: "omi", service: "api", environment: "stage", mode: "direct" } : { kind: "gha", workflow: "ship.yml", ref: "main", mode: "dispatch", contract: "omi-ship-v1", rollback: { workflow: "rollback.yml", ref: "main", contract: "omi-ship-v1" } }, evidence: { kind: provider === "omi" ? "omi" : "receipt", health: { path: "/health", status: 200 }, version: { path: "/version", versionField: "version", commitField: "commit" } } }); assert.ok("target" in target);
 const block = defaultLifecycleConfig(repo, "main"); block.ship = { status: "configured", targets: [target.target] }; const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "tienda", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let s = life.initializeLifecycle({ workflowId: "root", issue: 42, repo }, pin); s = life.bindLifecycleSubject(s, { id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: "e".repeat(64), mergedSha: null }, { id: "adopt", source: "person", at });
 let state = createWorkflow({ number: 42, title: "Change", body: "Scope", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Change", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at); state.lifecycle = s;
 state.publication = { status: "opened", head, url: `https://github.com/${repo}/pull/42`, number: 42 }; state.pullRequest = { number: 42, url: state.publication.url, head, branch: "feat/work", base: "main", ownership: "adopted" };
 state = acceptObservedMerge(state, { number: 42, state: "closed", draft: false, merged: true, merge_commit_sha: merge, head: { sha: head, ref: "feat/work", repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } }, { source: "external", at }); assert.ok(state.lifecycle.status === "enabled"); const id = state.lifecycle.currentSubject; assert.ok(id);
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "ship1", key: "ship1", kind: "ship", subjectId: id, targetId: "delivery", correlationId: nonce, retryOf: null }, { id: "ship-decision", kind: "ship", subjectId: id, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "person", at }, "process", at);
 return failed ? recordShipVerification(state, "ship1", { state: "failed", proof: null, reason: "health del cambio falló" }, at) : state;
}
function ports(linked: Linked) { return { runtime: linked.runtime(), version: "1.1.0", signal: AbortSignal.timeout(5000), timeoutSeconds: 60, now: () => 0, beforeMutation: async () => {} }; }

test("stop por defecto es durable, preserva merge/PR y no convierte fallo Ship en entrega", () => {
 const state = fixture(), plan = recoveryPlan(state, "delivery:ship1:1"); assert.equal(plan.action, "stop"); const stopped = parseWorkflow(JSON.stringify(stopShipRecovery(state, "delivery:ship1:1", at)));
 assert.equal(stopped.status, "paused"); assert.ok(stopped.lifecycle.status === "enabled" && state.lifecycle.status === "enabled"); assert.equal(stopped.lifecycle.stage, "paused"); assert.deepEqual(stopped.lifecycle.merges, state.lifecycle.merges); assert.deepEqual(stopped.lifecycle.budget, state.lifecycle.budget); assert.deepEqual(stopped.publication, state.publication); assert.deepEqual(stopped.pullRequest, state.pullRequest); assert.throws(() => completeShip(stopped, at));
});

test("cero redisparos materializados impide retry aun con fallas conocidas y presupuesto global disponible", () => {
 const state = fixture(); assert.ok(state.lifecycle.status === "enabled"); const s = state.lifecycle, subjectId = s.currentSubject; assert.ok(subjectId);
 assert.throws(() => life.reserveLifecycleOperation(s, { id: "retry2", key: "retry2", kind: "ship", subjectId, targetId: "delivery", correlationId: nonce + "retry", retryOf: "ship1" }, { id: "retry-decision", kind: "ship", subjectId, targetId: "delivery", configHash: s.pinHash, source: "person", at }, "process", at), /retr|redispar|intento/i);
 assert.equal(state.lifecycle.budget.attemptsUsed, 1);
});

test("rollback sin previa/capacidad/verificador no hace best effort ni llama al proveedor", () => {
 assert.equal(recoveryPlan(fixture("rollback"), "delivery:ship1:1").action, "blocked"); const foreign = fixture("rollback"); assert.equal(recoveryPlan(foreign, "missing").action, "blocked");
});

test("previa capturada antes del efecto permite rollback OMI 1.1.0→1.0.0, recuperado no entregado ni replay", async t => {
 const linked = await linkedProject(t), view = linked.project.services.get("api")!.view, environment = view.environments.find(e => e.name === "stage"); assert.ok(environment); view.versions = [{ tag: "1.0.0", prerelease: false }, { tag: "1.1.0", prerelease: false }]; environment.current_version = "1.0.0"; environment.hostname = "api.omi.test"; environment.last_deployment = { id: "dep_previous", service: "api", environment: "stage", to_version: "1.0.0", status: "exitoso", steps: [], target_instances: 1, created_at: at };
 const pending = fixture("rollback", false), p = { ...ports(linked), fetch: async (url: string | URL | Request) => new Response(String(url).endsWith("/health") ? "ok" : JSON.stringify({ version: environment.current_version, commit: environment.current_version === "1.0.0" ? previous : merge }), { status: 200 }) };
 const captured = await captureOmiRecoveryBaseline(pending, "ship1", p); assert.equal(captured.state, "ready"); assert.ok(captured.baseline);
 assert.throws(() => recordRecoveryBaseline(pending, { ...captured.baseline, previousCommitSha: merge }), /previ|commit|baseline/i);
 let state = parseWorkflow(JSON.stringify(recordRecoveryBaseline(pending, captured.baseline))); state = recordShipVerification(state, "ship1", { state: "failed", proof: null, reason: "health del nuevo cambio falló" }, at);
 assert.equal(recoveryPlan(state, "delivery:ship1:1").action, "rollback"); assert.ok(state.lifecycle.status === "enabled"); const subjectId = state.lifecycle.currentSubject; assert.ok(subjectId);
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "rollback1", key: "rollback1", kind: "rollback", subjectId, targetId: "delivery", correlationId: nonce + "rollback", retryOf: null }, { id: "rollback-decision", kind: "rollback", subjectId, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "person", at }, "process", at);
 environment.current_version = "1.1.0"; environment.last_deployment = { id: "dep_failed", service: "api", environment: "stage", from_version: "1.0.0", to_version: "1.1.0", status: "fallido", steps: [], target_instances: 1, created_at: at };
 const deps = { ...p, version: "1.0.0", recordRequest: async (request: unknown) => { assert.ok(state.lifecycle.status === "enabled"); const op = state.lifecycle.operations.find(o => o.id === "rollback1"); assert.ok(op); assert.ok(Value.Check(OmiRequestSchema, request)); op.shipRequest = request; }, recordQueued: async () => {}, recordDeployment: async (started: { id: string; service: string; environment: "stage" | "prod"; version: string }) => { assert.ok(state.lifecycle.status === "enabled"); const op = state.lifecycle.operations.find(o => o.id === "rollback1"); assert.ok(op); op.deployments = [{ ...started, at }]; } };
 const race = structuredClone(state); race.checkout = { ...race.checkout, root: linked.repo, commonDir: join(linked.repo, ".git") }; race.revision = 0; await mkdir(race.checkout.commonDir); await updateWorkflow(race.checkout, 42, undefined, () => race);
 const saved = await readWorkflow(race.checkout, 42); assert.ok(saved?.lifecycle.status === "enabled"); const raceSubject = saved.lifecycle.currentSubject; assert.ok(raceSubject); const raceHash = saved.lifecycle.pinHash;
 await updateWorkflow(race.checkout, 42, saved.revision, current => { assert.ok(current?.version === 2 && current.lifecycle.status === "enabled"); return { ...current, revision: current.revision + 1, lifecycle: life.reserveLifecycleOperation(current.lifecycle, { id: "late-deploy", key: "late-deploy", kind: "deploy", subjectId: raceSubject, targetId: "delivery", correlationId: nonce + "late", retryOf: null }, { id: "late-decision", kind: "deploy", subjectId: raceSubject, targetId: "delivery", configHash: raceHash, source: "person", at }, "process", at) }; });
 const raceContext = await omiShipContext(race, "rollback1", deps), raceRequest = { ...omiRequest(raceContext, "rollback", "1.0.0"), baselineId: captured.baseline.id, failureDeliveryId: "delivery:ship1:1" };
 await assert.rejects(claimOmi(race, "rollback1", raceRequest, { ...p, workflowStore: { checkout: race.checkout, issue: 42, operationId: "rollback1" } }), /pendiente|inciert|mutación/i); assert.equal(linked.mutations().length, 0);
 linked.workloads.deployments.set("api/stage", [{ id: "dep_other", service: "api", environment: "stage", from_version: "1.1.0", to_version: "2.0.0", status: "en_curso", steps: [{ kind: "inicio", at }], target_instances: 1, created_at: at }]);
 await assert.rejects(rollbackOmiVersion(state, "rollback1", deps), /curso|concurrent|deployment/i); assert.equal(linked.mutations().length, 0); linked.workloads.deployments.delete("api/stage");
 const knownFailed = structuredClone(state); assert.ok(knownFailed.lifecycle.status === "enabled"); const failedOp = knownFailed.lifecycle.operations.find(o => o.id === "rollback1"); assert.ok(failedOp); failedOp.shipRequest = raceRequest; failedOp.deployments = [{ id: "rollback_failed", service: "api", environment: "stage", version: "1.0.0", at }]; knownFailed.lifecycle = life.markLifecycleUnknown(knownFailed.lifecycle, "rollback1", "respuesta perdida", at);
 linked.workloads.deployments.set("api/stage", [{ id: "rollback_failed", service: "api", environment: "stage", from_version: "1.1.0", to_version: "1.0.0", status: "fallido", steps: [], target_instances: 1, created_at: at }]);
 assert.equal((await rollbackOmiVersion(knownFailed, "rollback1", deps)).state, "failed"); assert.equal(linked.mutations().length, 0); linked.workloads.deployments.delete("api/stage");
 const result = await rollbackOmiVersion(state, "rollback1", deps); assert.equal(result.state, "recovered"); assert.ok(result.proof); assert.equal(environment.current_version, "1.0.0");
 for (const problem of ["destination", "cause", "verifier"]) { const forged = structuredClone(result); assert.ok(forged.proof?.kind === "omi-rollback"); if (problem === "destination") forged.proof.destination.environment = "prod"; if (problem === "cause") forged.proof.failureDeliveryId = "unknown"; if (problem === "verifier") forged.proof.probes.version = "not-configured"; assert.throws(() => recordRecoveryVerification(state, "rollback1", "delivery:ship1:1", forged, at)); }
 const attempts = state.lifecycle.status === "enabled" ? state.lifecycle.budget.attemptsUsed : -1;
 state = recordRecoveryVerification(state, "rollback1", "delivery:ship1:1", result, at); assert.equal(state.status, "paused"); assert.notEqual(state.phase, "delivered"); assert.ok(state.lifecycle.status === "enabled"); assert.equal(state.lifecycle.recoveryObservations?.[0]?.result.state, "recovered"); assert.equal(state.lifecycle.budget.attemptsUsed, attempts); assert.equal(state.lifecycle.deliveries?.length, 1); assert.throws(() => completeShip(state, at));
 assert.equal((await rollbackOmiVersion(state, "rollback1", deps)).state, "recovered"); assert.equal(linked.omi.requests.filter(r => r.method === "POST" && r.path.endsWith("/deployments")).length, 1);
});

test("rollback GHA correlaciona workflow/artefacto y SHA previo; recuperado no delivered ni redispatch", async () => {
 let state = fixture("rollback", false, "gha"); assert.ok(state.lifecycle.status === "enabled"); const subjectId = state.lifecycle.currentSubject; assert.ok(subjectId); const hash = state.lifecycle.pinHash, wf = { id: 9, path: ".github/workflows/rollback.yml", ref: "main", sha: "e".repeat(40) };
 state = recordRecoveryBaseline(state, { id: "previous-gha", beforeOperationId: "ship1", kind: "gha", subjectId, targetId: "delivery", configHash: hash, integratedSha: merge, previousVersion: "1.0.0", previousCommitSha: previous, deploymentId: "prior-remote-deployment", evidenceHash: "f".repeat(64), probes: { health: "pass", version: "pass" }, at });
 state = recordShipVerification(state, "ship1", { state: "failed", proof: null, reason: "Ship falló" }, at); assert.ok(state.lifecycle.status === "enabled");
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "rollback1", key: "rollback1", kind: "rollback", subjectId, targetId: "delivery", correlationId: nonce + "rollback", retryOf: null }, { id: "rollback-decision", kind: "rollback", subjectId, targetId: "delivery", configHash: hash, source: "person", at }, "process", at);
 const runner = fakeRunner(); let clock = 0;
 const run = { id: 1003, workflow_id: wf.id, path: wf.path, head_sha: wf.sha, head_branch: "main", event: "workflow_dispatch", display_title: `omi-ship-v1 rollback delivery ${nonce}rollback`, run_attempt: 1, status: "completed", conclusion: "success", created_at: at, updated_at: at, repository: { full_name: repo } };
 const ports = { runner, timeoutSeconds: 60, signal: AbortSignal.timeout(5000), now: () => clock, wait: async (ms: number) => { clock += ms; }, workflow: async () => wf, listRuns: async () => runner.commands.length ? [run] : [], loadReceipt: async () => JSON.stringify({ version: 1, contract: "omi-ship-v1", repo, pr: 42, targetId: "delivery", integratedSha: merge, deployedSha: previous, workflowSha: wf.sha, correlationId: nonce + "rollback", runId: run.id, runAttempt: 1, state: "delivered", versionTag: "1.0.0", deploymentId: "restored-deployment" }), verifyProbes: async () => ({ health: "pass", version: "pass" }), beforeDispatch: async () => {}, recordRequest: async (r: unknown) => { assert.ok(state.lifecycle.status === "enabled" && Value.Check(GhaRollbackRequestSchema, r)); state.lifecycle.operations.find(o => o.id === "rollback1")!.recoveryRequest = r; } };
 const result = await rollbackGhaTarget(state, "rollback1", ports); assert.equal(result.state, "recovered"); assert.ok(result.proof); assert.equal(runner.commands.length, 1); assert.ok(runner.commands[0]?.args.includes(`expected_previous_sha=${previous}`));
 state = recordRecoveryVerification(state, "rollback1", "delivery:ship1:1", result, at); assert.notEqual(state.phase, "delivered"); assert.throws(() => completeShip(state, at)); assert.equal((await rollbackGhaTarget(state, "rollback1", ports)).state, "recovered"); assert.equal(runner.commands.length, 1);
 assert.equal((await rollbackGhaTarget(state, "rollback1", { ...ports, loadReceipt: async () => "{}" })).state, "unknown"); assert.equal(runner.commands.length, 1);
 const hanging = rollbackGhaTarget(state, "rollback1", { ...ports, signal: AbortSignal.timeout(50), listRuns: async () => [], wait: () => new Promise(() => {}) });
 assert.equal((await Promise.race([hanging, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("wait no respetó deadline")), 300))])).state, "unknown");
});

test("fix-forward prepara workspace/C nuevos sin cambiar raíz, publicación ni evidencia de PR42", () => {
 let state = fixture("fix-forward"); state.recipe = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Restaurar entrega aprobada", approach: "Corregir app", scope: ["app"], outOfScope: ["nuevo alcance"], cases: [{ id: "D1", description: "contrato", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 }, route: "direct" }; state.exploration = { references: [{ path: "app.ts", line: 1, detail: "contrato" }], findings: [], approach: "fix", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" }; state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), by: "person", at };
 assert.ok(state.lifecycle.status === "enabled"); const subjectId = state.lifecycle.currentSubject; assert.ok(subjectId);
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "fix1", key: "fix1", kind: "fix-forward", subjectId, targetId: "delivery", correlationId: nonce + "fix", retryOf: null }, { id: "fix-decision", kind: "fix-forward", subjectId, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "person", at }, "process", at);
 const before = structuredClone(state), proposal = { id: "workspace1", failureDeliveryId: "delivery:ship1:1", checkout: { root: "/private/fix-forward", commonDir: "/private/fix-forward/.git", branch: "fix/recovery-43", baseCommit: merge }, base: "main", baseSha: merge, clean: true, containsMerge: true, scope: { source: "person", withinScope: true, risk: "low", scopeHash: recipeApprovalHash(state) }, at };
 state = parseWorkflow(JSON.stringify(prepareFixForwardWorkspace(state, "fix1", proposal))); assert.equal(state.phase, "implement"); assert.ok(state.lifecycle.status === "enabled"); assert.equal(state.lifecycle.activeRecoveryId, "workspace1"); assert.equal(state.lifecycle.recoveryWorkspaces?.[0]?.status, "coding"); assert.deepEqual(state.checkout, before.checkout); assert.deepEqual(state.pullRequest, before.pullRequest); assert.deepEqual(state.publication, before.publication); assert.deepEqual(state.evidence, before.evidence); assert.equal(state.lifecycle.budget.attemptsUsed, 2); assert.equal(state.lifecycle.budget.fixForwardPRsUsed, 1); assert.equal(state.steps.at(-1)?.status, "pending"); assert.equal(state.steps.at(-1)?.red, null); assert.equal(state.steps.at(-1)?.green, null);
 assert.throws(() => verifyFixForwardWorkspace(state, "workspace1", { head: previous, fingerprint: "f".repeat(64), clean: true, ancestor: true }, at), /TDD|verific|rojo|C /i);
 const stepId = state.steps.at(-1)!.id; state = transition(state, { type: "step_started", id: stepId }, at);
 const evidence = (kind: Evidence["kind"], sha = merge): Evidence => ({ id: `fix-${kind}`, kind, command: "npm test", stepId: kind === "verification" ? null : stepId, caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "fixture observed", head: sha, fingerprint: "f".repeat(64), startedAt: at, finishedAt: at });
 state = transition(state, { type: "evidence", evidence: evidence("red") }, at); state = transition(state, { type: "evidence", evidence: evidence("green") }, at); state = transition(state, { type: "step_completed", id: stepId, commit: previous, fingerprint: "f".repeat(64) }, at); state = transition(state, { type: "evidence", evidence: evidence("verification", previous) }, at); state = transition(state, { type: "verified", fingerprint: "f".repeat(64) }, at);
 state = parseWorkflow(JSON.stringify(verifyFixForwardWorkspace(state, "workspace1", { head: previous, fingerprint: "f".repeat(64), clean: true, ancestor: true }, at))); assert.ok(state.lifecycle.status === "enabled"); assert.equal(state.lifecycle.recoveryWorkspaces?.[0]?.status, "verified"); assert.equal(state.lifecycle.budget.fixForwardPRsUsed, 1);
});

test("reconciliar deployment conocido fallido sólo lee; no reenvía POST ni devuelve intentos", async t => {
 const linked = await linkedProject(t), service = linked.project.services.get("api")!.view; service.versions = [{ tag: "1.1.0", prerelease: false }];
 let state = fixture("rollback"); assert.ok(state.lifecycle.status === "enabled"); const sub = state.lifecycle.currentSubject; assert.ok(sub);
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "deploy1", key: "deploy1", kind: "deploy", subjectId: sub, targetId: "delivery", correlationId: nonce + "2", retryOf: null }, { id: "deploy-decision", kind: "deploy", subjectId: sub, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "person", at }, "process", at);
 const p = ports(linked), c = await omiShipContext(state, "deploy1", p); assert.ok(state.lifecycle.status === "enabled"); const op = state.lifecycle.operations.find(o => o.id === "deploy1"); assert.ok(op); op.shipRequest = omiRequest(c, "deploy", "1.1.0"); op.deployments = [{ id: "dep_failed", service: "api", environment: "stage", version: "1.1.0", at }];
 state.lifecycle = life.markLifecycleUnknown(state.lifecycle, "deploy1", "respuesta perdida", at);
 linked.omi.route("GET /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/environments/{environmentName}/deployments", () => ({ status: 200, body: { deployments: [{ id: "dep_failed", service: "api", environment: "stage", from_version: "1.0.0", to_version: "1.1.0", status: "fallido", steps: [], target_instances: 1, created_at: at }] } }));
 const before = structuredClone(state.lifecycle.budget), result = await reconcileOmiOperation(state, "deploy1", p); assert.equal(result.state, "confirmed"); assert.ok(result.receipt); assert.equal(result.receipt.outcome, "failed"); assert.deepEqual(state.lifecycle.budget, before); assert.equal(linked.mutations().length, 0);
});

async function verifiedFixForward(t: import("node:test").TestContext) {
 const root = await mkdtemp(join(tmpdir(), "omi-fix-forward-")); await mkdir(join(root, ".git")); t.after(() => rm(root, { recursive: true, force: true })); const checkout = { root, commonDir: join(root, ".git"), branch: "fix/recovery-43", baseCommit: merge };
 let state = fixture("fix-forward"); state.recipe = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Restaurar entrega aprobada", approach: "Corregir app", scope: ["app"], outOfScope: ["nuevo alcance"], cases: [{ id: "D1", description: "contrato", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 }, route: "direct" }; state.exploration = { references: [{ path: "app.ts", line: 1, detail: "contrato" }], findings: [], approach: "fix", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" }; state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), by: "person", at };
 assert.ok(state.lifecycle.status === "enabled"); const subjectId = state.lifecycle.currentSubject; assert.ok(subjectId);
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, { id: "fix1", key: "fix1", kind: "fix-forward", subjectId, targetId: "delivery", correlationId: nonce + "fix", retryOf: null }, { id: "fix-decision", kind: "fix-forward", subjectId, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "person", at }, "process", at);
 state = parseWorkflow(JSON.stringify(prepareFixForwardWorkspace(state, "fix1", { id: "workspace1", failureDeliveryId: "delivery:ship1:1", checkout, base: "main", baseSha: merge, clean: true, containsMerge: true, scope: { source: "person", withinScope: true, risk: "low", scopeHash: recipeApprovalHash(state) }, at })));
 const stepId = state.steps.at(-1)!.id; state = transition(state, { type: "step_started", id: stepId }, at);
 const evidence = (kind: Evidence["kind"], sha = merge): Evidence => ({ id: `fix-${kind}`, kind, command: "npm test", stepId: kind === "verification" ? null : stepId, caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "fixture observed", head: sha, fingerprint: "f".repeat(64), startedAt: at, finishedAt: at });
 state = transition(state, { type: "evidence", evidence: evidence("red") }, at); state = transition(state, { type: "evidence", evidence: evidence("green") }, at); state = transition(state, { type: "step_completed", id: stepId, commit: previous, fingerprint: "f".repeat(64) }, at); state = transition(state, { type: "evidence", evidence: evidence("verification", previous) }, at); state = transition(state, { type: "verified", fingerprint: "f".repeat(64) }, at);
 return { state: parseWorkflow(JSON.stringify(verifyFixForwardWorkspace(state, "workspace1", { head: previous, fingerprint: "f".repeat(64), clean: true, ancestor: true }, at))), checkout };
}
// GitHub simulado: checkout de recuperación limpio en HEAD previo, issue #42 intacto y PRs por branch.
function fakeGitHub(checkout: { root: string; commonDir: string; branch: string }) {
 const calls: { command: string; args: string[] }[] = [], pull = { number: 43, url: `https://github.com/${repo}/pull/43`, state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: checkout.branch, baseRefName: "main", headRefOid: previous, body: "" };
 const github = { calls, pull, prs: [] as unknown[], runner: { async run(command, args, options) {
  calls.push({ command, args }); let stdout = "";
  if (command === "git") { const a = args.slice(args.indexOf("-C") + 2); if (a[0] === "rev-parse") stdout = a.includes("--show-toplevel") ? checkout.root : a.includes("--git-common-dir") ? checkout.commonDir : previous; else if (a[0] === "symbolic-ref") stdout = `refs/heads/${checkout.branch}`; else if (a[0] === "remote") stdout = `git@github.com:${repo}.git`; }
  else if (args[0] === "issue" && args[1] === "view") stdout = JSON.stringify({ number: 42, title: "Change", body: "Scope", url: `https://github.com/${repo}/issues/42` });
  else if (args[0] === "repo") stdout = JSON.stringify({ nameWithOwner: repo, url: `https://github.com/${repo}` });
  else if (args[0] === "pr" && args[1] === "list") stdout = JSON.stringify(github.prs);
  else if (args[0] === "pr" && args[1] === "create") { pull.body = options?.input ?? ""; github.prs = [pull]; stdout = pull.url; }
  else throw new Error(`Llamada remota inesperada: ${command} ${args.join(" ")}`);
  return { code: 0, stdout, stderr: "" };
 } } as Runner };
 return github;
}

test("fix-forward publica PR43 nuevo ligado a raíz42 con el mismo presupuesto, sin replay ni reabrir PR42", async t => {
 let { state, checkout } = await verifiedFixForward(t); assert.ok(state.lifecycle.status === "enabled"); const subjectId = state.lifecycle.currentSubject; assert.ok(subjectId);
 const push = { id: "push1", key: "push1", kind: "fix-forward-push", subjectId, targetId: "delivery", correlationId: nonce + "push", retryOf: null } as const, decision = { id: "push-decision", kind: "fix-forward-push", subjectId, targetId: "delivery", configHash: state.lifecycle.pinHash, source: "policy", at } as const;
 assert.throws(() => life.reserveLifecycleOperation(state.lifecycle, push, decision, "process", at), /humana|decisión/i, "fix-forward reservado no autoriza push/PR: permiso independiente");
 state.lifecycle = life.reserveLifecycleOperation(state.lifecycle, push, { ...decision, source: "person" }, "process", at); assert.equal(state.lifecycle.budget.attemptsUsed, 3);
 const before = structuredClone(state), github = fakeGitHub(checkout), order: string[] = []; let claimed: unknown = null;
 const deps = { signal: AbortSignal.timeout(5000), runner: { run: (command, args, options) => { if (args.includes("push")) order.push("push"); return github.runner.run(command, args, options); } } as Runner, persistClaim: async (s: unknown) => { order.push("claim"); claimed = s; } };
 const result = await publishFixForward(state, "workspace1", "push1", deps); assert.equal(result.state, "opened"); assert.ok(result.pullRequest); assert.equal(result.pullRequest.number, 43); assert.deepEqual(order, ["claim", "push"], "claim durable antes del efecto");
 const pushes = github.calls.filter(c => c.args.includes("push")), creates = github.calls.filter(c => c.args[0] === "pr" && c.args[1] === "create");
 assert.equal(pushes.length, 1); assert.ok(pushes[0]?.args.includes(`${previous}:refs/heads/fix/recovery-43`)); assert.equal(creates.length, 1); assert.ok(creates[0]?.args.includes("--draft")); assert.ok(creates[0]?.args.includes("main"));
 assert.ok(!github.calls.some(c => c.args.some(a => /^(reopen|ready|merge|edit|close)$/.test(a)) || (c.args[0] === "pr" && c.args.includes("42"))), "PR42 mergeado no se reabre ni edita");
 assert.ok(claimed); state = parseWorkflow(JSON.stringify(claimed)); assert.ok(state.lifecycle.status === "enabled"); assert.equal(state.lifecycle.operations.find(o => o.id === "fix1")?.fixForwardRequest?.sourcePr, 42); assert.equal(state.lifecycle.operations.find(o => o.id === "fix1")?.fixForwardRequest?.rootWorkflowId, "root");
 github.prs = []; assert.equal((await publishFixForward(state, "workspace1", "push1", deps)).state, "unknown", "respuesta perdida sin PR visible: observar, no replay");
 github.prs = [github.pull]; assert.deepEqual((await publishFixForward(state, "workspace1", "push1", deps)).pullRequest, result.pullRequest);
 assert.equal(github.calls.filter(c => c.args.includes("push")).length, 1); assert.equal(github.calls.filter(c => c.args[0] === "pr" && c.args[1] === "create").length, 1);
 assert.throws(() => acceptFixForwardPull(state, "workspace1", "push1", { ...result.pullRequest, number: 42, url: `https://github.com/${repo}/pull/42` }, at), /mergead|reabr|conocido/i);
 assert.throws(() => acceptFixForwardPull(state, "workspace1", "push1", { ...result.pullRequest, head: merge }, at), /HEAD|ajeno/i);
 state = parseWorkflow(JSON.stringify(acceptFixForwardPull(state, "workspace1", "push1", result.pullRequest, at))); assert.ok(state.lifecycle.status === "enabled" && before.lifecycle.status === "enabled");
 assert.deepEqual(state.lifecycle.root, before.lifecycle.root); assert.deepEqual(state.lifecycle.budget, before.lifecycle.budget); assert.equal(state.lifecycle.budget.fixForwardPRsUsed, 1);
 assert.deepEqual(state.pullRequest, before.pullRequest); assert.deepEqual(state.publication, before.publication); assert.deepEqual(state.checkout, before.checkout); assert.deepEqual(state.lifecycle.merges, before.lifecycle.merges);
 const current = state.lifecycle.subjects.find(x => x.id === (state.lifecycle.status === "enabled" ? state.lifecycle.currentSubject : null)); assert.equal(current?.number, 43); assert.equal(current?.mergedSha, null); assert.equal(current?.headSha, previous);
 assert.ok(state.lifecycle.subjects.some(x => x.number === 42 && x.mergedSha === merge)); assert.equal(state.lifecycle.stage, "review"); assert.equal(state.lifecycle.recoveryWorkspaces?.[0]?.status, "opened");
 assert.deepEqual(activePullRequest(state), { number: 43, url: result.pullRequest.url, head: previous, branch: "fix/recovery-43", base: "main", ownership: "adopted" });
 assert.ok(["fix1", "push1"].every(id => { const op = state.lifecycle.status === "enabled" ? state.lifecycle.operations.find(o => o.id === id) : undefined; return op?.status === "confirmed" && op.receipt.outcome === "succeeded"; }));
 assert.deepEqual(parseWorkflow(JSON.stringify(acceptFixForwardPull(state, "workspace1", "push1", result.pullRequest, at))), state, "aceptar dos veces no duplica sujeto ni recibos");
});
