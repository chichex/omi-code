import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition } from "../src/harness/state.ts";
import type { Evidence, Plan, Workflow } from "../src/harness/model.ts";
import { developmentProgress } from "../src/tui/development-view.ts";

const at = "2026-01-01T00:00:00Z";
const fresh = () => createWorkflow({ number: 42, title: "Feature", body: "Details", url: "https://example.test/42", hash: "old" }, { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" }, "work", at);
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
const explored = () => send(fresh(), { type: "explored", exploration: { references: [{ path: "src/a.ts", line: 1, detail: "Read" }], findings: [], approach: "Extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Ready" } });
const plan = (size: "small" | "large" = "small", diagnostic = false): Plan => ({ classification: { type: diagnostic ? "fix" : "add", size, risk: "low", riskAreas: [], causeKnown: !diagnostic }, objective: "Feature", approach: "Extend", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } });
const ready = (size: "small" | "large" = "small", diagnostic = false) => send(send(explored(), { type: "inferences", inferences: [] }), { type: "planned", plan: plan(size, diagnostic) });
const evidence = (kind: Evidence["kind"], changes: Partial<Evidence> = {}): Evidence => ({ id: kind, kind, command: "npm test", stepId: "C1", caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "", fingerprint: "tree", head: "head", startedAt: at, finishedAt: at, ...changes });
// Dynamic access keeps the initial red about missing behavior, not a missing import/export.
function stages(s: Workflow): Record<string, unknown>[] {
 const p: unknown = developmentProgress(s);
 assert.ok(p && typeof p === "object" && "stages" in p && Array.isArray(p.stages), "progress must expose the full canonical journey");
 return p.stages;
}
function stage(s: Workflow, id: string) { const value = stages(s).find(s => s.id === id); assert.ok(value, id); return value; }

test("journey includes every real phase in order, including future and alternative phases", () => {
 const s = fresh();
 assert.deepEqual(stages(s).map(s => s.id), ["explore", "decide", "recipe", "diagnose", "spec", "approve", "implement", "verify", "pr", "done", "closed"]);
 assert.equal(stage(s, "explore").status, "active"); assert.equal(stage(s, "decide").status, "pending");
 assert.equal(stage(s, "diagnose").status, "conditional"); assert.equal(stage(s, "spec").status, "conditional");
 assert.equal(stage(s, "implement").observed, "unknown");
});

test("direct and spec routes show real completed, current and non-applicable stages", () => {
 const direct = ready();
 for (const id of ["explore", "decide", "recipe"]) assert.equal(stage(direct, id).status, "done", id);
 for (const id of ["diagnose", "spec", "closed"]) assert.equal(stage(direct, id).status, "not-applicable", id);
 assert.equal(stage(direct, "approve").status, "active"); assert.equal(stage(direct, "implement").status, "pending");
 const spec = ready("large"); assert.equal(stage(spec, "spec").status, "active");
 const specified = send(spec, { type: "specified", spec: { why: "Large", steps: [{ id: "C1", title: "Feature", cases: ["D1"] }], playbook: ["Check"] } });
 assert.equal(stage(specified, "spec").status, "done"); assert.equal(stage(specified, "approve").status, "active");
});

test("diagnosis remains completed after route changes; small fixes do not invent a spec", () => {
 let s = ready("large", true); assert.equal(stage(s, "diagnose").status, "active");
 s = send(s, { type: "evidence", evidence: evidence("reproduction") });
 s = send(s, { type: "diagnosed", cause: "Known", reproduction: "reproduction", size: "small" });
 assert.equal(s.recipe?.route, "direct"); assert.equal(stage(s, "diagnose").status, "done"); assert.equal(stage(s, "spec").status, "not-applicable");
});

test("waits, pauses and closed without change do not manufacture completed work", () => {
 let s = send(explored(), { type: "inferences", inferences: [{ id: "I1", kind: "what", question: "Which?", recommended: "A", confidence: 10, irreversible: false, references: [] }] });
 assert.equal(stage(s, "decide").status, "waiting"); assert.equal(stage(s, "recipe").status, "pending");
 s = send(s, { type: "pause", reason: "Later" }); assert.equal(stage(s, "decide").status, "paused");
 s = send(s, { type: "resume" }); assert.equal(stage(s, "decide").status, "waiting");
 const closed = send(fresh(), { type: "explored", exploration: { ...explored().exploration!, disposition: "wontfix", reason: "No change" } });
 assert.equal(stage(closed, "closed").status, "done");
 for (const id of ["decide", "recipe", "approve", "implement", "verify", "pr", "done"]) assert.equal(stage(closed, id).status, "not-applicable", id);
});

function verifying() {
 let s = send(ready(), { type: "approved" }); s = send(s, { type: "step_started", id: "C1" });
 s = send(s, { type: "evidence", evidence: evidence("red") });
 assert.equal(stage(s, "implement").status, "active", "expected TDD red is progress, not a failed phase");
 s = send(s, { type: "evidence", evidence: evidence("green") });
 return send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" });
}
test("failed/interrupted checks and successful recovery reflect actual evidence", () => {
 let s = verifying(); assert.equal(stage(s, "implement").status, "done");
 s = send(s, { type: "evidence", evidence: evidence("verification", { exitCode: 1, outcome: "failed" }) });
 assert.equal(stage(s, "verify").status, "failed"); assert.equal(stage(s, "pr").status, "pending");
 s = send(s, { type: "evidence", evidence: evidence("verification", { id: "cancel", exitCode: null, outcome: "interrupted" }) });
 assert.equal(stage(s, "verify").status, "interrupted");
 s = send(s, { type: "evidence", evidence: evidence("verification", { id: "pass" }) });
 assert.equal(stage(s, "verify").status, "active");
 s = send(s, { type: "verified", fingerprint: "tree" }); assert.equal(stage(s, "verify").status, "done");
 s = send(s, { type: "publishing", head: "head", bodyHash: "body" });
 s = send(s, { type: "published", head: "head", url: "https://example.test/pr", number: 7 });
 assert.equal(stage(s, "pr").status, "done"); assert.equal(stage(s, "done").status, "done");
});

test("retry invalidates verification; refresh ignores old history and pending steps stay pending", () => {
 let s = send(verifying(), { type: "retry", reason: "Fix" });
 assert.equal(stage(s, "implement").status, "active"); assert.equal(stage(s, "verify").status, "pending");
 assert.equal(developmentProgress(s).completedSteps, 1); assert.equal(developmentProgress(s).totalSteps, 2);
 s = send(s, { type: "source_changed", source: s.source });
 assert.ok(s.history.length); assert.equal(stage(s, "explore").status, "active");
 for (const id of ["decide", "recipe", "approve", "implement", "verify", "pr"]) assert.equal(stage(s, id).status, "pending", id);
 assert.equal(stage(s, "implement").observed, "unknown");
});

test("an exploration the reducer still blocks is never shown as completed", () => {
 const base = explored().exploration!;
 for (const changes of [{ references: [] }, { missingFoundation: ["CI"] }, { dependencies: [{ name: "API", blocking: true, ready: false }] }, { disposition: "needs-info" as const, reason: "Ask" }]) {
  const s = send(fresh(), { type: "explored", exploration: { ...base, ...changes } });
  assert.equal(s.phase, "decide"); assert.equal(s.status, "waiting");
  assert.notEqual(stage(s, "explore").status, "done", JSON.stringify(changes));
  assert.equal(stage(s, "decide").status, "waiting");
 }
 // Un cierre sin cambio no pasa por esos bloqueos en el reducer: Explorar sí se cumplió.
 const closed = send(fresh(), { type: "explored", exploration: { ...base, references: [], disposition: "wontfix", reason: "No change" } });
 assert.equal(closed.phase, "closed"); assert.equal(stage(closed, "explore").status, "done");
});
