import assert from "node:assert/strict";
import { test } from "node:test";
import { colorToHex, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Theme, getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { consumeSubagentEvent, subagentDuration, SubagentMonitor, subagentsPanel } from "../src/tui/workspace/subagents.ts";

const task = (agent = "worker", text = "Implementar tarea") => ({ agent, task: text });
const snapshot = (...results: unknown[]) => ({ results });

test("single: preflight pending, snapshots estables, resultado y copias defensivas", () => {
	const monitor = new SubagentMonitor();
	monitor.start("one", task());
	assert.deepEqual(monitor.tasks, [{ id: "one/0", agent: "worker", title: "Implementar tarea", status: "pending", turns: 0, activity: "", queuedAt: monitor.tasks[0]!.queuedAt }]);
	assert.ok(Number.isFinite(monitor.tasks[0]!.queuedAt));
	monitor.start("one", task("scout"));
	monitor.update("one", snapshot({ agent: "worker", status: "running", turns: 2, activity: "read" }));
	const running = monitor.tasks[0]!;
	assert.equal(running.status, "running"); assert.equal(running.activity, "read"); assert.ok(running.startedAt);
	running.status = "error";
	assert.equal(monitor.tasks[0]!.status, "running");
	monitor.end("one", snapshot({ status: "done", turns: 3 }), false);
	assert.equal(monitor.tasks[0]!.status, "done"); assert.equal(monitor.tasks[0]!.turns, 3);
	assert.equal(monitor.tasks[0]!.activity, ""); assert.ok(monitor.tasks[0]!.endedAt);
	monitor.update("one", snapshot({ status: "running" }));
	assert.equal(monitor.tasks[0]!.status, "done");
});

test("paralelo y múltiples callIds conservan IDs y priorizan activos", () => {
	const monitor = new SubagentMonitor();
	monitor.start("old", task()); monitor.end("old", snapshot({ status: "done" }), false);
	monitor.start("parallel", { tasks: [task("scout"), task("planner"), task("reviewer"), task()] });
	monitor.start("preflight", task("scout"));
	assert.deepEqual(monitor.tasks.map((item) => item.id), ["parallel/0", "parallel/1", "parallel/2", "parallel/3", "preflight/0", "old/0"]);
	monitor.update("parallel", snapshot({ status: "running" }, { status: "done" }, { status: "running" }, { status: "error" }));
	assert.equal(monitor.tasks.filter((item) => item.status === "running").length, 2);
	assert.ok(monitor.tasks.slice(0, 2).every((item) => item.status === "running"), "las tareas realmente ejecutando preceden a las que esperan en cola");
	monitor.end("parallel", undefined, true);
	assert.equal(monitor.tasks.find((item) => item.id === "parallel/1")!.status, "done");
	assert.equal(monitor.tasks.find((item) => item.id === "preflight/0")!.status, "pending");
});

test("chain detenida, bloqueos y abortos no inventan ejecución ni éxito", () => {
	const monitor = new SubagentMonitor();
	monitor.start("chain", { chain: [task("scout"), task(), task("reviewer")] });
	monitor.end("chain", snapshot({ status: "error", turns: 1 }, { status: "pending" }, { status: "pending" }), true);
	assert.deepEqual(monitor.tasks.map((item) => item.status), ["error", "skipped", "skipped"]);
	assert.ok(monitor.tasks.every((item) => item.startedAt === undefined));
	for (const isError of [false, true]) {
		monitor.start(`blocked-${isError}`, task()); monitor.end(`blocked-${isError}`, undefined, isError);
		assert.equal(monitor.tasks.find((item) => item.id === `blocked-${isError}/0`)!.status, "skipped");
	}
	monitor.start("abort", task()); monitor.update("abort", snapshot({ status: "running" })); monitor.end("abort", null, true);
	assert.equal(monitor.tasks.find((item) => item.id === "abort/0")!.status, "error");
});

test("settle, clear e historial acotado sin desalojar preflight activos", () => {
	const monitor = new SubagentMonitor();
	monitor.start("keep", task());
	for (let index = 0; index < 100; index++) {
		monitor.start(String(index), { tasks: Array.from({ length: 8 }, () => task()) });
		monitor.end(String(index), snapshot({ status: "done" }), false);
	}
	assert.equal(monitor.tasks.length, 65); assert.equal(monitor.tasks[0]!.id, "keep/0");
	monitor.start("running", task()); monitor.update("running", snapshot({ status: "running" }));
	monitor.settle(); assert.ok(monitor.tasks.every((item) => !["pending", "running"].includes(item.status)));
	assert.ok(monitor.tasks.length <= 64);
	monitor.clear(); assert.deepEqual(monitor.tasks, []);
	monitor.update("running", snapshot({ status: "running" })); assert.deepEqual(monitor.tasks, []);
});

test("payload inválido y privacidad: sólo metadata acotada, nunca outputs ni tareas completas", () => {
	const monitor = new SubagentMonitor();
	for (const input of [null, [], {}, { agent: "other", task: "x" }, { agent: "worker", task: "" }, { tasks: Array(9).fill(task()) }, { tasks: [task()], chain: [task()] }, { tasks: [null] }]) monitor.start("invalid", input);
	assert.equal(monitor.tasks.length, 0);
	monitor.start("safe", task("worker", "\x1b[31m漢字🙂\n\t\x00" + "x".repeat(20000) + "PRIVATE_TASK_END"));
	for (const details of [undefined, null, [], { results: "bad" }, snapshot(null), snapshot({ status: "bogus", turns: Infinity })]) monitor.update("safe", details);
	monitor.update("safe", snapshot({ agent: "alien", status: "running", turns: -5, activity: "\x1b[31mread\x1b[0m\n\x00" + "z".repeat(10000), output: "PRIVATE_OUTPUT", usage: { private: true }, history: "PRIVATE_HISTORY" }));
	const item = monitor.tasks[0]!;
	assert.equal(item.agent, "worker"); assert.equal(item.turns, 0);
	assert.ok(visibleWidth(item.title) <= 96); assert.ok(visibleWidth(item.activity) <= 48);
	const stored = JSON.stringify(monitor);
	assert.doesNotMatch(JSON.stringify(item), /PRIVATE|output|usage|history|\u001b|\u0000/);
	assert.doesNotMatch(stored, /PRIVATE/);
	assert.ok(JSON.stringify(item).length < 500);
});

test("panel: vacío, contador, overflow, orden, duración y límite duro", () => {
	const monitor = new SubagentMonitor(); const theme = getThemeByName("dark")!;
	assert.match(stripTerminalSequences(subagentsPanel(theme, monitor, 60, 5)[0]!), /SUBAGENTS/);
	assert.match(stripTerminalSequences(subagentsPanel(theme, monitor, 60, 5)[1]!), /Sin subagentes activos/);
	monitor.start("old", task()); monitor.end("old", snapshot({ status: "done" }), false);
	monitor.start("new", { tasks: [task("scout"), task("planner")] });
	monitor.update("new", snapshot({ status: "running", turns: 1, activity: "read" }, { status: "pending" }));
	const now = monitor.tasks.find((item) => item.startedAt)!.startedAt! + 12000;
	const rows = subagentsPanel(theme, monitor, 80, 3, now).map(stripTerminalSequences);
	assert.equal(rows.length, 3); assert.match(rows[0]!, /SUBAGENTS.*1 activos · 1 en cola/);
	assert.match(rows[1]!, /scout · running · read · 12s/); assert.match(rows[2]!, /\+2 más/);
	assert.match(stripTerminalSequences(subagentsPanel(theme, monitor, 40, 2)[1]!), /\+3 más/);
	for (const maxRows of [0, 1, 2, 3, 4, 10]) assert.ok(subagentsPanel(theme, monitor, 30, maxRows).length <= maxRows);
});

test("panel: dark/light truecolor/256, Unicode, controles y anchuras exactas", () => {
	for (const name of ["dark", "light"]) for (const mode of ["truecolor", "256color"] as const) {
		const base = getThemeByName(name)!;
		const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
		const theme = new Theme(colors, colors, mode);
		const monitor = new SubagentMonitor(); monitor.start("unicode", task("worker", "漢字🙂é\x1b[31m\n\x00".repeat(40)));
		monitor.update("unicode", snapshot({ status: "running", activity: "漢字🙂\x1b]0;evil\x07\n\t\u202e".repeat(30) }));
		for (const width of [0, 1, 2, 4, 8, 16, 30, 60, 100]) for (const maxRows of [1, 2, 3, 5]) {
			const rows = subagentsPanel(theme, monitor, width, maxRows);
			assert.ok(rows.length <= maxRows);
			for (const row of rows) {
				assert.equal(visibleWidth(row), width);
				assert.doesNotMatch(stripTerminalSequences(row), /[\x00-\x1f\x7f-\x9f\u202e]|evil|\ufffd/);
			}
		}
	}
});

test("bus: valida envelopes, aplica details iniciales y termina sin inventar éxito", () => {
	const monitor = new SubagentMonitor();
	for (const event of [null, [], {}, { phase: "start", id: "" }, { phase: "start", id: "bad\nID" }, { phase: "other", id: "job" }]) assert.equal(consumeSubagentEvent(monitor, event), false);
	assert.equal(consumeSubagentEvent(monitor, { phase: "start", id: "job", args: task(), details: snapshot({ status: "running", activity: "read" }) }), true);
	assert.equal(monitor.tasks[0]!.status, "running"); assert.equal(monitor.tasks[0]!.activity, "read");
	const running = monitor.tasks[0]!;
	assert.equal(subagentDuration(running, running.startedAt! + 4500), "4s");
	consumeSubagentEvent(monitor, { phase: "end", id: "job", isError: true });
	assert.equal(monitor.tasks[0]!.status, "error"); assert.equal(monitor.tasks[0]!.activity, "");
	consumeSubagentEvent(monitor, { phase: "update", id: "job", details: snapshot({ status: "done" }) });
	assert.equal(monitor.tasks[0]!.status, "error");
	monitor.clear(); consumeSubagentEvent(monitor, { phase: "update", id: "job", details: snapshot({ status: "running" }) });
	assert.deepEqual(monitor.tasks, []);
});

test("panel: reserva duración aun con nombres de tools largos y mantiene cola visible en overflow", () => {
	const theme = getThemeByName("dark")!; const monitor = new SubagentMonitor();
	monitor.start("eight", { tasks: Array.from({ length: 8 }, () => task()) });
	monitor.update("eight", snapshot(...Array.from({ length: 4 }, () => ({ status: "running", activity: "mcp__large_namespace__long_tool_name" }))));
	const now = monitor.tasks[0]!.startedAt! + 42000;
	const panel = subagentsPanel(theme, monitor, 30, 4, now).map(stripTerminalSequences);
	assert.match(panel[0]!, /SUBAGENTS.*4 act\/4 cola/);
	assert.match(panel[1]!, /worker.*running.*42s/);
	assert.match(panel[3]!, /\+6 más.*4 activos.*4 en cola/);
	assert.equal(subagentDuration(monitor.tasks.at(-1)!, monitor.tasks.at(-1)!.queuedAt + 3000), "3s");
});
