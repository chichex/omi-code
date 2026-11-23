import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { createEventBus, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { getLayoutBoxesAt, renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { readGit, type GitSnapshot } from "../src/tui/workspace/data.ts";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { OmiCommandPalette, OmiInfoModal } from "../src/tui/workspace/modals.ts";
import { workspaceSidebar } from "../src/tui/workspace/sidebar.ts";
import { SubagentMonitor } from "../src/tui/workspace/subagents.ts";
import { WorkflowProgressMonitor, workflowProgressPanel, workflowProgressDetail, type WorkflowProgress } from "../src/tui/workspace/workflow-progress.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const progress = (overrides: Partial<WorkflowProgress> = {}): WorkflowProgress => ({
 id: "issue-42", issueNumber: 42, worktree: "/repo/issue-42", branch: "feat/issue-42", phaseLabel: "Desarrollo",
 routeLabel: "Con diseño", activity: "Implementando", status: "active", completedSteps: 2, totalSteps: 8,
 passedChecks: 0, totalChecks: 3, blockedReason: "", details: ["Test rojo observado", "Implementación pendiente"], ...overrides,
});
const git = (overrides: Partial<GitSnapshot> = {}): GitSnapshot => ({ root: "/repo/issue-42", gitDir: "/git", commonDir: "/git", mainRoot: "/repo", linked: true, branch: "feat/issue-42", detached: false, changes: [], changeCount: 0, tracking: false, ahead: undefined, behind: undefined, ...overrides });
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("workflow bus: unknown envelopes, strict counters and identities; reset and defensive snapshots", () => {
 const monitor = new WorkflowProgressMonitor();
 for (const event of [null, [], {}, { other: undefined }, { progress: null }, { progress: {} }, { progress: progress({ status: "invalid" as never }) },
  ...[NaN, Infinity, -1, 1.5, "2"].map((count) => ({ progress: { ...progress(), completedSteps: count } })),
  { progress: progress({ completedSteps: 9 }) }, { progress: progress({ passedChecks: 4 }) }, { progress: progress({ issueNumber: 0 }) },
  { progress: progress({ branch: "feat/issue-42\n" }) }, { progress: progress({ worktree: "relative" }) }, { progress: { ...progress(), details: [1] } }]) {
  assert.equal(monitor.consume(event), false, JSON.stringify(event)); assert.equal(monitor.current("/repo/issue-42", git()), undefined);
 }
 const source = progress(); assert.equal(monitor.consume({ progress: source, extra: "ignored" }), true);
 source.details[0] = "mutated";
 const copy = monitor.current("/repo/issue-42", git())!; assert.equal(copy.details[0], "Test rojo observado");
 copy.details[0] = "mutated again"; assert.equal(monitor.current("/repo/issue-42", git())!.details[0], "Test rojo observado");
 assert.equal(monitor.consume({ progress: {} }), false); assert.equal(monitor.current("/repo/issue-42", git())!.completedSteps, 2);
 assert.equal(monitor.consume({ progress: undefined }), true); assert.equal(monitor.current("/repo/issue-42", git()), undefined);
 monitor.consume({ progress: progress() }); monitor.clear(); assert.equal(monitor.current("/repo/issue-42", git()), undefined);
});

test("workflow belongs only to matching cwd, worktree and attached branch; no optimistic startup", () => {
 const monitor = new WorkflowProgressMonitor(); monitor.consume({ progress: progress() });
 assert.equal(monitor.current("/repo/issue-42", undefined), undefined);
 for (const [cwd, snapshot] of [["/repo", git()], ["/repo/issue-420", git()], ["/repo/issue-42", git({ branch: "other" })], ["/repo/issue-42", git({ root: "/elsewhere" })], ["/repo/issue-42", git({ detached: true })]] as const) assert.equal(monitor.current(cwd, snapshot), undefined);
 assert.equal(monitor.current("/repo/issue-42/src", git())!.id, "issue-42");
});

test("workflow sanitizes ANSI/OSC, controls and bidi; bounds untrusted detail without corrupting wide Unicode", () => {
 const monitor = new WorkflowProgressMonitor(); const hostile = "漢字🙂é\x1b[31mOK\x1b[0m\x1b]0;EVIL\x07\n\t\0\u202e".repeat(500);
 assert.equal(monitor.consume({ progress: progress({ activity: hostile, phaseLabel: hostile, blockedReason: hostile, details: Array(150).fill(hostile) }) }), true);
 const safe = monitor.current("/repo/issue-42", git())!;
 assert.doesNotMatch(JSON.stringify(safe), /EVIL|\\u001b|\\u0000|\u202e|�/);
 assert.ok(safe.details.length <= 100); assert.ok(safe.activity.length <= 1000); assert.ok(JSON.stringify(safe).length < 150000);
});

test("workflow panel: 33 columns, dark/light, tiny/tall heights, long wide labels and explicit checks only", () => {
 for (const name of ["dark", "light"]) {
  const theme = getThemeByName(name)!;
  for (const status of ["active", "waiting", "paused", "complete"] as const) for (const width of [0, 1, 2, 8, 30, 33, 80]) for (const height of [0, 1, 3, 6, 9, 30]) {
   const p = progress({ status, worktree: "/漢字🙂/".repeat(100), activity: "Implementando 漢字🙂".repeat(50), blockedReason: "Falta aprobación" });
   const rows = workflowProgressPanel(theme, p, width, height);
   assert.ok(rows.length <= height); for (const row of rows) assert.equal(visibleWidth(row), width);
   if (height >= 6 && width >= 30) { assert.match(plain(rows), /Pasos 2\/8/); assert.match(plain(rows), /Checks 0\/3/); assert.match(plain(rows), /Falta aprobación/); }
   assert.doesNotMatch(plain(rows), /✓|100%/);
  }
  const rows = workflowProgressPanel(theme, progress(), 33, 10);
  assert.match(plain(rows), /PROGRESO/); assert.match(plain(rows), /Desarrollo/); assert.match(plain(rows), /Con diseño/); assert.match(plain(rows), /Implementando/);
  assert.match(plain(workflowProgressPanel(theme, progress({ totalChecks: 0 }), 33, 10)), /sin checks informados/i);
 }
});

test("workflow sidebar prioritizes progress at 20 rows without removing existing sections or stale hit targets", () => {
 for (const name of ["dark", "light"]) for (const height of [20, 22, 28, 64]) {
  const monitor = new SubagentMonitor(); monitor.start("many", { tasks: Array.from({ length: 8 }, () => ({ agent: "worker", task: "Implementar" })) });
  const state = { theme: getThemeByName(name)!, cwd: "/repo/issue-42", height, git: git(), gitError: false, actions: { reviews: {}, releases: {} }, context: { label: "100 / 200", percent: 50, limit: 200 }, subagents: monitor, workflowProgress: progress({ status: "waiting", blockedReason: "Falta aprobación" }) };
  const frame = workspaceSidebar(state, 33); assert.equal(frame.lines.length, height);
  for (const row of frame.lines) assert.equal(visibleWidth(row), 33);
  for (const title of ["PROGRESO", "PROYECTO", "GITHUB ACTIONS", "OMI", "SUBAGENTES", "SESIÓN", "RECURSOS"]) assert.match(plain(frame.lines), new RegExp(`(?:┌|├)─ ${title}`));
  assert.match(plain(frame.lines), /Falta aprobación/); assert.match(plain(frame.lines), /Pasos 2\/8.*Checks 0\/3/);
  assert.ok([...frame.targets.keys()].every((row) => row < height)); assert.ok([...frame.targets.values()].includes("progress"));
  const wrong = workspaceSidebar({ ...state, git: git({ branch: "other" }) }, 33); assert.doesNotMatch(plain(wrong.lines), /PROGRESO|Falta aprobación/);
 }
});

async function runtime(home: string) {
 execFileSync("git", ["init", "-b", "feat/issue-42"], { cwd: home, stdio: "ignore" });
 const events = createEventBus(); const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
 const commands = new Map<string, { handler: () => Promise<void> }>(); let root: Component | undefined; let modal: Component | undefined; let palette = false; let executions = 0; let focus: Component | null = null; let input: ((data: string) => { consume: boolean } | undefined) | undefined;
 const document = new Container(); document.addChild(new Text("", 0, 0)); document.addChild(new Container()); document.addChild(new Container());
 const editor = new Container(); const footer = new Container();
 const ui = { [Symbol.for("@earendil-works/pi-tui/viewport")]: true, mode: "fullscreen", terminal: { columns: 132, rows: 40 }, children: [document, new Container(), new Container(), new Container(), editor, new Container(), footer], requestRender() {}, setLayoutRoot(next: Component) { root = next; }, hasOverlay: () => false, setFocus(next: Component | null) { focus = next; } } as unknown as TUI;
 const theme = getThemeByName("dark")!;
 const ctx = { mode: "tui", cwd: home, isIdle: () => true, isProjectTrusted: () => false, getContextUsage: () => undefined, sessionManager: { getBranch: () => [] },
 ui: { theme, getTheme: () => undefined, setHeader() {}, setWidget() {}, getEditorComponent: () => () => undefined, setFooter: (factory: (ui: TUI, theme: Theme, data: unknown) => Component) => footer.addChild(factory(ui, theme, { getExtensionStatuses: () => new Map() })), onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; }, notify() {},
 custom: async (factory: (ui: TUI, theme: Theme, keys: unknown, done: (value: unknown) => void) => Component) => {
  let result: unknown; modal = factory(ui, theme, { matches: () => false }, (value) => { result = value; });
  if (modal instanceof OmiCommandPalette) { palette = true; const index = modal.items.findIndex((item) => item.label === "Progreso de desarrollo"); assert.ok(index >= 0); for (let i = 0; i < index; i++) modal.handleInput("\x1b[B"); modal.handleInput("\r"); }
  return result;
 } } } as unknown as ExtensionContext;
 const extension = workspaceExtension(testIo({ cwd: home, homeDir: home, env: {} }), ["--offline"]); if (typeof extension === "function") throw Error("named extension expected");
 await extension.factory({ events, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: (name: string, value: { handler: () => Promise<void> }) => commands.set(name, value), registerMarkdownTransformer() {}, getSettings: () => ({}), exec: () => { executions++; throw Error("UI must not execute"); } } as never);
 await handlers.get("session_start")?.({}, ctx);
 const frame = (width = 132, height = 40) => { Object.assign(ui.terminal, { columns: width, rows: height }); return renderLayoutFrame(root!, width, height, () => {}); };
 return { events, frame, commands, key(data: string) { if (!input?.(data)?.consume) focus?.handleInput?.(data); }, modal: () => modal!, palette: () => palette, executions: () => executions, tree: () => handlers.get("session_tree")?.({}, ctx), stop: () => handlers.get("session_shutdown")?.({}, ctx),
 click(x: number, y: number) { const box = getLayoutBoxesAt(frame(), x, y).find((box) => box.component.handleMouse); box?.component.handleMouse?.({ type: "click", x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height } as never); } };
}

test("workflow runtime: startup event after workspace, click/detail, palette while hidden, navigation and shutdown reset", async (t) => {
 const home = await tempDir(t); const ui = await runtime(home); t.after(ui.stop);
 ui.events.emit("omi:workflow", { progress: progress({ worktree: home }) });
 for (let i = 0; i < 100 && !plain(ui.frame().lines).includes("PROGRESO"); i++) await setTimeout(20);
 assert.match(plain(ui.frame().lines), /PROGRESO/);
 const row = ui.frame().lines.findIndex((line) => stripTerminalSequences(line).includes("PROGRESO")); ui.click(120, row);
 assert.ok(ui.modal() instanceof OmiInfoModal); assert.match(plain(ui.modal().render(104)), /Progreso de desarrollo/);
 await ui.commands.get("omi-progress")!.handler();
 ui.frame(80, 16); await ui.commands.get("omi")!.handler(); assert.equal(ui.palette(), true); assert.match(plain(ui.modal().render(72)), /Etapa: Desarrollo/);
 assert.equal(ui.executions(), 0);
 ui.tree(); assert.doesNotMatch(plain(ui.frame().lines), /PROGRESO/);
 ui.events.emit("omi:workflow", { progress: progress({ worktree: home, branch: "other" }) }); assert.doesNotMatch(plain(ui.frame().lines), /PROGRESO/);
 ui.events.emit("omi:workflow", { progress: progress({ worktree: home }) }); assert.match(plain(ui.frame().lines), /PROGRESO/);
 ui.events.emit("omi:workflow", { progress: undefined }); assert.doesNotMatch(plain(ui.frame().lines), /PROGRESO/);
 await ui.commands.get("omi-progress")!.handler(); assert.match(plain(ui.modal().render(80)), /Sin progreso/);
 await ui.stop(); ui.events.emit("omi:workflow", { progress: progress({ worktree: home }) }); assert.doesNotMatch(plain(ui.frame().lines), /PROGRESO/);
});

test("workflow detail uses existing modal with scrolling, responsive width and no inferred check success", () => {
 const entries = workflowProgressDetail(progress({ details: Array.from({ length: 40 }, (_, i) => `Detalle ${i} 漢字🙂`) }));
 let closed = false; const theme = getThemeByName("light")!;
 const modal = new OmiInfoModal({ title: "Progreso de desarrollo", content: entries, theme: () => theme, rows: () => 16, redraw() {}, done() { closed = true; } });
 assert.match(plain(modal.render(33)), /Issue: #42/); modal.handleInput("\x1b[F"); assert.match(plain(modal.render(33)), /Detalle 39/);
 modal.handleInput("\x1b[H"); assert.match(plain(modal.render(33)), /Issue: #42/); modal.handleInput("\x1b"); assert.equal(closed, true);
 for (const row of modal.render(33)) assert.equal(visibleWidth(row), 33);
});

test("screen 6: Ctrl+6, tab click and command, live events, scrolling, hidden sidebar and Esc", async t => {
 const home = await tempDir(t); const ui = await runtime(home); t.after(ui.stop);
 const { createWorkflow } = await import("../src/harness/state.ts");
 const { developmentProgress } = await import("../src/tui/development-view.ts");
 const p = developmentProgress(createWorkflow({ number: 42, title: "Feature", body: "Details", url: "https://example.test/42", hash: "old" }, { root: home, commonDir: "/git", branch: "feat/issue-42", baseCommit: "base" }, "work", "now"));
 ui.events.emit("omi:workflow", { progress: p });
 for (let i = 0; i < 100 && !plain(ui.frame().lines).includes("PROGRESO"); i++) await setTimeout(20);
 ui.key("\x1b[54;5u");
 assert.match(plain(ui.frame().lines), /Recorrido del harness/);
 ui.key("\x1b"); assert.doesNotMatch(plain(ui.frame().lines), /Recorrido del harness/);
 assert.ok(ui.commands.has("omi-workflow")); await ui.commands.get("omi-workflow")!.handler();
 ui.frame(80, 16); assert.match(plain(ui.frame(80, 16).lines), /Recorrido del harness/);
 for (let i = 0; i < 15; i++) ui.key("\x1b[6~");
 assert.match(plain(ui.frame(80, 16).lines), /Cerrado sin cambio/);
 ui.key("\x1b[H");
 p.activity = "LIVE_UPDATE"; ui.events.emit("omi:workflow", { progress: p }); assert.match(plain(ui.frame(80, 16).lines), /LIVE_UPDATE/);
 ui.key("\x1b"); ui.frame();
 const { workspaceTabs } = await import("../src/tui/workspace/navigation.ts");
 const tab = workspaceTabs(132, "chat").find(tab => tab.view === "workflow"); assert.ok(tab); ui.click(tab.start + 1, 1);
 assert.match(plain(ui.frame().lines), /Recorrido del harness/); assert.equal(ui.executions(), 0);
 ui.events.emit("omi:workflow", { progress: undefined }); assert.match(plain(ui.frame().lines), /Sin progreso/);
});

test("lens warnings stay visible in the sidebar, screen 6 and the detail, sanitized and without blocking", async () => {
 const { createWorkflow } = await import("../src/harness/state.ts");
 const { developmentProgress } = await import("../src/tui/development-view.ts");
 const { workflowProgressView } = await import("../src/tui/workspace/workflow-progress.ts");
 const base = developmentProgress(createWorkflow({ number: 42, title: "Feature", body: "Details", url: "https://example.test/42", hash: "old" }, { root: "/repo/issue-42", commonDir: "/git", branch: "feat/issue-42", baseCommit: "base" }, "work", "now"));
 const stages = base.stages!.map(s => s.id === "verify" ? { ...s, status: "warning" as const } : s);
 const monitor = new WorkflowProgressMonitor();
 assert.equal(monitor.consume({ progress: { ...base, stages, warnings: [1] } }), false, "warnings must be strings");
 assert.equal(monitor.consume({ progress: { ...base, stages, warnings: ["Lente compliance · unknown · sin historial\x1b]0;EVIL\x07", "Lente reliability · fail · falta el caso 0"] } }), true);
 const p = monitor.current("/repo/issue-42", git())!;
 assert.doesNotMatch(JSON.stringify(p), /EVIL|\\u001b/);
 for (const name of ["dark", "light"]) {
  const theme = getThemeByName(name)!;
  const panel = plain(workflowProgressPanel(theme, p, 33, 30)); assert.match(panel, /Avisos de lentes: 2/); assert.match(panel, /Verificar/);
  const view = plain(workflowProgressView(theme, p, 80)); assert.match(view, /Verificar · Con avisos/); assert.match(view, /compliance · unknown/); assert.match(view, /reliability · fail/); assert.match(view, /no bloquean/i);
 }
 const detail = plain(workflowProgressDetail(p).map(e => typeof e === "string" ? e : JSON.stringify(e)));
 assert.match(detail, /compliance · unknown/);
});

test("sidebar journey stays all or nothing with a lens warnings row, and the warnings come before the stages", async () => {
 const { createWorkflow } = await import("../src/harness/state.ts");
 const { developmentProgress } = await import("../src/tui/development-view.ts");
 const base = developmentProgress(createWorkflow({ number: 42, title: "Feature", body: "Details", url: "https://example.test/42", hash: "old" }, { root: "/repo/issue-42", commonDir: "/git", branch: "feat/issue-42", baseCommit: "base" }, "work", "now"));
 const labels = base.stages!.map(s => s.label); let journeys = 0;
 for (const blockedReason of ["", "Falta aprobación"]) for (let height = 20; height <= 64; height++) {
  const monitor = new SubagentMonitor();
  const state = { theme: getThemeByName("dark")!, cwd: "/repo/issue-42", height, git: git(), gitError: false, actions: { reviews: {}, releases: {} }, context: { label: "100 / 200", percent: 50, limit: 200 }, subagents: monitor, workflowProgress: { ...base, blockedReason, warnings: ["Lente compliance · unknown · sin historial"] } };
  const text = plain(workspaceSidebar(state, 33).lines);
  const shown = labels.filter(label => text.includes(`${label} ·`));
  assert.ok(shown.length === 0 || shown.length === labels.length, `altura ${height}: ${shown.length}/${labels.length} etapas`);
  if (shown.length) { journeys++; assert.match(text, /Avisos de lentes: 1/, `altura ${height}`); }
 }
 assert.ok(journeys > 0, "some height shows the whole journey");
});
