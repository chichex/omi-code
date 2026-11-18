import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createWorkflow } from "../src/harness/state.ts";
import { developmentProgress } from "../src/tui/development-view.ts";
import * as ui from "../src/tui/workspace/workflow-progress.ts";
import { workspaceSidebar } from "../src/tui/workspace/sidebar.ts";
import { SubagentMonitor } from "../src/tui/workspace/subagents.ts";
import type { GitSnapshot } from "../src/tui/workspace/data.ts";

const progress = () => developmentProgress(createWorkflow({ number: 42, title: "Feature", body: "Details", url: "https://example.test/42", hash: "old" }, { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" }, "workflow", "now"));
const git: GitSnapshot = { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git", mainRoot: "/repo", linked: false, branch: "work", detached: false, changes: [], changeCount: 0, tracking: false, ahead: undefined, behind: undefined };
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("stage bus validates full ordered journey and copies nested metadata defensively", () => {
 const monitor = new ui.WorkflowProgressMonitor(); const p = progress();
 assert.equal(monitor.consume({ progress: p }), true);
 assert.equal(monitor.current("/repo", git)?.stages?.length, 11);
 p.stages![0]!.label = "changed";
 const current = monitor.current("/repo", git)!; assert.equal(current.stages?.[0]?.label, "Explorar");
 current.stages![0]!.label = "changed again"; assert.equal(monitor.current("/repo", git)?.stages?.[0]?.label, "Explorar");
 for (const stages of [[{ ...progress().stages![0], observed: "imagined" }], Array(12).fill(progress().stages![0]), progress().stages!.toReversed(), [{ ...progress().stages![0], status: "invented" }]]) assert.equal(monitor.consume({ progress: { ...progress(), stages } }), false);
 const hostile = progress(); hostile.stages![0]!.label = "漢字🙂\x1b]0;BAD\x07\n\u202e";
 assert.equal(monitor.consume({ progress: hostile }), true);
 assert.doesNotMatch(JSON.stringify(monitor.current("/repo", git)), /BAD|\\u001b|\\n|\u202e/);
});

test("tall sidebar shows complete states and modes; compact preserves panels and advertises screen 6", () => {
 for (const name of ["dark", "light"]) for (const height of [20, 26, 64]) {
  const p = progress(); p.stages![0]!.observed = "mixed";
  const frame = workspaceSidebar({ theme: getThemeByName(name)!, cwd: "/repo", height, git, gitError: false, actions: { reviews: {}, releases: {} }, context: { label: "—", percent: undefined, limit: undefined }, subagents: new SubagentMonitor(), workflowProgress: p }, 41);
  assert.equal(frame.lines.length, height); assert.ok(frame.lines.every(line => visibleWidth(line) === 41));
  for (const title of ["PROYECTO", "SESIÓN", "GITHUB ACTIONS", "OMI", "SUBAGENTES", "RECURSOS", "PROGRESO"]) assert.match(plain(frame.lines), new RegExp(title));
  assert.match(plain(frame.lines), /Ctrl.?6|6 · Progreso/);
  if (height === 64) for (const s of p.stages!) assert.ok(plain(frame.lines).includes(s.label), s.label);
  if (height === 64) assert.match(plain(frame.lines), /inline\+sub|mixto/);
 }
});

test("compact sidebar shows the whole journey or none of it, never a prefix that hides the current stage", () => {
 for (const blocked of [false, true]) for (let height = 20; height <= 64; height++) {
  const p = progress(); if (blocked) p.blockedReason = "Falta aprobación humana vigente";
  p.stages = p.stages!.map(s => ({ ...s, current: s.id === "implement", status: s.id === "implement" ? "active" : s.status }));
  const frame = workspaceSidebar({ theme: getThemeByName("dark")!, cwd: "/repo", height, git, gitError: false, actions: { reviews: {}, releases: {} }, context: { label: "—", percent: undefined, limit: undefined }, subagents: new SubagentMonitor(), workflowProgress: p }, 41);
  const lines = frame.lines.map(stripTerminalSequences);
  const shown = p.stages.filter(s => lines.some(line => /^│ [ >] \S /.test(line) && line.includes(` ${s.label} · `)));
  assert.ok(shown.length === 0 || shown.length === p.stages.length, `${height}${blocked ? " blocked" : ""}: ${shown.map(s => s.id).join(",")}`);
  assert.match(plain(frame.lines), blocked ? /Falta aprobación/ : /Ctrl.?6/);
 }
});

test("full screen presenter wraps stage status, planned and real modes in both themes and narrow widths", () => {
 assert.ok("workflowProgressView" in ui && typeof ui.workflowProgressView === "function", "full progress screen must exist");
 const render = ui.workflowProgressView as (theme: ReturnType<typeof getThemeByName>, p: ui.WorkflowProgress | undefined, width: number) => string[];
 for (const name of ["dark", "light"]) for (const width of [1, 28, 41, 80, 132]) {
  const p = progress(); const impl = p.stages!.find(s => s.id === "implement")!; impl.planned = "subagents";
  const lines = render(getThemeByName(name), p, width); assert.ok(lines.every(line => visibleWidth(line) === width));
  if (width >= 41) { assert.match(plain(lines), /Implementar/); assert.match(plain(lines), /Previsto: subagentes/); assert.match(plain(lines), /Real: sin observar/); assert.match(plain(lines), /Pendiente/); }
 }
 assert.match(plain(render(getThemeByName("dark"), undefined, 80)), /Sin progreso/);
});
