import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile, realpath, stat, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SUPPORTED_RELEASE_PLANNER_HASH, verifyOmiReleasePlan, ReleasePlanSchema } from "../src/harness/omi-release-plan.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash } from "../src/harness/model.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { acceptObservedMerge } from "../src/harness/lifecycle-land.ts";
import { verifyGhaRelease, observeGhaShipReceipt, dispatchGhaShip } from "../src/harness/lifecycle-gha-ship.ts";
import { fakeRunner } from "./helpers/runner.ts";
import { Value } from "typebox/value";
import { recordShipVerification, completeShip } from "../src/harness/ship-state.ts";
import { createGhaShipPorts } from "../src/harness/gha-ship-io.ts";
import { GitHubReadClient } from "../src/harness/lifecycle-github-read.ts";
import type { GhaShipRequest } from "../src/harness/ship-schema.ts";
const repo = "acme/app", at = "2026-01-01T00:00:00Z", head = "b".repeat(40), base = "a".repeat(40), mergedSha = "c".repeat(40), releaseSha = "d".repeat(40), workflowSha = "e".repeat(40), nonce = "12345678-1234-4234-8234-123456789abc";
const payload = Buffer.from("fixture application bytes"), digest = createHash("sha256").update(payload).digest("hex");
function shipping(kind: "release" | "receipt" = "release", mode: "observe" | "dispatch" = "observe", repository = repo) {
 const input = { id: "delivery", timeoutSeconds: 60, provider: { kind: "gha", workflow: kind === "release" ? "release.yml" : "ship.yml", ref: "main", mode, contract: kind === "release" ? "github-release" : "omi-ship-v1" }, evidence: kind === "release" ? { kind: "github-release", assets: ["app-linux-x64.tar.gz"], checksumsAsset: "checksums.txt" } : { kind: "receipt" } };
 const target = defaultLifecycleTarget(input); assert.ok("target" in target); const block = defaultLifecycleConfig(repository, "main"); block.ship = { status: "configured", targets: [target.target] };
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo: repository }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let lifecycle = life.initializeLifecycle({ workflowId: "root", issue: 42, repo: repository }, pin);
 lifecycle = life.bindLifecycleSubject(lifecycle, { id: "subject", repo: repository, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: "f".repeat(64), mergedSha: null }, { id: "adopt", source: "person", at });
 let r = createWorkflow({ number: 42, title: "Change", body: "Scope", url: `https://github.com/${repository}/issues/42`, hash: sourceHash("Change", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at);
 r.lifecycle = lifecycle; r.publication = { status: "opened", head, url: `https://github.com/${repository}/pull/42`, number: 42 }; r.pullRequest = { number: 42, head, branch: "feat/work", base: "main", ownership: "adopted", url: r.publication.url };
 r = acceptObservedMerge(r, { number: 42, state: "closed", draft: false, merged: true, merge_commit_sha: mergedSha, head: { sha: head, ref: "feat/work", repo: { full_name: repository } }, base: { sha: base, ref: "main", repo: { full_name: repository } } }, { source: "external", at });
 assert.ok(r.lifecycle.status === "enabled"); const subjectId = r.lifecycle.currentSubject; assert.ok(subjectId);
 r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "ship1", key: "ship1", kind: "ship", subjectId, targetId: "delivery", correlationId: nonce, retryOf: null }, { id: "ship-decision", kind: "ship", subjectId, targetId: "delivery", configHash: r.lifecycle.pinHash, source: "person", at }, "process", at);
 return r;
}
const release = () => ({ id: 2002, tag_name: "v0.2.0", draft: false, prerelease: false, published_at: "2026-01-01T00:02:00Z", assets: [{ id: 10, name: "app-linux-x64.tar.gz", size: payload.length, state: "uploaded" }, { id: 11, name: "checksums.txt", size: Buffer.byteLength(`${digest}  app-linux-x64.tar.gz\n`), state: "uploaded" }] });
const run = (kind: "release" | "receipt" = "release") => ({ id: 1002, workflow_id: 8, path: `.github/workflows/${kind === "release" ? "release.yml" : "ship.yml"}`, head_sha: kind === "release" ? releaseSha : workflowSha, head_branch: "main", event: kind === "release" ? "push" : "workflow_dispatch", display_title: kind === "release" ? "Release" : `omi-ship-v1 delivery ${nonce}`, run_attempt: 1, status: "completed", conclusion: "success", created_at: at, updated_at: "2026-01-01T00:03:00Z", repository: { full_name: repo } });
const receipt = () => ({ version: 1, contract: "omi-ship-v1", repo, pr: 42, targetId: "delivery", integratedSha: mergedSha, deployedSha: releaseSha, workflowSha, correlationId: nonce, runId: 1002, runAttempt: 1, state: "delivered", versionTag: "v0.2.0", deploymentId: "fixture-deployment" });
function ports(kind: "release" | "receipt" = "release") {
 let clock = 0; const runner = fakeRunner(); let downloads = 0;
 return { runner, timeoutSeconds: 60, signal: AbortSignal.timeout(5000), now: () => clock, wait: async () => { clock += 10000; },
  workflow: async () => ({ id: 8, path: `.github/workflows/${kind === "release" ? "release.yml" : "ship.yml"}`, ref: "main", sha: workflowSha }),
  listReleases: async (): Promise<unknown> => [release()], listRuns: async (): Promise<unknown> => [run(kind)], resolveTag: async () => releaseSha,
  containsCommit: async (ancestor: string, descendant: string) => ancestor === mergedSha && descendant === releaseSha,
  downloadAsset: async (id: number) => { downloads++; return id === 10 ? payload : Buffer.from(`${digest}  app-linux-x64.tar.gz\n`); },
  loadReceipt: async () => JSON.stringify(receipt()), beforeDispatch: async () => {}, recordRequest: async () => {},
  verifyProbes: async () => ({ health: "not-configured", version: "not-configured" }), downloads: () => downloads,
 };
}

test("release requiere tag resuelto que incluya merge, workflow/evento y bytes/digests esperados", async () => {
 const p = ports(), result = await verifyGhaRelease(shipping(), "ship1", p); assert.equal(result.state, "verified"); assert.ok(result.proof); assert.equal(result.proof.kind, "github-release"); assert.equal(result.proof.commitSha, releaseSha); assert.notEqual(releaseSha, mergedSha); assert.equal(p.downloads(), 2); assert.equal(p.runner.commands.length, 0);
});
for (const problem of ["no-release", "wrong-tag", "not-ancestor", "missing-asset", "wrong-digest", "run-failure", "wrong-workflow", "wrong-event", "truncated", "duplicate-asset", "duplicate-release", "tag-moved"]) test(`${problem} nunca se convierte en entrega`, async () => {
 const p = ports();
 if (problem === "no-release") p.listReleases = async () => [];
 if (problem === "wrong-tag") p.resolveTag = async () => "f".repeat(40);
 if (problem === "not-ancestor") p.containsCommit = async () => false;
 if (problem === "missing-asset") p.listReleases = async () => [{ ...release(), assets: [] }];
 if (problem === "wrong-digest") p.downloadAsset = async () => Buffer.from("wrong");
 if (problem === "run-failure") p.listRuns = async () => [{ ...run(), conclusion: "failure" }];
 if (problem === "wrong-workflow") p.listRuns = async () => [{ ...run(), workflow_id: 99 }];
 if (problem === "wrong-event") p.listRuns = async () => [{ ...run(), event: "workflow_dispatch" }];
 if (problem === "truncated") p.listReleases = async () => ({ items: [release()], complete: false });
 if (problem === "duplicate-asset") p.listReleases = async () => [{ ...release(), assets: [release().assets[0], ...release().assets] }];
 if (problem === "duplicate-release") p.listReleases = async () => [release(), release()];
 if (problem === "tag-moved") { let reads = 0; p.resolveTag = async () => reads++ ? workflowSha : releaseSha; }
 const result = await verifyGhaRelease(shipping(), "ship1", p); assert.notEqual(result.state, "verified"); assert.notEqual(result.state, "not-applicable"); assert.equal(p.runner.commands.length, 0);
});

test("un release agrupado puede acreditar más de un merge, sin exigir tag==merge", async () => {
 const p = ports(); p.containsCommit = async (a, b) => [mergedSha, "9".repeat(40)].includes(a) && b === releaseSha;
 assert.equal((await verifyGhaRelease(shipping(), "ship1", p)).state, "verified");
});

test("ausencia de release no es no-aplica; requiere plan determinista o elección humana explícita", async () => {
 const p = ports(); p.listReleases = async () => [];
 assert.equal((await verifyGhaRelease(shipping(), "ship1", p)).state, "unknown");
 const noApply = { source: "person", subjectId: `merged:42:${mergedSha}`, targetId: "delivery", integratedSha: mergedSha, reason: "Este destino no corresponde al cambio", at };
 const result = await verifyGhaRelease(shipping(), "ship1", { ...p, notApplicable: noApply }); assert.equal(result.state, "not-applicable"); assert.equal(p.runner.commands.length, 0);
});

test("omi-ship-v1 correlaciona target/merge/workflow/run/attempt y verifica deployedSHA/probes", async () => {
 const p = ports("receipt"), result = await observeGhaShipReceipt(shipping("receipt"), "ship1", p); assert.equal(result.state, "verified"); assert.ok(result.proof); assert.equal(result.proof.kind, "gha-receipt"); assert.equal(p.runner.commands.length, 0);
 for (const mismatch of [{ integratedSha: head }, { correlationId: "different-correlation" }, { targetId: "foreign" }, { runAttempt: 2 }, { state: "incomplete" }]) {
  assert.notEqual((await observeGhaShipReceipt(shipping("receipt"), "ship1", { ...ports("receipt"), loadReceipt: async () => JSON.stringify({ ...receipt(), ...mismatch }) })).state, "verified");
 }
});

test("receipt observe también reconoce pipeline push automático, sin dispatch", async () => {
 const p = ports("receipt"); p.listRuns = async () => [{ ...run("receipt"), event: "push" }];
 assert.equal((await observeGhaShipReceipt(shipping("receipt", "observe"), "ship1", p)).state, "verified"); assert.equal(p.runner.commands.length, 0);
});

test("observe push usa identidad de pipeline/target/SHA, no exige nonce host posterior al merge", async () => {
 const p = ports("receipt"), providerCorrelation = "provider-correlation-1234";
 p.listRuns = async () => [{ ...run("receipt"), event: "push", display_title: `omi-ship-v1 delivery ${providerCorrelation}` }]; p.loadReceipt = async () => JSON.stringify({ ...receipt(), correlationId: providerCorrelation, integratedSha: releaseSha });
 const result = await observeGhaShipReceipt(shipping("receipt", "observe"), "ship1", p); assert.equal(result.state, "verified"); assert.equal(p.runner.commands.length, 0);
});

test("cambiar la ref de workflow durante el permiso impide efectos antes de renovar", async () => {
 const p = ports("receipt"); let current = workflowSha;
 p.listRuns = async () => []; p.workflow = async () => ({ id: 8, path: ".github/workflows/ship.yml", ref: "main", sha: current }); p.beforeDispatch = async () => { current = "f".repeat(40); };
 await assert.rejects(dispatchGhaShip(shipping("receipt", "dispatch"), "ship1", p)); assert.equal(p.runner.commands.length, 0);
});

test("prueba durable de otro repo/correlación o assets requeridos omitidos no acredita entrega", async () => {
 const r = shipping("receipt"), proof = await observeGhaShipReceipt(r, "ship1", ports("receipt")); assert.ok(proof.proof && proof.proof.kind === "gha-receipt");
 for (const changed of [{ repo: "foreign/repo" }, { correlationId: "other-correlation" }]) assert.throws(() => recordShipVerification(r, "ship1", { ...proof, proof: { ...proof.proof, ...changed } }, at));
 const releaseResult = await verifyGhaRelease(shipping(), "ship1", ports()); assert.ok(releaseResult.proof && releaseResult.proof.kind === "github-release"); assert.throws(() => recordShipVerification(shipping(), "ship1", { ...releaseResult, proof: { ...releaseResult.proof, assets: [] } }, at));
});

test("dispatch tiene claim/permiso independiente, se reconcilia respuesta perdida y no duplica run ya disparado", async () => {
 const p = ports("receipt"); let claimed = 0; p.recordRequest = async () => { claimed++; };
 assert.equal((await dispatchGhaShip(shipping("receipt", "dispatch"), "ship1", p)).state, "verified"); assert.equal(p.runner.commands.length, 0, "Run correlacionado existente sólo se observa");
 const runner = fakeRunner(() => { throw new Error("Response lost"); }); let reads = 0;
 const result = await dispatchGhaShip(shipping("receipt", "dispatch"), "ship1", { ...ports("receipt"), runner, listRuns: async () => reads++ === 0 ? [] : [run("receipt")], recordRequest: async () => { claimed++; } });
 assert.equal(result.state, "verified"); assert.equal(runner.commands.length, 1); assert.equal(claimed, 1); assert.ok(runner.commands[0]?.args.includes(`expected_merge_sha=${mergedSha}`));
});

test("run verde no sustituye probes; completar sólo tras verificar todos los destinos del merge actual", async () => {
 const r = shipping(); assert.ok(r.lifecycle.status === "enabled"); const pin = structuredClone(r.lifecycle.pins[0]); assert.ok(pin); pin.accepted.block.ship.targets[0]!.evidence.health = { path: "/health", status: 200 }; pin.accepted.blockHash = lifecycleHash(pin.accepted.block);
 // Fixture reserva un intento del pin que declara probes: no cambia un permiso existente a escondidas.
 const cfg = r.lifecycle.operations[0]; assert.ok(cfg); cfg.configHash = pin.accepted.blockHash; r.lifecycle.decisions[0]!.configHash = pin.accepted.blockHash; r.lifecycle.pins = [pin]; r.lifecycle.pinHash = pin.accepted.blockHash;
 const p = ports(); p.verifyProbes = async () => ({ health: "fail", version: "not-configured" });
 const failed = await verifyGhaRelease(r, "ship1", p); assert.equal(failed.state, "failed"); assert.throws(() => completeShip(recordShipVerification(r, "ship1", failed, at), at));
 const pass = await verifyGhaRelease(shipping(), "ship1", ports()); const recorded = recordShipVerification(shipping(), "ship1", pass, at); const done = completeShip(recorded, at); assert.equal(done.status, "complete"); assert.equal(done.lifecycle.status, "enabled"); if (done.lifecycle.status === "enabled") assert.equal(done.lifecycle.stage, "delivered");
 assert.throws(() => completeShip(shipping(), at)); assert.throws(() => recordShipVerification(shipping(), "ship1", { ...pass, proof: pass.proof ? { ...pass.proof, integratedSha: head } : null }, at));
});

test("ningún target omitido, manual o vacío se transforma en entrega verificada", async () => {
 const r = shipping(); assert.ok(r.lifecycle.status === "enabled"); const lifecycle = r.lifecycle; const pin = structuredClone(lifecycle.pins[0]); assert.ok(pin); const t = pin.accepted.block.ship.targets[0]; assert.ok(t); pin.accepted.block.ship.targets.push({ ...t, id: "other" }); pin.accepted.blockHash = lifecycleHash(pin.accepted.block);
 lifecycle.pins = [pin]; lifecycle.pinHash = pin.accepted.blockHash; lifecycle.operations[0]!.configHash = pin.accepted.blockHash; lifecycle.decisions[0]!.configHash = pin.accepted.blockHash;
 const result = await verifyGhaRelease(r, "ship1", ports()); assert.equal(result.state, "verified"); assert.throws(() => completeShip(recordShipVerification(r, "ship1", result, at), at));
 const manual = structuredClone(pin); manual.accepted.block.ship = { status: "manual", targets: [] }; manual.accepted.blockHash = lifecycleHash(manual.accepted.block); r.lifecycle = life.applyLifecyclePin(r.lifecycle, manual);
 assert.throws(() => completeShip(r, at)); const done = completeShip(r, at, { source: "person", subjectId: lifecycle.currentSubject, integratedSha: mergedSha, configHash: manual.accepted.blockHash, reason: "Entrega externa comprobada por persona", at }); assert.equal(done.status, "complete"); assert.ok(done.lifecycle.status === "enabled"); assert.equal(done.lifecycle.completion?.outcome, "manual-attested"); assert.notEqual(done.phase, "delivered");
});

test("puertos Ship reales con API fake paginan y bajan assets por IDs, no URLs del payload", async () => {
 const runner = fakeRunner((_command, args) => {
  const endpoint = args.find(a => a.startsWith("repos/")); assert.ok(endpoint); const path = new URL(`https://api.github.com/${endpoint}`).pathname; let body: unknown, status = 200;
  if (path.endsWith("/actions/workflows/release.yml")) body = { id: 8, path: ".github/workflows/release.yml", state: "active" };
  else if (path.endsWith("/git/ref/heads/main")) body = { object: { type: "commit", sha: workflowSha } };
  else if (path.endsWith("/git/ref/tags/main")) { body = {}; status = 404; }
  else if (path.endsWith("/git/ref/tags/v0.2.0")) body = { object: { type: "commit", sha: releaseSha } };
  else if (path.endsWith("/releases/2002/assets")) body = release().assets;
  else if (path.endsWith("/releases")) body = [release()];
  else if (path.endsWith("/actions/workflows/8/runs")) body = { total_count: 1, workflow_runs: [run()] };
  else if (path.includes("/compare/")) body = { status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: mergedSha } };
  else throw new Error(`Unexpected fixture ${path}`);
  return { code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` };
 });
 const client = new GitHubReadClient({ repo, cwd: "/fixture", runner, delay: async () => {} }); const r = shipping();
 const io = createGhaShipPorts(r, "ship1", { client, signal: AbortSignal.timeout(5000), downloadAsset: async id => id === 10 ? payload : Buffer.from(`${digest}  app-linux-x64.tar.gz\n`) });
 assert.equal((await verifyGhaRelease(r, "ship1", io)).state, "verified"); assert.ok(runner.commands.every(c => c.args[c.args.indexOf("--method") + 1] === "GET"));
});

test("planner soportado corresponde exactamente al source inspeccionado, no a una heurística docs", async () => {
 const bytes = await readFile(new URL("../scripts/next-release.ts", import.meta.url)); assert.equal(SUPPORTED_RELEASE_PLANNER_HASH, createHash("sha256").update(bytes).digest("hex"));
});

test("plan no-aplica usa rango completo/tag snapshot previo: docs + otro merge empaquetado sí publica", async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), "omi-release-plan-"))); t.after(() => rm(directory, { recursive: true, force: true }));
 const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GITHUB_REPOSITORY: "chichex/omi-code", GITHUB_RUN_ID: "1002", GITHUB_RUN_ATTEMPT: "1" };
 const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, env, encoding: "utf8" }).trim();
 git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); await writeFile(join(directory, "README.md"), "base"); git("add", "."); git("commit", "-m", "docs: base"); git("tag", "v0.1.0");
 await writeFile(join(directory, "README.md"), "docs merge"); git("commit", "-am", "docs: merge"); const sourceSha = git("rev-parse", "HEAD");
 const script = new URL("../scripts/next-release.ts", import.meta.url); const output = join(directory, "plan.json");
 assert.equal(execFileSync(process.execPath, [script.pathname], { cwd: directory, env: { ...env, GITHUB_SHA: sourceSha, OMI_RELEASE_PLAN_PATH: output }, encoding: "utf8" }), "version=\n");
 const plan: unknown = JSON.parse(await readFile(output, "utf8")); assert.equal((await stat(output)).mode & 0o777, 0o600);
 const req: GhaShipRequest = { kind: "gha-release", repo: "chichex/omi-code", pr: 42, subjectId: "subject", targetId: "delivery", integratedSha: sourceSha, configHash: "f".repeat(64), correlationId: nonce, mode: "observe", workflow: { id: 8, path: ".github/workflows/release.yml", ref: "main", sha: sourceSha } };
 const observedRun = { ...run(), head_sha: sourceSha, repository: { full_name: "chichex/omi-code" } };
 assert.equal(verifyOmiReleasePlan(plan, req, observedRun), true);
 assert.ok(Value.Check(ReleasePlanSchema, plan)); const r = shipping("release", "observe", "chichex/omi-code"); assert.ok(r.lifecycle.status === "enabled"); const lifecycle = r.lifecycle, integrated = lifecycle.subjects.find(s => s.id === lifecycle.currentSubject); assert.ok(integrated); integrated.mergedSha = sourceSha; const mergeFact = lifecycle.merges?.[0]; assert.ok(mergeFact); mergeFact.mergeSha = sourceSha;
 const p = ports(); const observed = await verifyGhaRelease(r, "ship1", { ...p, workflow: async () => req.workflow, listReleases: async () => [], listRuns: async () => [observedRun], loadReleasePlan: async () => JSON.stringify(plan), containsCommit: async (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } } }); assert.equal(observed.state, "not-applicable");
 git("tag", "v0.2.0"); assert.equal(verifyOmiReleasePlan(plan, req, observedRun), true, "Usa el snapshot, no reconstruye con tags posteriores"); git("tag", "-d", "v0.2.0");
 await mkdir(join(directory, "src")); await writeFile(join(directory, "src/app.ts"), "fixture code"); git("add", "."); git("commit", "-m", "fix: pending packaged merge"); await writeFile(join(directory, "README.md"), "other docs"); git("commit", "-am", "docs: last merge"); const next = git("rev-parse", "HEAD"), nextOutput = join(directory, "plan2.json");
 assert.match(execFileSync(process.execPath, [script.pathname], { cwd: directory, env: { ...env, GITHUB_SHA: next, OMI_RELEASE_PLAN_PATH: nextOutput }, encoding: "utf8" }), /version=0\.1\.1/);
 assert.equal(verifyOmiReleasePlan(JSON.parse(await readFile(nextOutput, "utf8")), { ...req, integratedSha: next, workflow: { ...req.workflow, sha: next } }, { ...observedRun, head_sha: next }), false);
 git("tag", "v0.1.1"); await writeFile(join(directory, 'src/a"b.ts'), "packaged"); git("add", "."); git("commit", "-m", "fix: malicious delimiter\x1fREADME.md\n"); const badSource = git("rev-parse", "HEAD"), badOutput = join(directory, "ambiguous.json");
 execFileSync(process.execPath, [script.pathname], { cwd: directory, env: { ...env, GITHUB_SHA: badSource, OMI_RELEASE_PLAN_PATH: badOutput }, encoding: "utf8" });
 assert.equal(verifyOmiReleasePlan(JSON.parse(await readFile(badOutput, "utf8")), { ...req, integratedSha: badSource, workflow: { ...req.workflow, sha: badSource } }, { ...observedRun, head_sha: badSource }), false, "El mensaje no puede ocultar paths empaquetados ni quoting Git");
});

test("declinar/cancelar y contrato github-release dispatch insuficiente no ejecutan workflow", async () => {
 const p = ports("receipt"); await assert.rejects(dispatchGhaShip(shipping("receipt", "dispatch"), "ship1", { ...p, listRuns: async () => [], beforeDispatch: async () => { throw new Error("No autorizado"); } })); assert.equal(p.runner.commands.length, 0);
 const releasePorts = ports(); await assert.rejects(dispatchGhaShip(shipping("release", "dispatch"), "ship1", releasePorts)); assert.equal(releasePorts.runner.commands.length, 0);
});
