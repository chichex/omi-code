import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundAnsi, mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { gitSyncSummary, sidebarSection, surface } from "../src/tui/workspace/presentation.ts";

const sections = [["PROYECTO", "syntaxType"], ["GITHUB", "mdLink"], ["OMI", "success"], ["CONTEXTO", "warning"], ["EQUIPO", "syntaxVariable"]] as const;

test("workspace_lateral divide las cinco secciones con color, negrita, fondo tenue y separadores sin overflow", () => {
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name)!; const headers = new Set<string>();
		for (const [title, color] of sections) {
			const bg = mixColors(parseColor(name === "light" ? "#f3f4f5" : "#15191c"), theme.colors[color], .1);
			const row = sidebarSection(theme, title, 30, color); const plain = stripTerminalSequences(row);
			assert.equal(visibleWidth(row), 30); assert.ok(plain.startsWith(`▌ ${title} `)); assert.ok(plain.endsWith("─"));
			assert.ok(row.includes(theme.getFgAnsi(color))); assert.ok(row.includes("\x1b[1m"));
			const background = backgroundAnsi(bg, theme.getColorMode()); assert.ok(row.includes(background)); headers.add(theme.getFgAnsi(color));
			// Pintar la lateral completa no debe borrar el fondo propio del encabezado.
			assert.ok(surface(theme, `│ ${row} `, 33, true).includes(background));
		}
		assert.equal(headers.size, sections.length, "las secciones no usan todas el mismo gris/acento");
		for (const width of [0, 1, 2, 4, 8, 16, 30, 60]) {
			const row = sidebarSection(theme, "EQUIPO · host-漢字-🙂-muy-largo".repeat(4) + "\x1b\n", width, "syntaxVariable");
			assert.equal(visibleWidth(row), width); assert.doesNotMatch(stripTerminalSequences(row), /\x1b|\n/);
		}
	}
});

test("workspace_sync distingue al día, commits pendientes, sin upstream y datos no disponibles con colores", () => {
	const theme = getThemeByName("dark")!;
	const synced = gitSyncSummary(theme, { tracking: true, ahead: 0, behind: 0 });
	assert.equal(stripTerminalSequences(synced), "Al día (local)"); assert.ok(synced.includes(theme.fg("success", "Al día (local)")));
	for (const [ahead, behind] of [[3, 0], [0, 12], [3, 12]]) {
		const row = gitSyncSummary(theme, { tracking: true, ahead, behind });
		assert.equal(stripTerminalSequences(row), `↑${ahead} ↓${behind}`);
		assert.ok(row.includes(theme.fg(ahead ? "success" : "dim", `↑${ahead}`)));
		assert.ok(row.includes(theme.fg(behind ? "warning" : "dim", `↓${behind}`)));
	}
	assert.equal(stripTerminalSequences(gitSyncSummary(theme, { tracking: false, ahead: undefined, behind: undefined })), "sin upstream");
	for (const snapshot of [{ tracking: undefined, ahead: undefined, behind: undefined }, { tracking: true, ahead: undefined, behind: undefined }]) {
		const row = gitSyncSummary(theme, snapshot); assert.equal(stripTerminalSequences(row), "↑— ↓—");
		assert.ok(row.includes(theme.fg("warning", "↑— ↓—"))); assert.doesNotMatch(stripTerminalSequences(row), /0|Al día|sin upstream/);
	}
});
