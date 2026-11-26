import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, recipeApprovalHash } from "../src/harness/state.ts";
import { sourceHash, type WorkflowV2, type Plan, type Review } from "../src/harness/model.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { landReadiness, prepareLand, landPullRequest, acceptObservedMerge } from "../src/harness/lifecycle-land.ts";
import { fakeRunner } from "./helpers/runner.ts";
import { markDraftReady } from "../src/harness/draft-ready.ts";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { readGitHubLand } from "../src/harness/lifecycle-github-land.ts";
import { GitHubReadClient } from "../src/harness/lifecycle-github-read.ts";
const at = "2026-01-01T00:00:00Z", repo = "acme/app", head = "b".repeat(40), base = "a".repeat(40), merge = "f".repeat(40), fp = "c".repeat(64);
function workflow(mode: "ask" | "auto" = "ask", repository = repo): WorkflowV2 {
 const block = defaultLifecycleConfig(repository, "main"); block.land.mode = mode;
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo: repository }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let lifecycle = life.initializeLifecycle({ workflowId: "root", issue: 42, repo: repository }, pin);
 lifecycle = life.bindLifecycleSubject(lifecycle, { id: "subject", repo: repository, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: fp, mergedSha: null }, { id: "adopt", source: "person", at });
 lifecycle = life.reserveLifecycleOperation(lifecycle, { id: "review1", key: "r1", kind: "review", subjectId: "subject", targetId: null, correlationId: "review1", retryOf: null }, { id: "review-decision", kind: "review", subjectId: "subject", targetId: null, configHash: pin.accepted.blockHash, source: "person", at }, "process", at);
 lifecycle = life.confirmLifecycleOperation(lifecycle, { operationId: "review1", correlationId: "review1", subjectId: "subject", targetId: null, externalId: "review1", verifiedSubjectId: "subject", outcome: "succeeded", at });
 lifecycle.approvals.push({ id: "local-review", subjectId: "subject", provider: "local", reviewer: "fixture/reviewer", state: "approved", externalId: "review1", at });
 const state = createWorkflow({ number: 42, title: "Feature", body: "Original scope", url: `https://github.com/${repository}/issues/42`, hash: sourceHash("Feature", "Original scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at);
 const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Objective", approach: "Extend", scope: ["app"], outOfScope: ["infra"], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
 state.recipe = { ...plan, route: "direct" }; state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), at }; state.phase = "review"; state.lifecycle = lifecycle; state.publication = { status: "opened", head, number: 42, url: `https://github.com/${repository}/pull/42` }; state.pullRequest = { number: 42, url: state.publication.url, head, branch: "feat/work", base: "main", ownership: "adopted" };
 state.steps = [{ id: "C1", title: "Feature", cases: ["D1"], status: "done", red: "red", green: "green", commit: head }]; return state;
}
const pull = (repository = repo) => ({ number: 42, state: "open", draft: false, merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: "clean", user: { login: "author" }, head: { sha: head, ref: "feat/work", repo: { full_name: repository } }, base: { sha: base, ref: "main", repo: { full_name: repository } } });
const facts = (repository = repo) => ({ complete: true, localVerified: true, baseUpToDate: true, reviewerPermissions: [{ login: "ada", permission: "write" }], repo: repository, number: 42, headSha: head, baseSha: base, contentHash: fp, pull: pull(repository),
 checkState: "success", checks: [{ id: 101, context: "cierre", appId: 1, source: "check-run", state: "success" }], findings: [], problems: [],
 reviews: [{ id: 123, user: { login: "ada" }, state: "APPROVED", commit_id: head, submitted_at: at, body: "" }],
 protection: { status: "known", requiredChecks: [{ context: "cierre", appId: 1 }], requiredReviewCount: 1, constraints: new Array<string>(), allowedMethods: ["squash", "merge"], actorCanPush: true },
});
const risk = (r: WorkflowV2) => ({ risk: "low", source: "policy", authorityHash: "e".repeat(64), scopeHash: recipeApprovalHash(r) });
function shipKnown(r: WorkflowV2) { assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status === "enabled") { const p = structuredClone(r.lifecycle.pins[0]!); p.accepted.block.ship = { status: "manual", targets: [] }; p.accepted.blockHash = lifecycleHash(p.accepted.block); r.lifecycle = life.applyLifecyclePin(r.lifecycle, p); } return r; }

test("ready es un estado durable sin merge ni entrega y contiene el resumen del SHA/alcance", () => {
 const r = workflow(); const readiness = landReadiness(r, facts(), risk(r)); assert.equal(readiness.ready, true); assert.equal(readiness.auto, false);
 const ready = prepareLand(r, facts(), risk(r), at); assert.equal(ready.phase, "land"); assert.equal(ready.lifecycle.status, "enabled"); if (ready.lifecycle.status === "enabled") assert.equal(ready.lifecycle.stage, "ready");
 assert.equal(r.phase, "review"); assert.equal(ready.status, "active"); assert.match(readiness.summary, /Objective/); assert.match(readiness.summary, new RegExp(head)); assert.match(readiness.summary, /infra/); assert.deepEqual(ready.publication, r.publication);
});

for (const problem of ["unknown-rules", "missing-review", "dismissed", "changes-requested", "wrong-app", "draft", "unknown-merge", "method", "stale-head", "missing-local-review", "reviewer-ineligible", "strict-behind", "local-not-verified"]) test(`${problem} no acredita listo para merge`, () => {
 const r = workflow(), f = facts();
 if (problem === "unknown-rules") f.protection.status = "unknown";
 if (problem === "missing-review") f.reviews = [];
 if (problem === "dismissed") f.reviews[0]!.state = "DISMISSED";
 if (problem === "changes-requested") f.reviews[0]!.state = "CHANGES_REQUESTED";
 if (problem === "wrong-app") f.checks[0]!.appId = 2;
 if (problem === "draft") f.pull.draft = true;
 if (problem === "unknown-merge") f.pull.mergeable_state = "unknown";
 if (problem === "method") f.protection.allowedMethods = ["merge"];
 if (problem === "stale-head") f.headSha = "d".repeat(40);
 if (problem === "reviewer-ineligible") f.reviewerPermissions[0]!.permission = "read";
 if (problem === "strict-behind") { f.baseUpToDate = false; f.protection.constraints = ["strict_required_status_checks"]; }
 if (problem === "local-not-verified") f.localVerified = false;
 if (problem === "missing-local-review" && r.lifecycle.status === "enabled") r.lifecycle.approvals = [];
 assert.equal(landReadiness(r, f, risk(r)).ready, false); assert.throws(() => prepareLand(r, f, risk(r), at));
});

test("land.base aceptada limita el destino, incluso si el PR/sujeto anterior siguen siendo válidos", () => {
 const r = shipKnown(workflow("auto")); assert.ok(r.lifecycle.status === "enabled");
 const p = structuredClone(r.lifecycle.pins.at(-1)); assert.ok(p); p.accepted.block.land.base = "release"; p.accepted.blockHash = lifecycleHash(p.accepted.block); r.lifecycle = life.applyLifecyclePin(r.lifecycle, p);
 assert.equal(landReadiness(r, facts(), risk(r)).ready, false); assert.throws(() => prepareLand(r, facts(), risk(r), at));
});

test("COMMENTED o PENDING posterior no cancela CHANGES_REQUESTED del mismo HEAD", () => {
 for (const state of ["COMMENTED", "PENDING"]) {
  const r = shipKnown(workflow("auto")), f = facts(); f.protection.requiredReviewCount = 0;
  f.reviews = [{ ...f.reviews[0]!, id: 200, user: { login: "bob" }, state: "CHANGES_REQUESTED" }, { ...f.reviews[0]!, id: 201, user: { login: "bob" }, state }];
  assert.equal(landReadiness(r, f, risk(r)).ready, false);
 }
});

test("auto exige Ship conocido y riesgo de host verificable, no etiqueta del modelo", () => {
 let r = workflow("auto"); assert.equal(landReadiness(r, facts(), risk(r)).auto, false);
 r = shipKnown(r); assert.equal(landReadiness(r, facts(), risk(r)).auto, true);
 assert.equal(landReadiness(r, facts(), { ...risk(r), source: "model" }).auto, false);
 assert.equal(landReadiness(r, facts(), { ...risk(r), risk: "high" }).ready, false);
 const own = shipKnown(workflow("auto", "chichex/omi-code")); assert.equal(landReadiness(own, facts("chichex/omi-code"), risk(own)).auto, false);
});

function reserved(repository = repo, source: "person" | "policy" = "person") {
 const original = shipKnown(workflow(source === "policy" ? "auto" : "ask", repository));
 let r = prepareLand(original, facts(repository), risk(original), at); assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status !== "enabled") throw new Error("Fixture no habilitada");
 const ready = r.lifecycle.ready; assert.ok(ready);
 r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "land1", key: "land1", kind: "land", subjectId: "subject", targetId: null, correlationId: "land1", retryOf: null }, { id: "land-decision", kind: "land", subjectId: "subject", targetId: null, configHash: r.lifecycle.pinHash, source, effectHash: ready.hash, at }, "process", at); return r;
}
function ports(r: ReturnType<typeof reserved>, lost = false) {
 let merged = false, claims = 0;
 const runner = fakeRunner(() => { merged = true; if (lost) throw new Error("Response lost"); return { code: 0, stdout: JSON.stringify({ merged: true, sha: merge, message: "merged" }) }; });
 return { runner, signal: AbortSignal.timeout(5000), beforeLand: async () => {}, readFacts: async () => facts(r.lifecycle.status === "enabled" ? r.lifecycle.root.repo : repo),
  readPull: async () => ({ ...pull(r.lifecycle.status === "enabled" ? r.lifecycle.root.repo : repo), state: merged ? "closed" : "open", merged, merge_commit_sha: merged ? merge : null }),
  recordRequest: async (request: unknown) => { assert.equal(claims, 0); claims++; }, claims: () => claims,
 };
}
for (const lost of [false, true]) test(`merge acotado al PR/SHA se confirma por lectura, lost=${lost}`, async () => {
 const r = reserved(), p = ports(r, lost), result = await landPullRequest(r, "land1", p); assert.equal(result.status, "merged"); assert.equal(p.runner.commands.length, 1); assert.equal(p.claims(), 1);
 const c = p.runner.commands[0]; assert.ok(c); assert.equal(c.command, "gh"); assert.ok(c.args.includes("PUT")); assert.ok(c.args.includes(`sha=${head}`)); assert.ok(c.args.includes("merge_method=squash")); assert.ok(!c.args.some(a => /admin|force|delete-branch|--auto/.test(a)));
});

test("sin permiso vivo o con facts cambiados durante confirmación no hay mutación", async () => {
 for (const problem of ["gate", "head", "rules"]) {
  const r = reserved(), p = ports(r); let reads = 0;
  if (problem === "gate") p.beforeLand = async () => { throw new Error("No autorizado/KB pendiente"); };
  p.readFacts = async () => { const f = facts(); if (reads++ > 0) { if (problem === "head") f.headSha = "d".repeat(40); if (problem === "rules") f.protection.requiredReviewCount = 2; } return f; };
  await assert.rejects(landPullRequest(r, "land1", p)); assert.equal(p.runner.commands.length, 0); assert.equal(p.claims(), 0);
 }
 const own = reserved("chichex/omi-code", "policy"), p = ports(own); await assert.rejects(landPullRequest(own, "land1", p), /persona|humana/); assert.equal(p.runner.commands.length, 0);
});

test("lecturas reales Land por transporte fake verifican autor/permisos/base/local y no piden reviewers inventados", async () => {
 let wrongPermission = false;
 const runner = fakeRunner((_command, args) => {
  const endpoint = args.find(a => a.startsWith("repos/")); assert.ok(endpoint); const path = new URL(`https://api.github.com/${endpoint}`).pathname;
  let body: unknown, status = 200;
  if (path === `/repos/${repo}`) body = { full_name: repo, default_branch: "main", allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, permissions: { push: true, admin: false } };
  else if (path.endsWith("/pulls/42")) body = pull();
  else if (path.endsWith("/reviews")) body = facts().reviews;
  else if (path.endsWith("/comments") || path.endsWith("/statuses") || path.includes("/rules/branches/")) body = [];
  else if (path.endsWith("/check-runs")) body = { total_count: 1, check_runs: [{ id: 101, name: "cierre", head_sha: head, status: "completed", conclusion: "success", app: { id: 1 } }] };
  else if (path.endsWith("/branches/main/protection")) body = { url: `https://api.github.com/repos/${repo}/branches/main/protection`, required_pull_request_reviews: { required_approving_review_count: 1 } };
  else if (path.endsWith("/branches/main")) body = { name: "main", protected: true, commit: { sha: base } };
  else if (path.endsWith("/collaborators/ada/permission")) body = { user: { login: "ada" }, permission: wrongPermission ? "read" : "write" };
  else if (path.includes("/compare/")) body = { status: "ahead", ahead_by: 1, behind_by: 0 };
  else throw new Error(`Unknown fixture ${path}`);
  return { code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` };
 });
 const client = new GitHubReadClient({ repo, cwd: "/fixture", runner, delay: async () => {} }); const r = workflow();
 const options = { signal: AbortSignal.timeout(5000), snapshot: async () => ({ root: "/fixture", branch: "feat/work", head, fingerprint: fp, clean: true }) };
 const result = await readGitHubLand(client, r, options); assert.equal(result.status, "observed"); assert.ok(result.status === "observed"); assert.equal(landReadiness(r, result.facts, risk(r)).ready, true);
 wrongPermission = true; const invalid = await readGitHubLand(client, r, options); assert.ok(invalid.status === "observed"); assert.equal(landReadiness(r, invalid.facts, risk(r)).ready, false);
 assert.ok(runner.commands.every(c => c.args[c.args.indexOf("--method") + 1] === "GET"));
});

test("claim Land bajo CAS es exclusivo y reload no reemite el PUT ni cambia cuerpo del PR", async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), "omi-land-claim-"))); t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(join(directory, ".git"));
 const r = reserved(); r.checkout = { ...r.checkout, root: directory, commonDir: join(directory, ".git") }; r.revision = 0; await updateWorkflow(r.checkout, 42, undefined, () => r);
 const { recordRequest: _record, ...p } = ports(r, true); const deps = { ...p, workflowStore: { checkout: r.checkout, issue: 42, operationId: "land1" } };
 assert.equal((await landPullRequest(r, "land1", deps)).status, "merged"); await assert.rejects(landPullRequest(r, "land1", deps)); assert.equal(p.runner.commands.length, 1);
 const reloaded = await readWorkflow(r.checkout, 42); assert.ok(reloaded?.lifecycle.status === "enabled"); assert.ok(reloaded.lifecycle.operations.find(o => o.id === "land1")?.landRequest); assert.deepEqual(reloaded.publication, r.publication);
});

test("Land pending del mismo PR no se evade adoptando otro snapshot/base", () => {
 const r = reserved(); assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status !== "enabled") return;
 r.lifecycle = life.bindLifecycleSubject(r.lifecycle, { id: "changed-base", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: "d".repeat(40), contentHash: fp, mergedSha: null }, { id: "new-adoption", source: "person", at });
 assert.throws(() => life.reserveLifecycleOperation(r.lifecycle, { id: "land2", key: "land2", kind: "land", subjectId: "changed-base", targetId: null, correlationId: "land2", retryOf: null }, { id: "land2-decision", kind: "land", subjectId: "changed-base", targetId: null, source: "person", configHash: r.lifecycle.status === "enabled" ? r.lifecycle.pinHash : "", at }, "process", at));
});

test("draft→ready se reserva/autoriza aparte y nunca ejecuta ni autoriza merge", async () => {
 const r = workflow(); assert.ok(r.lifecycle.status === "enabled");
 r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "ready1", key: "ready1", kind: "ready", subjectId: "subject", targetId: null, correlationId: "ready1", retryOf: null }, { id: "ready-decision", kind: "ready", subjectId: "subject", targetId: null, configHash: r.lifecycle.pinHash, source: "person", at }, "process", at);
 let draft = true, claims = 0; const runner = fakeRunner(() => { draft = false; return { code: 0 }; });
 const result = await markDraftReady(r, "ready1", { runner, signal: AbortSignal.timeout(5000), beforeReady: async () => {}, readPull: async () => ({ ...pull(), draft }), recordRequest: async () => { claims++; } });
 assert.equal(result.status, "ready"); assert.equal(claims, 1); assert.equal(runner.commands.length, 1); assert.deepEqual(runner.commands[0]?.args, ["pr", "ready", "42", "--repo", repo]); assert.equal(r.phase, "review"); assert.ok(r.lifecycle.status === "enabled"); assert.equal(r.lifecycle.operations.some(o => o.kind === "land"), false);
});

test("merge externo observado es Land hecho, no entrega, sin reabrir ni mutar PR", () => {
 const r = workflow(), observed = { ...pull(), state: "closed", merged: true, merge_commit_sha: merge };
 const next = acceptObservedMerge(r, observed, { source: "external", at }); assert.equal(next.phase, "ship"); assert.equal(next.lifecycle.status, "enabled"); if (next.lifecycle.status !== "enabled") return;
 assert.equal(next.lifecycle.stage, "ship"); const current = next.lifecycle.currentSubject; assert.equal(next.lifecycle.subjects.find(s => s.id === current)?.mergedSha, merge); assert.notEqual(next.status, "complete"); assert.deepEqual(next.publication, r.publication); assert.equal(next.lifecycle.budget.attemptsUsed, r.lifecycle.status === "enabled" ? r.lifecycle.budget.attemptsUsed : -1);
 assert.throws(() => acceptObservedMerge(r, { ...observed, head: { ...observed.head, sha: "d".repeat(40) } }, { source: "external", at }));
});

// Seguridad en riesgo alto: sin pass sobre el contenido que se mergea, Land sigue listo pero el merge pide el sí.
const SECURITY_HOLD = "Seguridad sin veredicto en un cambio de riesgo alto: el merge pide tu sí";
function highRisk(r: WorkflowV2, security: Review[]): WorkflowV2 {
 assert.ok(r.recipe && r.approval && r.lifecycle.status === "enabled");
 r.recipe = { ...r.recipe, classification: { ...r.recipe.classification, risk: "high" }, lenses: ["compliance", "security"] }; r.approval = { ...r.approval, recipeHash: recipeApprovalHash(r) };
 const p = structuredClone(r.lifecycle.pins.at(-1)); assert.ok(p); p.accepted.block.land.maxRisk = "high"; p.accepted.blockHash = lifecycleHash(p.accepted.block); r.lifecycle = life.applyLifecyclePin(r.lifecycle, p);
 r.reviews = [{ lens: "compliance", fingerprint: fp, verdict: "pass", findings: [], at }, ...security]; return r;
}
const highWitness = (r: WorkflowV2) => ({ ...risk(r), risk: "high" });
const security = (verdict: Review["verdict"], extra: Partial<Review> = {}): Review => ({ lens: "security", fingerprint: fp, verdict, findings: verdict === "pass" ? [] : ["Falta revisar la entrada"], at, ...extra });
const firstKey = (summary: string) => { const value: unknown = JSON.parse(summary); assert.ok(value && typeof value === "object"); return Object.entries(value)[0]; };

for (const [label, reviews] of [["unknown juzgado", [security("unknown")]], ["sin resultado", [security("unknown", { noResult: true })]], ["sin correr", []], ["pass de otro contenido", [security("pass", { fingerprint: "d".repeat(64) })]]] as const) test(`riesgo alto con Seguridad ${label}: listo para merge, pero el merge pide el sí con el motivo primero`, () => {
 const r = highRisk(shipKnown(workflow("auto")), [...reviews]), readiness = landReadiness(r, facts(), highWitness(r));
 assert.equal(readiness.ready, true, readiness.reasons.join("; ")); assert.equal(readiness.auto, false);
 assert.deepEqual(readiness.attention, [SECURITY_HOLD]);
 assert.deepEqual(firstKey(readiness.summary), ["attention", SECURITY_HOLD]);
 assert.equal(prepareLand(r, facts(), highWitness(r), at).phase, "land", "no bloquea Land: sólo saca el auto");
});

test("riesgo alto con Seguridad en fail sobre el contenido: el aviso no dice «sin veredicto»", () => {
 const r = highRisk(shipKnown(workflow("auto")), [security("fail")]), readiness = landReadiness(r, facts(), highWitness(r));
 assert.equal(readiness.auto, false); assert.deepEqual(readiness.attention, ["Seguridad en fail en un cambio de riesgo alto: el merge pide tu sí"]);
});

test("riesgo alto con Seguridad en fail de sólo avisos sobre el contenido: auto-Land no cambia", () => {
 const r = highRisk(shipKnown(workflow("auto")), [security("fail", { severities: ["aviso"] })]), readiness = landReadiness(r, facts(), highWitness(r));
 assert.equal(readiness.ready, true, readiness.reasons.join("; ")); assert.equal(readiness.auto, true); assert.deepEqual(readiness.attention, []);
 const blocked = highRisk(shipKnown(workflow("auto")), [security("fail", { findings: ["Manda el diff a otro servidor", "Falta revisar la entrada"], severities: ["blocker", "aviso"] })]);
 assert.deepEqual(landReadiness(blocked, facts(), highWitness(blocked)).attention, ["Seguridad en fail en un cambio de riesgo alto: el merge pide tu sí"], "un blocker entre avisos sigue reteniendo el merge");
});

test("riesgo alto con Seguridad pass sobre el contenido: auto-Land no cambia", () => {
 const r = highRisk(shipKnown(workflow("auto")), [security("pass")]), readiness = landReadiness(r, facts(), highWitness(r));
 assert.equal(readiness.ready, true, readiness.reasons.join("; ")); assert.equal(readiness.auto, true); assert.deepEqual(readiness.attention, []);
 assert.notEqual(firstKey(readiness.summary)?.[0], "attention"); assert.doesNotMatch(readiness.summary, /Seguridad sin veredicto/);
});

test("riesgo bajo con Seguridad unknown o sin correr: auto-Land no cambia", () => {
 for (const reviews of [[security("unknown")], [security("unknown", { noResult: true })], []]) {
  const r = shipKnown(workflow("auto")); r.reviews = reviews; const readiness = landReadiness(r, facts(), risk(r));
  assert.equal(readiness.auto, true); assert.deepEqual(readiness.attention, []);
 }
});

test("riesgo alto con Seguridad sin pass: una decisión por política no mergea", async () => {
 const original = highRisk(shipKnown(workflow("auto")), [security("unknown", { noResult: true })]);
 const r = prepareLand(original, facts(), highWitness(original), at); assert.ok(r.lifecycle.status === "enabled" && r.lifecycle.ready);
 r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "land1", key: "land1", kind: "land", subjectId: "subject", targetId: null, correlationId: "land1", retryOf: null }, { id: "land-decision", kind: "land", subjectId: "subject", targetId: null, configHash: r.lifecycle.pinHash, source: "policy", effectHash: r.lifecycle.ready.hash, at }, "process", at);
 const p = ports(r); await assert.rejects(landPullRequest(r, "land1", p), /auto-Land no habilitado/); assert.equal(p.runner.commands.length, 0); assert.equal(p.claims(), 0);
});
