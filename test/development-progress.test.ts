import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { developmentProgress } from "../src/tui/development-view.ts";
import { parseWorkflow, type Workflow } from "../src/harness/model.ts";
import { transition } from "../src/harness/state.ts";
import { ASK_ALL } from "./helpers/foundations.ts";

const stage = (s: Workflow, id: string) => { const value = developmentProgress(s).stages?.find(s => s.id === id); assert.ok(value); return value; };
const batch = (id: string, phase: string, status: string, turns = 0) => ({ id, phase, args: { agent: "scout", task: "PRIVATE TASK" }, details: { mode: "single", results: [{ agent: "scout", status, turns, output: "PRIVATE OUTPUT" }] } });

test("inline execution is observed from executed main-session tools, never from the recipe", async t => {
 const f = await developmentFixture(t); await f.start();
 await f.emit("tool_call", { toolName: "read", toolCallId: "read-mode", input: { path: "value.cjs" } });
 assert.equal(stage(await f.state(), "explore").observed, "unknown", "preflight alone is not execution");
 await f.emit("tool_result", { toolName: "read", toolCallId: "read-mode", input: {}, content: [], isError: false });
 assert.equal(stage(await f.state(), "explore").observed, "inline");
 await f.explore(); const p = f.plan(); p.executor = { mode: "subagents", writers: 1 };
 await f.action({ action: "planned", plan: p });
 assert.equal(stage(await f.state(), "implement").planned, "subagents");
 assert.equal(stage(await f.state(), "implement").observed, "unknown");
 assert.equal((await f.state()).approval, null); assert.equal((await f.state()).steps[0]?.status, "pending");
});

test("queued tasks and polling do not claim delegation; running belongs to its origin phase", async t => {
 const f = await developmentFixture(t); await f.start();
 await f.emitBus("omi:subagents", batch("bg-one", "start", "pending"));
 assert.equal(stage(await f.state(), "explore").observed, "unknown");
 await f.action({ action: "explored", exploration: { references: [], findings: [], approach: "Wait", missingFoundation: [], dependencies: [], disposition: "needs-info", reason: "Wait" } }).catch(() => {});
 await f.explore();
 await f.emitBus("omi:subagents", batch("bg-one", "update", "running"));
 assert.equal(stage(await f.state(), "explore").observed, "subagent");
 assert.equal(stage(await f.state(), "recipe").observed, "unknown");
 await f.emitBus("omi:subagents", batch("bg-one", "end", "done", 1));
 for (const action of ["status", "result", "cancel"]) {
  await f.emit("tool_call", { toolName: "subagent", toolCallId: action, input: { action, id: "bg-one" } });
  await f.emit("tool_result", { toolName: "subagent", toolCallId: action, input: {}, content: [], isError: false });
 }
 assert.equal(stage(await f.state(), "recipe").observed, "unknown");
 const saved = JSON.stringify(await f.state()); assert.doesNotMatch(saved, /PRIVATE TASK|PRIVATE OUTPUT|bg-one/);
});

test("inline and actual delegation combine; cancellation while queued stays unknown", async t => {
 const f = await developmentFixture(t); await f.start();
 await f.emitBus("omi:subagents", batch("cancel", "start", "pending")); await f.emitBus("omi:subagents", batch("cancel", "end", "error"));
 assert.equal(stage(await f.state(), "explore").observed, "unknown");
 await f.emitBus("omi:subagents", batch("run", "start", "running"));
 await f.emit("tool_call", { toolName: "grep", toolCallId: "main", input: {} });
 await f.emit("tool_result", { toolName: "grep", toolCallId: "main", input: {}, content: [], isError: false });
 assert.equal(stage(await f.state(), "explore").observed, "mixed");
 const before = await f.state(); await f.emitBus("omi:subagents", batch("run", "update", "running"));
 assert.equal((await f.state()).revision, before.revision, "repeated updates are coalesced, not an unbounded event log");
});

test("restore recovers observations without effects; legacy states stay unknown and refresh rejects late events", async t => {
 const f = await developmentFixture(t); await f.start();
 const legacy = await f.state(); assert.equal(stage(parseWorkflow(JSON.stringify(legacy)), "explore").observed, "unknown");
 await f.emitBus("omi:subagents", batch("run", "start", "running"));
 const before = f.calls.length; await f.attach();
 assert.equal(stage(await f.state(), "explore").observed, "subagent");
 assert.ok(f.calls.slice(before).every(call => call.command === "git"), "restore does not query models/GitHub or run jobs");
 await f.emitBus("omi:subagents", batch("stale", "start", "pending"));
 await f.action({ action: "refresh" });
 await f.emitBus("omi:subagents", batch("stale", "end", "done", 1));
 assert.equal(stage(await f.state(), "explore").observed, "unknown");
});

test("observations are schema-bounded and never approve steps; retry starts a new implementation observation", async t => {
 const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
 let s = await f.state();
 assert.throws(() => parseWorkflow(JSON.stringify({ ...s, observations: [{ phase: "fake", round: 0, inline: true, subagent: false, lens: false }] })));
 assert.throws(() => parseWorkflow(JSON.stringify({ ...s, observations: Array(122).fill({ phase: "explore", round: 0, inline: true, subagent: false, lens: false }) })));
 await f.emitBus("omi:subagents", batch("approval", "start", "running")); s = await f.state();
 assert.equal(s.approval, null); assert.ok(s.steps.every(step => step.status === "pending")); assert.equal(s.evidence.length, 0);
 // Pure projection fixture: retry behavior is already integration-tested with actual commits in development-flow.
 s = { ...s, phase: "verify", observations: [{ phase: "implement", round: 0, inline: true, subagent: true, lens: false }] } as Workflow;
 assert.equal(stage(s, "implement").observed, "mixed");
 s = transition(s, { type: "retry", reason: "New round" }, "now");
 assert.equal(stage(s, "implement").observed, "unknown");
});

test("isolated verification lenses are observed as such, not as subagent tool delegation", async t => {
 const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
 await f.action({ action: "step", id: "C1" });
 await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
 await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
 await f.write("value.cjs", "module.exports = 2;\n");
 await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
 await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: value" });
 await f.invoke("omi_workflow_lens", { lens: "quality" });
 assert.equal(stage(await f.state(), "verify").observed, "isolated-lens");
 assert.equal(f.modelCalls.length, 1); assert.equal((await f.state()).phase, "verify");
});

test("nested tools do not masquerade as inline; concurrent observations serialize and IDs accept provider punctuation", async t => {
 const f = await developmentFixture(t); await f.start();
 await f.emit("tool_call", { toolName: "read", toolCallId: "nested/1", parentToolCallId: "parent", input: { path: "value.cjs" } });
 await f.emit("tool_result", { toolName: "read", toolCallId: "nested/1", parentToolCallId: "parent", input: {} });
 assert.equal(stage(await f.state(), "explore").observed, "unknown");
 await Promise.all([f.emitBus("omi:subagents", batch("provider:call", "start", "running")), f.emit("agent_start")]);
 assert.equal(stage(await f.state(), "explore").observed, "mixed");
 const saved = await f.state(); await f.emit("session_shutdown"); await f.emitBus("omi:subagents", batch("late", "start", "running"));
 assert.equal((await f.state()).revision, saved.revision);
});

test("waiting overlays target the current stage without changing durable execution or gates", async t => {
 const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
 f.remote.confirmations = false; await f.action({ action: "approve" });
 const events = f.progress as { progress?: ReturnType<typeof developmentProgress> }[];
 assert.ok(events.some(e => e.progress?.status === "waiting" && e.progress.stages?.some(s => s.current && s.status === "waiting")));
 assert.equal((await f.state()).approval, null);
});

test("development_progress omi_workflow status y /omi-work status dicen la vuelta, los retry que quedan y los amends", async t => {
 const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
 const state = await f.state(); assert.equal(state.phase, "implement");
 const status = await f.action({ action: "status" });
 assert.match(JSON.stringify(status.content), /Presupuesto: vuelta 0 de 3 · quedan 3 retry · amends 0 de 2\./);
 f.messages.length = 0; await f.command("status");
 assert.ok(f.messages.some(m => /vuelta 0 de 3 · quedan 3 retry · amends 0 de 2/.test(m)), JSON.stringify(f.messages));
 assert.ok(developmentProgress(state).details?.includes("Etapa: Implementar · active · vuelta 0 de 3 · quedan 3 retry · amends 0 de 2"), "el detalle de /omi-progress");
});
