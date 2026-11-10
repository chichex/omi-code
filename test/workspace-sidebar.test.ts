import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundAnsi, colorToHex, mixColors, parseColor, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
// El mismo lector de SGR que usa el renderer versionado, no sólo texto sin ANSI.
import { getActiveBackgroundAnsi } from "../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { Theme, getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { actionRunLine } from "../src/tui/workspace/github-actions.ts";
import { fit, gitSyncSummary, sidebarSection, surface } from "../src/tui/workspace/presentation.ts";

const sections = [["PROYECTO", "syntaxType"], ["GITHUB ACTIONS", "mdLink"], ["OMI", "success"], ["CONTEXTO", "warning"], ["EQUIPO", "syntaxVariable"]] as const;

test("workspace_lateral divide las cinco secciones con color, negrita, fondo tenue y separadores sin overflow", () => {
	for (const name of ["dark", "light"]) for (const mode of ["truecolor", "256color"] as const) {
		const base = getThemeByName(name)!;
		const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
		const theme = new Theme(colors, colors, mode); const headers = new Set<string>();
		assert.equal(new Set(sections.map(([, color]) => colorToHex(theme.colors[color]))).size, sections.length, "la paleta define cinco colores distintos");
		for (const [title, color] of sections) {
			const bg = mixColors(parseColor(name === "light" ? "#f3f4f5" : "#15191c"), theme.colors[color], .1);
			const row = sidebarSection(theme, title, 30, color); const plain = stripTerminalSequences(row);
			assert.equal(visibleWidth(row), 30); assert.ok(plain.startsWith(`▌ ${title} `)); assert.ok(plain.endsWith("─"));
			assert.ok(row.includes(theme.getFgAnsi(color))); assert.ok(row.includes("\x1b[1m"));
			const background = backgroundAnsi(bg, theme.getColorMode()); assert.ok(row.includes(background)); headers.add(theme.getFgAnsi(color));
			// Pintar la lateral completa no debe borrar el fondo propio del encabezado.
			assert.ok(surface(theme, `│ ${row} `, 33, true).includes(background));
		}
		// La cuantización a 256 colores puede unir tonos distintos de la paleta RGB.
		if (mode === "truecolor") assert.equal(headers.size, sections.length, "truecolor conserva los cinco colores");
		else assert.ok(headers.size >= 4, "256color conserva al menos cuatro colores distinguibles");
		for (const width of [0, 1, 2, 4, 8, 16, 30, 60]) {
			const row = sidebarSection(theme, "EQUIPO · host-漢字-🙂-muy-largo".repeat(4) + "\x1b\n", width, "syntaxVariable");
			assert.equal(visibleWidth(row), width); assert.doesNotMatch(stripTerminalSequences(row), /\x1b|\n/);
		}
	}
});

test("workspace_superficies conservan el fondo en cada celda al truncar y al cerrar encabezados", () => {
	for (const name of ["dark", "light"]) for (const mode of ["truecolor", "256color"] as const) {
		const base = getThemeByName(name)!;
		const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
		const theme = new Theme(colors, colors, mode);
		const run = { id: 1, name: "Merge pull request #123 from branch-".repeat(4), status: "completed", conclusion: "success", createdAt: "2026-11-10T10:00:00Z", url: "" };
		for (const panel of [false, true]) {
			const bg = parseColor(name === "light" ? (panel ? "#f3f4f5" : "#ffffff") : (panel ? "#15191c" : "#050607"));
			const expected = backgroundAnsi(bg, mode);
			for (const content of [
				theme.fg("accent", "feat/github-actions-sidebar · repo".repeat(4)),
				`│ ${fit(theme.fg("accent", "漢字🙂".repeat(30)), 30)} `,
				`│ ${actionRunLine(theme, run, 30, Date.parse("2026-11-10T12:00:00Z"))} `,
				"antes\x1b[0mdespués\x1b[49mfin\x1b[m",
			]) {
				const row = surface(theme, content, 33, panel);
				assert.equal(visibleWidth(row), 33);
				for (let column = 0; column < 33; column++) assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, column + 1)), expected, `${name}/${mode} columna ${column}: ${JSON.stringify(row)}`);
				assert.equal(getActiveBackgroundAnsi(row), "", "el fondo no se filtra a otro componente");
			}
		}
		const header = sidebarSection(theme, "OMI", 30, "success");
		const row = surface(theme, `│ ${header} `, 33, true);
		const panelBg = backgroundAnsi(parseColor(name === "light" ? "#f3f4f5" : "#15191c"), mode);
		assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, 2)), panelBg);
		assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, 3)), getActiveBackgroundAnsi(sliceByColumn(header, 0, 1)), "se conserva el tinte del encabezado");
		assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, 33)), panelBg, "el margen recupera el fondo del panel");
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
