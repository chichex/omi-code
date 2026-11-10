import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { actionRunLine, actionsPanel, readActionRuns, runAge, type ActionRun } from "../src/tui/workspace/github-actions.ts";
import type { GitSnapshot } from "../src/tui/workspace/data.ts";

const now = Date.parse("2026-11-10T12:00:00Z");
const run: ActionRun = { id: 42, name: "feat/herdr-status", status: "completed", conclusion: "success", createdAt: "2026-11-10T11:18:00Z", url: "https://github.com/test/repo/actions/runs/42" };

test("workspace_Actions lee tres runs por workflow, de todo el repo y también con HEAD separado", async () => {
	const git = { root: "/repo", detached: true } as GitSnapshot;
	for (const [group, workflow] of [["reviews", "claude-review.yml"], ["releases", "release.yml"]] as const) {
		const signal = new AbortController().signal;
		const result = await readActionRuns(git, group, signal, async (command, args, cwd, receivedSignal) => {
			assert.equal(command, "gh"); assert.equal(cwd, "/repo"); assert.equal(receivedSignal, signal);
			assert.deepEqual(args.slice(0, 6), ["run", "list", "--workflow", workflow, "--limit", "3"]);
			assert.ok(!args.includes("--branch"));
			return { code: 0, stdout: JSON.stringify([{ databaseId: 42, displayTitle: run.name, status: run.status, conclusion: run.conclusion, createdAt: run.createdAt, url: run.url }]) };
		});
		assert.deepEqual(result, [run]);
	}
	assert.deepEqual(await readActionRuns(git, "reviews", undefined, async () => ({ code: 0, stdout: "[]" })), []);
	for (const response of [{ code: 1, stdout: "" }, { code: 0, stdout: "[]", truncated: true }, { code: 0, stdout: "{}" }, { code: 0, stdout: "[null]" }, { code: 0, stdout: '[{"databaseId":0,"status":"completed"}]' }]) {
		await assert.rejects(readActionRuns(git, "reviews", undefined, async () => response));
	}
});

test("workspace_Actions conserva edad a la derecha, estados reales y ancho con Unicode y controles", () => {
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name)!;
		for (const [status, conclusion, icon] of [["completed", "success", "✓"], ["completed", "failure", "✗"], ["in_progress", "", "●"], ["queued", "", "◷"], ["completed", "cancelled", "−"], ["completed", "skipped", "−"], ["completed", "", "−"]]) {
			for (const width of [0, 1, 4, 8, 26, 50]) {
				const row = actionRunLine(theme, { ...run, name: "漢字🙂".repeat(30) + "\x1b\n", status: status!, conclusion: conclusion! }, width, now);
				assert.equal(visibleWidth(row), width);
				assert.doesNotMatch(stripTerminalSequences(row), /\x1b|\n/);
				if (width >= 9) { assert.ok(stripTerminalSequences(row).startsWith(icon!)); assert.match(stripTerminalSequences(row), /42m$/); }
			}
		}
		const panel = actionsPanel(theme, { reviews: { runs: [run] }, releases: { runs: [{ ...run, name: "v0.4.0" }] } }, 30, 3, now);
		assert.ok(panel.every((row) => visibleWidth(row) === 30));
		assert.match(panel.map(stripTerminalSequences).join("\n"), /▌ GITHUB ACTIONS.*\n.*Claude reviews.*\n.*✓ feat\/herdr-status.*  42m.*\n.*Releases.*\n.*✓ v0\.4\.0.*  42m/s);
		assert.doesNotMatch(panel.map(stripTerminalSequences).join("\n"), /[┌┐└┘│]/, "sin un segundo marco que robe ancho");
		for (const width of [0, 1, 4, 8, 16, 30]) for (const count of [0, 1, 2, 3]) {
			const rows = actionsPanel(theme, { reviews: { runs: [run, run, run] }, releases: { runs: [run, run, run] } }, width, count, now);
			assert.ok(rows.every((row) => visibleWidth(row) === width));
			if (count === 0) assert.equal(rows.length, 3, "un resumen por workflow en terminales bajas");
		}
		const long = stripTerminalSequences(actionRunLine(theme, { ...run, name: "Merge pull request #123 from a very long branch" }, 30, now));
		assert.match(long, /^✓ Merge pull request.*…  42m$/);
		const compact = actionsPanel(theme, { reviews: { runs: [run] }, releases: { runs: [] } }, 30, 0, now).map(stripTerminalSequences).join("\n");
		assert.match(compact, /Claude reviews.*✓ 42m/); assert.match(compact, /Releases.*Sin runs/);
		for (const [error, expected] of [["Offline", "Offline"], ["Proyecto sin confianza", "Sin confianza"], ["Sin repositorio Git", "Sin repo Git"], ["No disponible", "No disponible"]] as const) {
			const rows = actionsPanel(theme, { reviews: { error }, releases: { error } }, 30, 0, now).map(stripTerminalSequences).join("\n");
			assert.ok(rows.includes(`Claude reviews${" ".repeat(30 - 14 - expected.length)}${expected}`));
		}
		const stale = actionsPanel(theme, { reviews: { runs: [run], error: "No disponible" }, releases: { error: "Offline" } }, 30).map(stripTerminalSequences).join("\n");
		assert.match(stale, /Datos desactualizados/); assert.match(stale, /feat\/herdr-status/); assert.match(stale, /Offline/); assert.doesNotMatch(stale, /Sin ejecuciones/);
		const empty = actionsPanel(theme, { reviews: { runs: [] }, releases: {} }, 30).map(stripTerminalSequences).join("\n");
		assert.match(empty, /Sin ejecuciones/); assert.match(empty, /Consultando/);
	}
	for (const [date, expected] of [["invalid", "—"], ["2026-11-10T12:01:00Z", "ahora"], ["2026-11-10T11:18:00Z", "42m"], ["2026-11-10T10:00:00Z", "2h"], ["2026-11-06T12:00:00Z", "4d"]]) assert.equal(runAge(date!, now), expected);
});
