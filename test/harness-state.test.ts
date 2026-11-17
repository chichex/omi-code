import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition, isApproved, recipeApprovalHash } from "../src/harness/state.ts";
import { sourceHash, type Workflow, type Evidence, type Plan, type Exploration } from "../src/harness/model.ts";

const at = "2026-01-01T00:00:00Z";
const source = { number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: ["quality"], executor: { mode: "inline", writers: 1 } };
const fresh = () => createWorkflow(source, checkout, "workflow", at);
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
function ready(p = plan) { let s = send(fresh(), { type: "explored", exploration }); s = send(s, { type: "inferences", inferences: [] }); return send(s, { type: "planned", plan: p }); }
function evidence(kind: Evidence["kind"], changes: Partial<Evidence> = {}): Evidence { return { id: kind, kind, command: "npm test", stepId: kind === "red" || kind === "green" ? "C1" : null, caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "actual output", fingerprint: "tree", head: "head", startedAt: at, finishedAt: at, ...changes }; }
function verifying() { let s = send(ready(), { type: "approved" }); s = send(s, { type: "step_started", id: "C1" }); s = send(s, { type: "evidence", evidence: evidence("red") }); s = send(s, { type: "evidence", evidence: evidence("green") }); return send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }); }
function pr() { let s = send(verifying(), { type: "evidence", evidence: evidence("verification") }); s = send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "pass", findings: [], at } }); return send(s, { type: "verified", fingerprint: "tree" }); }

test("new workflow is validated, independent and transitions are pure", () => {
 const s = fresh(); assert.equal(s.phase, "explore"); assert.equal(s.revision, 0); assert.equal(s.maxRounds, 3); assert.equal(s.approval, null); assert.deepEqual(s.publication, { status: "none" });
 const next = send(s, { type: "explored", exploration }); assert.equal(next.phase, "decide"); assert.equal(next.revision, 1); assert.equal(next.history.length, 1); assert.equal(s.exploration, null);
 assert.throws(() => send(s, { type: "planned", plan })); assert.throws(() => createWorkflow(source, checkout, "", at));
});
test("exploration cannot invent foundations or skip blocked dependencies", () => {
 for (const changes of [{ references: [] }, { missingFoundation: ["schema"] }, { dependencies: [{ name: "api", blocking: true, ready: false }] }, { disposition: "needs-info" as const }]) { const s = send(fresh(), { type: "explored", exploration: { ...exploration, ...changes } }); assert.equal(s.status, "waiting"); assert.ok(s.blockedReason); assert.throws(() => send(s, { type: "planned", plan })); }
 const s = send(fresh(), { type: "explored", exploration: { ...exploration, disposition: "wontfix" } }); assert.equal(s.phase, "closed"); assert.equal(s.status, "complete");
});
test("decisions require explicit irreversible answers and supported how assumptions", () => {
 let s = send(fresh(), { type: "explored", exploration });
 s = send(s, { type: "inferences", inferences: [{ id: "I1", kind: "how", question: "how", recommended: "extend", confidence: 99, irreversible: false, references: [] }, { id: "I2", kind: "what", question: "delete?", recommended: "yes", confidence: 100, irreversible: true, references: [] }] });
 assert.equal(s.status, "waiting"); assert.equal(s.phase, "decide"); assert.throws(() => send(s, { type: "planned", plan }));
 s = send(s, { type: "answered", id: "I1", answer: "extend" }); assert.equal(s.status, "waiting"); assert.equal(s.phase, "decide");
 s = send(s, { type: "answered", id: "I2", answer: "no" }); assert.equal(s.status, "active"); assert.equal(s.phase, "recipe"); assert.equal(send(s, { type: "planned", plan }).phase, "approve");
});
test("routing, risk lenses, diagnostic and spec coverage fail closed", () => {
 assert.equal(ready().recipe?.route, "direct"); assert.equal(ready().steps[0]?.id, "C1");
 const risky = ready({ ...plan, classification: { ...plan.classification, riskAreas: ["auth"] } }); assert.equal(risky.recipe?.classification.risk, "high"); assert.ok(risky.recipe?.lenses.includes("security")); assert.ok(risky.recipe?.lenses.includes("compliance"));
 let s = ready({ ...plan, classification: { ...plan.classification, type: "fix", causeKnown: false, size: "large" } }); assert.equal(s.phase, "diagnose");
 assert.throws(() => send(s, { type: "diagnosed", cause: "bug", reproduction: "missing", size: "small" }));
 assert.throws(() => send(s, { type: "evidence", evidence: evidence("reproduction", { exitCode: 127, outcome: "failed" }) }));
 s = send(s, { type: "evidence", evidence: evidence("reproduction", { stepId: null, exitCode: 1, outcome: "failed" }) });
 s = send(s, { type: "diagnosed", cause: "bug", reproduction: "reproduction", size: "large" }); assert.equal(s.phase, "spec");
 assert.throws(() => send(s, { type: "specified", spec: { why: "needed", steps: [{ id: "C1", title: "step", cases: ["D2"] }], playbook: ["test"] } }));
 s = send(s, { type: "specified", spec: { why: "needed", steps: [{ id: "C1", title: "step", cases: ["D1"] }], playbook: ["test"] } }); assert.equal(s.phase, "approve"); assert.equal(s.steps.length, 1);
});
test("approval binds source recipe and spec; pause and resume never approve", () => {
 const s = ready(); const hash = recipeApprovalHash(s); assert.equal(isApproved(s), false); let approved = send(s, { type: "approved" }); assert.equal(isApproved(approved), true);
 const paused = send(s, { type: "pause", reason: "later" }); assert.equal(send(paused, { type: "resume" }).phase, "approve"); assert.equal(isApproved(send(paused, { type: "resume" })), false);
 assert.equal(isApproved({ ...approved, recipe: { ...plan, route: "direct", objective: "different" } }), false);
 approved = send(approved, { type: "source_changed", source: { ...source, body: "new", hash: source.hash } }); assert.equal(approved.phase, "explore"); assert.equal(approved.approval, null); assert.equal(approved.recipe, null); assert.notEqual(approved.source.hash, source.hash); assert.notEqual(recipeApprovalHash(approved), hash); assert.ok(approved.history.length > s.history.length);
});
test("red/green requires real ordered command evidence and current completion fingerprint", () => {
 let s = send(ready(), { type: "approved" }); assert.throws(() => send(s, { type: "evidence", evidence: evidence("red") }));
 s = send(s, { type: "step_started", id: "C1" }); assert.throws(() => send(s, { type: "evidence", evidence: evidence("green") }));
 for (const bad of [evidence("red", { exitCode: 0 }), evidence("red", { exitCode: 126 }), evidence("red", { exitCode: null, outcome: "interrupted" })]) assert.throws(() => send(s, { type: "evidence", evidence: bad }));
 s = send(s, { type: "evidence", evidence: evidence("red") }); s = send(s, { type: "evidence", evidence: evidence("green") });
 assert.throws(() => send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "stale" })); assert.throws(() => send(s, { type: "step_completed", id: "C1", commit: "", fingerprint: "tree" }));
 s = send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }); assert.equal(s.phase, "verify"); assert.throws(() => send(s, { type: "evidence", evidence: evidence("red") }));
});
test("verification requires exact commands, current fingerprint, and passing lenses", () => {
 let s = verifying(); assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }));
 s = send(s, { type: "evidence", evidence: evidence("verification", { command: "true" }) }); s = send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "pass", findings: [], at } }); assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }));
 s = send(s, { type: "evidence", evidence: evidence("verification", { id: "exact" }) }); assert.throws(() => send(s, { type: "verified", fingerprint: "stale" })); assert.equal(send(s, { type: "verified", fingerprint: "tree" }).phase, "pr");
});
// Una vuelta agrega un paso de corrección: lo ya commiteado no puede volver a dar rojo.
function correct(s: Workflow, round: number): Workflow {
 const id = `C${round + 1}`;
 s = send(s, { type: "step_started", id });
 s = send(s, { type: "evidence", evidence: evidence("red", { id: `red${round}`, stepId: id }) });
 s = send(s, { type: "evidence", evidence: evidence("green", { id: `green${round}`, stepId: id }) });
 return send(s, { type: "step_completed", id, commit: `fix${round}`, fingerprint: "tree" });
}
test("retry is bounded, preserves history and does not preserve green checks", () => {
 let s = pr(); const history = s.history.length;
 for (let round = 1; round <= 3; round++) {
  s = send(s, { type: "retry", reason: "review" }); assert.equal(s.phase, "implement"); assert.equal(s.round, round); assert.equal(s.reviews.length, 0); assert.deepEqual(s.evidence, []);
  const added = s.steps.at(-1); assert.equal(s.steps.length, round + 1); assert.equal(added?.id, `C${round + 1}`); assert.equal(added?.status, "pending"); assert.equal(added?.green, null); assert.equal(added?.red, null); assert.deepEqual(added?.cases, ["D1"]); assert.match(added?.title ?? "", /review/);
  assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }));
  s = correct(s, round); assert.equal(s.phase, "verify");
 }
 s = send(s, { type: "retry", reason: "again" }); assert.equal(s.status, "waiting"); assert.equal(s.round, 3); assert.ok(s.history.length > history);
});
test("retry keeps completed steps and their commits; the correction needs a new red and a new commit", () => {
 let s = send(pr(), { type: "retry", reason: "lens finding" });
 assert.equal(s.steps[0]?.status, "done"); assert.equal(s.steps[0]?.commit, "head"); assert.equal(isApproved(s), true);
 assert.throws(() => send(s, { type: "step_started", id: "C1" }));
 s = send(s, { type: "step_started", id: "C2" });
 assert.throws(() => send(s, { type: "evidence", evidence: evidence("green", { id: "early", stepId: "C2" }) }));
 s = send(s, { type: "evidence", evidence: evidence("red", { id: "red2", stepId: "C2" }) }); s = send(s, { type: "evidence", evidence: evidence("green", { id: "green2", stepId: "C2" }) });
 assert.throws(() => send(s, { type: "step_completed", id: "C2", commit: "head", fingerprint: "tree" }), /otro paso/);
 assert.equal(send(s, { type: "step_completed", id: "C2", commit: "fix", fingerprint: "tree" }).phase, "verify");
});
test("pause/resume in the final allowed round does not falsely exhaust the workflow", () => {
 let s = pr();
 for (let round = 1; round <= 3; round++) {
  s = send(s, { type: "retry", reason: "review" });
  if (round === 3) break;
  s = correct(s, round);
 }
 s = send(send(s, { type: "pause", reason: "break" }), { type: "resume" }); assert.equal(s.status, "active"); assert.equal(s.phase, "implement");
 s = send(send(correct(s, 3), { type: "retry", reason: "again" }), { type: "pause", reason: "break" });
 s = send(s, { type: "resume" }); assert.equal(s.status, "waiting"); assert.match(s.blockedReason, /agotaron/);
 assert.throws(() => send(s, { type: "evidence", evidence: evidence("verification", { id: "late" }) }), /agotaron/);
});
test("publication persists pending and rejects wrong head before completion", () => {
 let s = pr(); s = send(s, { type: "publishing", head: "head", bodyHash: "body" }); assert.equal(s.publication.status, "pending"); assert.throws(() => send(s, { type: "published", head: "other", url: "https://example.test/pr", number: 9 }));
 s = send(s, { type: "published", head: "head", url: "https://example.test/pr", number: 9 }); assert.equal(s.phase, "done"); assert.equal(s.status, "complete");
});

test("high risk alone forces both safety lenses and preserves configured lenses", () => {
 const s = ready({ ...plan, lenses: ["quality", "security"], classification: { ...plan.classification, risk: "high", riskAreas: [] } });
 assert.deepEqual(s.recipe?.lenses, ["quality", "security", "compliance"]);
});
test("recipe requires explicit inference resolution, including an empty list", () => {
 const explored = send(fresh(), { type: "explored", exploration });
 assert.equal(explored.phase, "decide"); assert.throws(() => send(explored, { type: "planned", plan }));
 const empty = send(explored, { type: "inferences", inferences: [] });
 assert.equal(empty.phase, "recipe"); assert.throws(() => send(empty, { type: "inferences", inferences: [] }));
 assert.equal(send(empty, { type: "planned", plan }).phase, "approve");
 const assumed = send(explored, { type: "inferences", inferences: [{ id: "I1", kind: "how", question: "how?", recommended: "extend", confidence: 99, irreversible: false, references: exploration.references }] });
 assert.equal(assumed.phase, "recipe"); assert.equal(assumed.inferences[0]?.resolution, "assumed");
 assert.equal(send(assumed, { type: "planned", plan }).phase, "approve");
});
test("check_failed records invalid reproductions without enabling diagnosis", () => {
 for (const changes of [{ exitCode: null, outcome: "interrupted" as const }, { exitCode: 126, outcome: "failed" as const }, { exitCode: 127, outcome: "failed" as const }, { exitCode: -1, outcome: "failed" as const }, { exitCode: 256, outcome: "failed" as const }]) {
  const attempt = evidence("reproduction", changes);
  for (const original of [fresh(), ready({ ...plan, classification: { ...plan.classification, type: "fix", causeKnown: false } })]) {
   assert.throws(() => send(original, { type: "evidence", evidence: attempt }));
   const s = send(original, { type: "check_failed", evidence: attempt });
   assert.deepEqual(s.evidence, [attempt]); assert.equal(s.phase, original.phase); assert.equal(s.diagnosis, null);
   assert.throws(() => send(s, { type: "diagnosed", cause: "bug", reproduction: attempt.id, size: "small" }));
   assert.throws(() => send(s, { type: "check_failed", evidence: attempt }));
  }
 }
 for (const attempt of [evidence("reproduction"), evidence("reproduction", { exitCode: 1, outcome: "failed" })]) assert.throws(() => send(fresh(), { type: "check_failed", evidence: attempt }));
 assert.throws(() => send(ready(), { type: "check_failed", evidence: evidence("reproduction", { exitCode: 127, outcome: "failed" }) }));
});
function activeStep() { return send(send(ready(), { type: "approved" }), { type: "step_started", id: "C1" }); }
function greenStep() { return send(send(activeStep(), { type: "evidence", evidence: evidence("red") }), { type: "evidence", evidence: evidence("green") }); }
test("check_failed preserves green attempts but revokes completion until a new green", () => {
 const original = greenStep();
 for (const changes of [{ exitCode: 1, outcome: "failed" as const }, { exitCode: null, outcome: "interrupted" as const }, { exitCode: 126, outcome: "failed" as const }, { exitCode: 127, outcome: "failed" as const }]) {
  const attempt = evidence("green", { id: "failedgreen", ...changes });
  assert.throws(() => send(original, { type: "evidence", evidence: attempt }));
  let s = send(original, { type: "check_failed", evidence: attempt });
  assert.deepEqual(s.evidence.at(-1), attempt); assert.equal(s.steps[0]?.green, null); assert.equal(s.steps[0]?.red, "red"); assert.equal(original.steps[0]?.green, "green");
  assert.throws(() => send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }));
  s = send(s, { type: "evidence", evidence: evidence("green", { id: "newgreen" }) });
  assert.equal(send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }).phase, "verify");
 }
});
test("check_failed invalid red resets both proofs and cannot masquerade as valid evidence", () => {
 for (const changes of [{ exitCode: 0, outcome: "failed" as const }, { exitCode: 0, outcome: "passed" as const }, { exitCode: 127, outcome: "failed" as const }, { exitCode: null, outcome: "interrupted" as const }]) {
  const s = send(greenStep(), { type: "check_failed", evidence: evidence("red", { id: "badred", ...changes }) });
  assert.equal(s.steps[0]?.red, null); assert.equal(s.steps[0]?.green, null); assert.equal(s.evidence.at(-1)?.id, "badred");
  assert.throws(() => send(s, { type: "evidence", evidence: evidence("green", { id: "newgreen" }) }));
  assert.throws(() => send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }));
 }
 for (const attempt of [evidence("red"), evidence("green"), evidence("verification"), evidence("gate")]) assert.throws(() => send(activeStep(), { type: "check_failed", evidence: attempt }));
 const invalid = evidence("green", { id: "badgreen", exitCode: 1, outcome: "failed" });
 for (const s of [fresh(), ready(), send(ready(), { type: "approved" }), verifying()]) assert.throws(() => send(s, { type: "check_failed", evidence: invalid }));
 assert.throws(() => send(activeStep(), { type: "check_failed", evidence: { ...invalid, stepId: "C2" } }));
 assert.throws(() => send(activeStep(), { type: "check_failed", evidence: { ...invalid, caseId: "D2" } }));
 const unapproved = activeStep(); unapproved.approval = null;
 assert.throws(() => send(unapproved, { type: "check_failed", evidence: invalid }));
});
test("each C requires a distinct commit and source identity includes its URL", () => {
 let s = ready({ ...plan, classification: { ...plan.classification, size: "large" } });
 s = send(s, { type: "specified", spec: { why: "large", steps: [{ id: "C1", title: "first", cases: ["D1"] }, { id: "C2", title: "second", cases: ["D1"] }], playbook: ["test"] } });
 s = send(send(s, { type: "approved" }), { type: "step_started", id: "C1" });
 s = send(send(s, { type: "evidence", evidence: evidence("red") }), { type: "evidence", evidence: evidence("green") });
 s = send(s, { type: "step_completed", id: "C1", commit: "first", fingerprint: "tree" });
 s = send(s, { type: "step_started", id: "C2" });
 s = send(send(s, { type: "evidence", evidence: evidence("red", { id: "red2", stepId: "C2" }) }), { type: "evidence", evidence: evidence("green", { id: "green2", stepId: "C2" }) });
 assert.throws(() => send(s, { type: "step_completed", id: "C2", commit: "first", fingerprint: "tree" }));
 assert.equal(send(s, { type: "step_completed", id: "C2", commit: "second", fingerprint: "tree" }).phase, "verify");
 assert.throws(() => send(fresh(), { type: "source_changed", source: { ...source, url: "https://other.test/7" } }));
 assert.throws(() => send(fresh(), { type: "source_changed", source: { ...source, number: 8 } }));
});
test("resume restores decision, approval and explicit waiting blockers", () => {
 const approval = send(send(ready(), { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(approval.phase, "approve"); assert.equal(approval.status, "waiting"); assert.ok(approval.blockedReason); assert.equal(isApproved(approval), false);
 assert.throws(() => send(approval, { type: "step_started", id: "C1" }));
 const explored = send(fresh(), { type: "explored", exploration });
 const deciding = send(send(explored, { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(deciding.phase, "decide"); assert.throws(() => send(deciding, { type: "planned", plan }));
 const blocked = send(fresh(), { type: "explored", exploration: { ...exploration, missingFoundation: ["schema"] } });
 const resumed = send(send(blocked, { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(resumed.status, "waiting"); assert.equal(resumed.blockedReason, blocked.blockedReason);
 const manual = { ...activeStep(), status: "waiting" as const, blockedReason: "manual dependency" };
 const resumedManual = send(send(manual, { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(resumedManual.status, "waiting"); assert.equal(resumedManual.blockedReason, manual.blockedReason);
 assert.throws(() => send(resumedManual, { type: "check_failed", evidence: evidence("green", { exitCode: 1, outcome: "failed" }) }));
 const blockedVerification = { ...pr(), phase: "verify" as const, status: "waiting" as const, blockedReason: "manual dependency" };
 const resumedVerification = send(send(blockedVerification, { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(resumedVerification.status, "waiting");
 assert.throws(() => send(resumedVerification, { type: "verified", fingerprint: "tree" }));
 assert.throws(() => send(resumedVerification, { type: "retry", reason: "skip blocker" }));
 const unapproved = activeStep(); unapproved.approval = null;
 assert.equal(send(send(unapproved, { type: "pause", reason: "later" }), { type: "resume" }).status, "waiting");
});
test("exhausted retries stay blocked through pause/resume", () => {
 const s = { ...pr(), round: 3 };
 const exhausted = send(s, { type: "retry", reason: "again" });
 const resumed = send(send(exhausted, { type: "pause", reason: "later" }), { type: "resume" });
 assert.equal(resumed.status, "waiting"); assert.equal(resumed.blockedReason, exhausted.blockedReason);
 assert.throws(() => send(resumed, { type: "publishing", head: "head", bodyHash: "body" }));
});
test("a review outside the recipe or pass with findings cannot accredit verification", () => {
 const s = send(verifying(), { type: "evidence", evidence: evidence("verification") });
 assert.throws(() => send(s, { type: "reviewed", review: { lens: "security", fingerprint: "tree", verdict: "pass", findings: [], at } }));
 assert.throws(() => send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "pass", findings: ["bug"], at } }));
 const persisted = { ...s, reviews: [{ lens: "quality" as const, fingerprint: "tree", verdict: "pass" as const, findings: ["bug"], at }] };
 assert.throws(() => send(persisted, { type: "verified", fingerprint: "tree" }));
});
test("verification considers the latest attempt for each case, not a filtered old success", () => {
 let s = send(verifying(), { type: "evidence", evidence: evidence("verification") });
 s = send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "pass", findings: [], at } });
 for (const changes of [{ command: "other", exitCode: 1, outcome: "failed" as const }, { fingerprint: "stale", exitCode: 1, outcome: "failed" as const }, { command: "other" }, { fingerprint: "stale" }]) {
  const failed = send(s, { type: "evidence", evidence: evidence("verification", { id: "latest", ...changes }) });
  assert.throws(() => send(failed, { type: "verified", fingerprint: "tree" }));
  const recovered = send(failed, { type: "evidence", evidence: evidence("verification", { id: "current" }) });
  assert.equal(send(recovered, { type: "verified", fingerprint: "tree" }).phase, "pr");
 }
 const staleReview = send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "stale", verdict: "fail", findings: ["old bug"], at } });
 assert.equal(send(staleReview, { type: "verified", fingerprint: "tree" }).phase, "pr");
 const failedReview = send(staleReview, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "fail", findings: ["current bug"], at } });
 assert.throws(() => send(failedReview, { type: "verified", fingerprint: "tree" }));
});

test("a wontfix closed by the model can be reopened by refreshing the request, and nothing else", () => {
 const closed = send(fresh(), { type: "explored", exploration: { ...exploration, disposition: "wontfix", reason: "duplicate" } });
 for (const event of [{ type: "pause", reason: "later" }, { type: "resume" }, { type: "explored", exploration }] as const) assert.throws(() => send(closed, event), /cerrado/);
 const reopened = send(closed, { type: "source_changed", source });
 assert.equal(reopened.phase, "explore"); assert.equal(reopened.status, "active"); assert.equal(reopened.exploration, null); assert.equal(reopened.blockedReason, "");
 const done = { ...pr(), phase: "done" as const, status: "complete" as const };
 assert.throws(() => send(done, { type: "source_changed", source }), /cerrado/);
});
test("history is a bounded window: long sessions never make the saved state invalid", () => {
 const full = send(fresh(), { type: "explored", exploration });
 full.history = Array.from({ length: 1000 }, (_, i) => ({ at, phase: "decide" as const, activity: `old ${i}` }));
 const s = send(send(full, { type: "pause", reason: "late" }), { type: "resume" });
 assert.equal(s.history.length, 1000); assert.equal(s.history[0]?.activity, "old 2"); assert.equal(s.history.at(-2)?.activity, "pause: late"); assert.equal(s.history.at(-1)?.activity, "resume");
 assert.equal(send(s, { type: "pause", reason: "still works" }).status, "paused");
});
test("a failed lens cannot be re-rolled on the same content and lens runs are bounded", () => {
 const review = (verdict: "pass" | "fail" | "unknown", fingerprint = "tree") => ({ type: "reviewed" as const, review: { lens: "quality" as const, fingerprint, verdict, findings: verdict === "pass" ? [] : ["src/a.ts:1 · finding"], at } });
 let s = send(verifying(), { type: "evidence", evidence: evidence("verification") });
 s = send(s, review("fail"));
 assert.throws(() => send(s, review("pass")), /ya falló/);
 assert.equal(send(s, review("pass", "changed")).reviews.length, 2);
 let unknown = send(verifying(), { type: "evidence", evidence: evidence("verification") });
 for (let i = 0; i < 4; i++) unknown = send(unknown, review("unknown"));
 unknown = send(unknown, review("pass")); assert.equal(send(unknown, { type: "verified", fingerprint: "tree" }).phase, "pr", "cancelar o un error del proveedor no gasta corridas");
 unknown = send(send(unknown, review("pass")), review("pass"));
 assert.throws(() => send(unknown, review("pass")), /intentos/);
 let flaky = verifying(); for (let i = 0; i < 10; i++) flaky = send(flaky, review("unknown"));
 assert.throws(() => send(flaky, review("unknown")), /intentos/);
});
test("a refuter pass lets a failed lens run again on the same content", () => {
 const withRefuter = { ...plan, lenses: ["quality", "refuter"] as Plan["lenses"] };
 let s = send(ready(withRefuter), { type: "approved" }); s = send(s, { type: "step_started", id: "C1" }); s = send(s, { type: "evidence", evidence: evidence("red") }); s = send(s, { type: "evidence", evidence: evidence("green") }); s = send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" });
 const lens = (name: "quality" | "refuter", verdict: "pass" | "fail") => ({ type: "reviewed" as const, review: { lens: name, fingerprint: "tree", verdict, findings: verdict === "pass" ? [] : ["src/a.ts:1 · finding"], at } });
 s = send(s, lens("quality", "fail"));
 assert.throws(() => send(s, lens("quality", "pass")), /ya falló/);
 assert.throws(() => send(send(s, lens("refuter", "fail")), lens("quality", "pass")), /ya falló/);
 s = send(s, lens("refuter", "pass"));
 assert.equal(send(s, lens("quality", "pass")).reviews.at(-1)?.verdict, "pass");
});
test("schema limits fail on the event with a clear message, never as a corrupt state", () => {
 assert.equal(send(fresh(), { type: "pause", reason: "x".repeat(4000) }).status, "paused");
 const full = activeStep(); full.evidence = Array.from({ length: 1000 }, (_, i) => evidence("reproduction", { id: `old${i}` }));
 assert.throws(() => send(full, { type: "evidence", evidence: evidence("red") }), /tope/);
 assert.throws(() => send(full, { type: "check_failed", evidence: evidence("red", { exitCode: 0, outcome: "passed" }) }), /tope/);
});
test("archived attempts keep a short output tail, not every full command output", () => {
 let s = verifying(); s = send(s, { type: "evidence", evidence: evidence("verification", { output: "y".repeat(12000) }) });
 s = send(s, { type: "retry", reason: "review" });
 const archived = s.attempts?.at(-1)?.evidence ?? []; assert.ok(archived.length >= 3); assert.ok(archived.every(e => e.output.length <= 500));
});
test("a red must fail inside the 1..125 range everywhere, not by signal-like codes", () => {
 const s = activeStep();
 for (const exitCode of [126, 127, 128, 130, 200, 255]) assert.throws(() => send(s, { type: "evidence", evidence: evidence("red", { id: `red${exitCode}`, exitCode }) }), /rojo/);
 assert.equal(send(s, { type: "evidence", evidence: evidence("red", { exitCode: 125 }) }).steps[0]?.red, "red");
});
