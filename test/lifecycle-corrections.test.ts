import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fixedGitPush } from "../src/harness/fixed-git-push.ts";
import type { Runner } from "../src/core/exec.ts";
import { createWorkflow, transition, recipeApprovalHash, isApproved } from "../src/harness/state.ts";
import { sourceHash, type WorkflowV2, type Plan, type Evidence } from "../src/harness/model.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { fakeRunner } from "./helpers/runner.ts";
import { Value } from "typebox/value";
import { CorrectionPushRequestSchema } from "../src/harness/correction-schema.ts";
import { pushPostPrCorrection, acceptCorrectionPush } from "../src/harness/correction-push.ts";
import { adoptPostPrWorkflow, preparePostPrCorrection, activatePostPrCorrection, verifyPostPrCorrection, retryPostPrCorrection } from "../src/harness/lifecycle-corrections.ts";
const at = "2026-01-01T00:00:00Z", repo = "acme/app", base = "a".repeat(40), head = "b".repeat(40), nextHead = "d".repeat(40), fingerprint = "c".repeat(64), nextFingerprint = "e".repeat(64);
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Feature", approach: "Extend", scope: ["app"], outOfScope: ["new functionality"], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const send = (r: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(r, event, at);
function evidence(kind: Evidence["kind"], id: string = kind, stepId: string | null = ["red", "green"].includes(kind) ? "C1" : null, sha = head, fp = fingerprint): Evidence {
 return { id, kind, stepId, caseId: "D1", command: "npm test", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "observed fixture", head: sha, fingerprint: fp, startedAt: at, finishedAt: at };
}
function draft() {
 let r = createWorkflow({ number: 42, title: "Feature", body: "Scope", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Feature", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at);
 r = send(r, { type: "explored", exploration: { references: [{ path: "app.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" } }); r = send(r, { type: "inferences", inferences: [] }); r = send(r, { type: "planned", plan }); r = send(r, { type: "approved" }); r = send(r, { type: "step_started", id: "C1" });
 r = send(r, { type: "evidence", evidence: evidence("red") }); r = send(r, { type: "evidence", evidence: evidence("green") }); r = send(r, { type: "step_completed", id: "C1", commit: head, fingerprint }); r = send(r, { type: "evidence", evidence: evidence("verification") }); r = send(r, { type: "verified", fingerprint }); r = send(r, { type: "publishing", head, bodyHash: "legacy-body-hash" }); return send(r, { type: "published", head, url: `https://github.com/${repo}/pull/42`, number: 42 });
}
const subject = () => ({ id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: fingerprint, mergedSha: null });
function pin() { const block = defaultLifecycleConfig(repo, "main"); return { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } }; }
const adoption = { id: "adopt", source: "person", at };
function reviewing(): WorkflowV2 {
 const r = adoptPostPrWorkflow(draft(), pin(), subject(), adoption); assert.equal(r.lifecycle.status, "enabled");
 let lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "review", key: "review", kind: "review", subjectId: "subject", targetId: null, correlationId: "review-correlation", retryOf: null }, { id: "review-decision", kind: "review", subjectId: "subject", targetId: null, configHash: pin().accepted.blockHash, source: "person", at }, "process", at);
 lifecycle = life.confirmLifecycleOperation(lifecycle, { operationId: "review", correlationId: "review-correlation", subjectId: "subject", targetId: null, verifiedSubjectId: "subject", externalId: "review:1", outcome: "succeeded", at });
 lifecycle = life.ingestLifecycleFinding(lifecycle, { id: "F1", provider: "github", externalId: "123", operationId: "review", subjectId: "subject", text: "Manejar error del app aprobado", severity: "low", resolved: false, outdated: false, at });
 const hash = lifecycle.ledger[0]!.observations[0]!.hash;
 lifecycle = life.disposeLifecycleFinding(lifecycle, { findingId: "F1", subjectId: "subject", observationHash: hash, status: "accepted", evidenceIds: [], reason: "validado", at }); return { ...r, lifecycle };
}
const proposal = (r: WorkflowV2) => ({ operationId: "correction1", findingIds: ["F1"], scope: { source: "person", scopeHash: recipeApprovalHash(r), withinScope: true, risk: "low" }, at });
function coding() {
 let r = reviewing(); r = preparePostPrCorrection(r, proposal(r)); assert.equal(r.lifecycle.status, "enabled");
 const lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "correction1", key: "correction1", kind: "correction", subjectId: "subject", targetId: null, correlationId: "correction-correlation", retryOf: null }, { id: "correction-decision", kind: "correction", subjectId: "subject", targetId: null, configHash: pin().accepted.blockHash, source: "person", at }, "process", at);
 return activatePostPrCorrection({ ...r, lifecycle }, "correction1", at);
}
function committed() {
 let r = coding(); const step = r.steps.at(-1); assert.ok(step); r = send(r, { type: "step_started", id: step.id });
 r = send(r, { type: "evidence", evidence: evidence("red", "post-red", step.id, head, nextFingerprint) }); r = send(r, { type: "evidence", evidence: evidence("green", "post-green", step.id, head, nextFingerprint) }); r = send(r, { type: "step_completed", id: step.id, commit: nextHead, fingerprint: nextFingerprint });
 return r;
}
function verified() {
 let r = committed();
 r = send(r, { type: "evidence", evidence: evidence("verification", "post-verification", null, nextHead, nextFingerprint) }); r = send(r, { type: "verified", fingerprint: nextFingerprint });
 return r;
}
const corrected = () => ({ ...subject(), id: "subject2", headSha: nextHead, contentHash: nextFingerprint });

test("histórico done sigue terminal hasta adopción humana explícita con ownership y HEAD", () => {
 const historical = draft(); assert.equal(historical.status, "complete"); assert.equal(historical.lifecycle.status, "disabled");
 const r = adoptPostPrWorkflow(historical, pin(), subject(), adoption); assert.equal(r.phase, "review"); assert.equal(r.status, "active"); assert.deepEqual(r.publication, historical.publication); assert.equal(r.pullRequest?.number, 42); assert.equal(r.pullRequest?.ownership, "adopted"); assert.deepEqual(historical.lifecycle, { status: "disabled" });
 for (const bad of [{ ...subject(), number: 43 }, { ...subject(), branch: "foreign" }, { ...subject(), headSha: nextHead }, { ...subject(), mergedSha: nextHead }]) assert.throws(() => adoptPostPrWorkflow(historical, pin(), bad, adoption));
 assert.throws(() => adoptPostPrWorkflow(historical, pin(), subject(), { ...adoption, source: "policy" }));
});

test("corrección postPR conserva publicación, aprobación, evidencia previa y presupuesto pre-draft separado", () => {
 const before = reviewing(), r = coding(); assert.equal(r.phase, "implement"); assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status !== "enabled") return;
 assert.equal(r.lifecycle.stage, "corrections"); assert.equal(r.lifecycle.budget.roundsUsed, 1); assert.equal(r.lifecycle.budget.attemptsUsed, 2); assert.equal(r.round, before.round); assert.equal(r.maxRounds, 3); assert.equal(isApproved(r), true);
 assert.deepEqual(r.publication, before.publication); assert.deepEqual(r.pullRequest, before.pullRequest); assert.deepEqual(r.evidence, before.evidence); assert.equal(r.steps[0]?.commit, head); assert.equal(r.steps.at(-1)?.id, "C2"); assert.deepEqual(r.steps.at(-1)?.cases, ["D1"]); assert.equal(r.steps.at(-1)?.red, null);
 assert.throws(() => send(r, { type: "retry", reason: "no borrar PR" }));
});

for (const problem of ["scope", "risk", "hash", "finding", "human-required", "stale"]) test(`agrupación ${problem} no abre permiso de código`, () => {
 const r = reviewing(); const p = proposal(r);
 if (problem === "scope") p.scope.withinScope = false;
 if (problem === "risk") p.scope.risk = "high";
 if (problem === "hash") p.scope.scopeHash = "wrong";
 if (problem === "finding") p.findingIds = ["foreign"];
 if (problem === "human-required" && r.lifecycle.status === "enabled") r.lifecycle.ledger[0]!.dispositions[0]!.status = "human-required";
 if (problem === "stale" && r.lifecycle.status === "enabled") r.lifecycle = life.bindLifecycleSubject(r.lifecycle, corrected(), adoption);
 assert.throws(() => preparePostPrCorrection(r, p));
});

test("la nueva C exige rojo/verde propios; no puede usar el commit ni los D verdes pre-PR", () => {
 let r = coding(); r = send(r, { type: "step_started", id: "C2" });
 assert.throws(() => send(r, { type: "evidence", evidence: evidence("green", "early", "C2") }));
 assert.throws(() => verifyPostPrCorrection(r, "correction1", corrected(), { clean: true, ancestor: true }, at));
 const done = verified(); assert.throws(() => send(done, { type: "publishing", head: nextHead, bodyHash: "no-duplicate-pr" })); assert.throws(() => send(done, { type: "retry", reason: "post-PR no borra publication" })); const ready = verifyPostPrCorrection(done, "correction1", corrected(), { clean: true, ancestor: true }, at);
 assert.equal(ready.lifecycle.status, "enabled"); if (ready.lifecycle.status !== "enabled") return;
 assert.equal(ready.lifecycle.currentSubject, "subject2"); assert.equal(ready.lifecycle.budget.roundsUsed, 1); assert.equal(ready.pullRequest?.head, head, "HEAD remoto sólo cambia después de observar push");
 assert.equal(ready.lifecycle.operations.find(o => o.id === "correction1")?.status, "confirmed"); assert.equal(ready.lifecycle.checks.filter(c => c.subjectId === "subject2").length, 0);
 assert.throws(() => verifyPostPrCorrection(done, "correction1", { ...corrected(), headSha: head, contentHash: fingerprint }, { clean: true, ancestor: true }, at));
 assert.throws(() => verifyPostPrCorrection(done, "correction1", corrected(), { clean: false, ancestor: true }, at));
 assert.throws(() => verifyPostPrCorrection(done, "correction1", corrected(), { clean: true, ancestor: false }, at));
});

function pushing() {
 const r = verifyPostPrCorrection(verified(), "correction1", corrected(), { clean: true, ancestor: true }, at); assert.equal(r.lifecycle.status, "enabled");
 const lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "push1", key: "push1", kind: "push", subjectId: "subject2", targetId: null, correlationId: "push-correlation", retryOf: null }, { id: "push-decision", kind: "push", subjectId: "subject2", targetId: null, configHash: pin().accepted.blockHash, source: "person", at }, "process", at); return { ...r, lifecycle };
}
function pushPorts(r: ReturnType<typeof pushing>, lost = false) {
 let remoteHead = head, claims = 0, origin = `https://github.com/${repo}.git`; 
 const currentPr = async () => ({ number: 42, state: "open", draft: true, merged: false, merge_commit_sha: null, head: { sha: remoteHead, ref: "feat/work", repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } });
 const runner = fakeRunner((_command, args) => { if (args.includes("get-url")) return { stdout: `${origin}\n` }; if (!args.includes("push")) return { code: 0 }; remoteHead = nextHead; if (lost) throw new Error("Response lost"); return { code: 0 }; });
 return { runner, repository: async () => ({ full_name: repo, default_branch: "main" }), signal: AbortSignal.timeout(5000), beforePush: async () => {}, currentPr, snapshot: async () => ({ head: nextHead, fingerprint: nextFingerprint, clean: true, branch: "feat/work", ancestor: true }),
  recordRequest: async (input: unknown) => { assert.equal(claims, 0, "claim exclusivo; recuperar sólo observa"); assert.ok(Value.Check(CorrectionPushRequestSchema, input)); claims++; const op = r.lifecycle.operations.find(o => o.id === "push1"); assert.ok(op); op.pushRequest = input; }, claims: () => claims, changeOrigin: (url: string) => { origin = url; },
 };
}
for (const lost of [false, true]) test(`push normal fija SHA/ref del mismo PR; respuesta perdida=${lost} no redispacha`, async () => {
 const r = pushing(), p = pushPorts(r, lost), result = await pushPostPrCorrection(r, "push1", p); assert.equal(result.status, "confirmed"); assert.equal(p.runner.commands.filter(c => c.args.includes("push")).length, 1); assert.equal(p.claims(), 1);
 const command = p.runner.commands.find(c => c.args.includes("push")); assert.ok(command); assert.equal(command.command, "git"); assert.ok(command.args.includes(`${nextHead}:refs/heads/feat/work`)); assert.ok(command.args.includes("--no-follow-tags")); assert.ok(command.args.includes("--no-mirror")); assert.ok(command.args.includes(`https://github.com/${repo}.git`)); assert.ok(!command.args.includes("origin"), "el efecto no vuelve a resolver un alias mutable"); assert.ok(!command.args.some(a => a.includes("--force") || a.startsWith("+") || a.endsWith(":refs/heads/main")));
 const done = acceptCorrectionPush(r, "push1", await p.currentPr(), at); assert.equal(done.phase, "review"); assert.equal(done.pullRequest?.number, 42); assert.equal(done.pullRequest?.head, nextHead); assert.deepEqual(done.publication, r.publication); assert.equal(done.lifecycle.status, "enabled"); if (done.lifecycle.status === "enabled") { assert.equal(done.lifecycle.budget.roundsUsed, 1); assert.equal(done.lifecycle.budget.attemptsUsed, 3); }
 await assert.rejects(pushPostPrCorrection(r, "push1", p)); assert.equal(p.runner.commands.filter(c => c.args.includes("push")).length, 1);
});

test("cambiar origin durante el claim no desvía el efecto del destino literal validado", async () => {
 const r = pushing(), p = pushPorts(r), claim = p.recordRequest;
 p.recordRequest = async input => { await claim(input); p.changeOrigin("https://github.com/foreign/app.git"); };
 assert.equal((await pushPostPrCorrection(r, "push1", p)).status, "confirmed");
 const push = p.runner.commands.find(c => c.args.includes("push")); assert.ok(push); assert.ok(push.args.includes(`https://github.com/${repo}.git`)); assert.ok(!push.args.includes("origin"));
});

test("una reserva unknown bloquea también checks y completar C por las tools nativas", () => {
 let r = coding(); r = send(r, { type: "step_started", id: "C2" }); r = send(r, { type: "evidence", evidence: evidence("red", "post-red", "C2") }); r = send(r, { type: "evidence", evidence: evidence("green", "post-green", "C2") }); assert.equal(r.lifecycle.status, "enabled");
 r.lifecycle = life.markLifecycleUnknown(r.lifecycle, "correction1", "incierto", at);
 assert.throws(() => send(r, { type: "step_completed", id: "C2", commit: nextHead, fingerprint }));
 assert.throws(() => send(r, { type: "evidence", evidence: evidence("red", "unknown-red", "C2") }));
});

test("human-required posterior invalida el grupo antes de activar o acreditar corrección", () => {
 for (const stage of ["activate", "verify"]) {
  let r = stage === "activate" ? preparePostPrCorrection(reviewing(), proposal(reviewing())) : verified(); assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status !== "enabled") return;
  const f = r.lifecycle.ledger[0]; assert.ok(f); const o = f.observations.at(-1); assert.ok(o);
  r.lifecycle = life.disposeLifecycleFinding(r.lifecycle, { findingId: f.id, subjectId: "subject", observationHash: o.hash, status: "human-required", evidenceIds: [], reason: "Nuevo riesgo", at });
  if (stage === "activate") { r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "correction1", key: "c1", kind: "correction", subjectId: "subject", targetId: null, correlationId: "c1", retryOf: null }, { id: "decision2", kind: "correction", subjectId: "subject", targetId: null, configHash: pin().accepted.blockHash, source: "person", at }, "process", at); assert.throws(() => activatePostPrCorrection(r, "correction1", at)); }
  else assert.throws(() => verifyPostPrCorrection(r, "correction1", corrected(), { clean: true, ancestor: true }, at));
 }
});

test("D fallido después del commit tiene salida propia acotada sin perder PR ni historial", () => {
 let r = committed(); r = send(r, { type: "evidence", evidence: { ...evidence("verification", "failed-D", null, nextHead, nextFingerprint), exitCode: 1, outcome: "failed" } });
 const retry = retryPostPrCorrection(r, "correction1", { head: nextHead, fingerprint: nextFingerprint, clean: true }, "D falló", at);
 assert.equal(retry.phase, "review"); assert.deepEqual(retry.publication, r.publication); assert.deepEqual(retry.evidence, r.evidence); assert.equal(retry.lifecycle.status, "enabled"); if (retry.lifecycle.status !== "enabled") return;
 assert.equal(retry.lifecycle.budget.roundsUsed, 1); assert.equal(retry.lifecycle.operations.find(o => o.id === "correction1")?.status, "confirmed");
 const prepared = preparePostPrCorrection(retry, { ...proposal(retry), operationId: "correction2" }); assert.equal(prepared.lifecycle.status, "enabled"); if (prepared.lifecycle.status === "enabled") assert.equal(prepared.lifecycle.corrections?.at(-1)?.startHead, nextHead);
});

test("verified nativo no acredita D históricos fuera del ámbito de la corrección", () => {
 const r = verified(); assert.equal(r.lifecycle.status, "enabled"); if (r.lifecycle.status !== "enabled") return;
 const round = r.lifecycle.corrections?.[0]; assert.ok(round); round.evidenceOffset = r.evidence.length; r.phase = "verify";
 assert.throws(() => send(r, { type: "verified", fingerprint: nextFingerprint }), /verificación|caso|ámbito/);
});

test("transporte privado usa objetos locales sin heredar rewrites ni mover worktree; remoto sólo fake", async t => {
 const directory = await realpath(await mkdtemp(join(tmpdir(), "omi-push-objects-"))); t.after(() => rm(directory, { recursive: true, force: true }));
 const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" };
 const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, env, encoding: "utf8" }).trim();
 git("init", "-b", "feat/work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); await writeFile(join(directory, "app.ts"), "fixture"); git("add", "."); git("commit", "-m", "test: object"); const sha = git("rev-parse", "HEAD");
 git("config", "url.https://foreign.invalid/.insteadOf", "https://github.com/"); let pushes = 0;
 const runner: Runner = { async run(command, args, options = {}) {
  assert.equal(command, "git"); const childEnv = { ...env, ...options.env };
  if (args.includes("push")) {
   pushes++; assert.ok(args.includes(`https://github.com/${repo}.git`)); assert.equal(execFileSync("git", ["cat-file", "-t", sha], { cwd: options.cwd, env: childEnv, encoding: "utf8" }).trim(), "commit");
   assert.doesNotMatch(execFileSync("git", ["config", "--list"], { cwd: options.cwd, env: childEnv, encoding: "utf8" }), /foreign|insteadof/i);
   return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: execFileSync("git", args, { cwd: options.cwd, env: childEnv, encoding: "utf8" }), stderr: "" };
 } };
 await fixedGitPush({ root: directory, commonDir: join(directory, ".git"), branch: "feat/work", baseCommit: sha }, `https://github.com/${repo}.git`, { repo, pr: 42, branch: "feat/work", base: "main", beforeHead: sha, head: sha, fingerprint, correctionId: "fixture", correlationId: "fixture" }, runner, AbortSignal.timeout(5000));
 assert.equal(pushes, 1); assert.equal(git("rev-parse", "HEAD"), sha);
});

test("sin permiso vivo, HEAD remoto ajeno o PR mergeado no muta ni abre otro PR", async () => {
 for (const problem of ["gate", "foreign", "merged", "dirty", "origin", "multiple-origin", "default-branch"]) {
  const r = pushing(), p = pushPorts(r);
  if (problem === "gate") p.beforePush = async () => { throw new Error("No aprobado"); };
  const remote = p.currentPr; p.currentPr = async () => { const pr = await remote(); return { ...pr, merged: problem === "merged", head: { ...pr.head, sha: problem === "foreign" ? "f".repeat(40) : head } }; };
  if (problem === "dirty") p.snapshot = async () => ({ head: nextHead, fingerprint: nextFingerprint, clean: false, branch: "feat/work", ancestor: true });
  if (problem === "origin" || problem === "multiple-origin") p.runner = fakeRunner(() => ({ stdout: problem === "origin" ? "https://github.com/foreign/app.git\n" : `https://github.com/${repo}.git\nhttps://github.com/${repo}.git\n` }));
  if (problem === "default-branch") p.repository = async () => ({ full_name: repo, default_branch: "feat/work" });
  await assert.rejects(pushPostPrCorrection(r, "push1", p)); assert.equal(p.runner.commands.filter(c => c.args.includes("push")).length, 0); assert.equal(p.claims(), 0);
 }
});
