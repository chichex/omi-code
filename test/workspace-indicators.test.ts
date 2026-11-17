import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundAnsi, colorToHex, parseColor, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getActiveBackgroundAnsi } from "../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { Theme, getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { dots, reasoningDots, sidebarBox, sidebarSurface } from "../src/tui/workspace/indicators.ts";

test("círculos: ocupación acotada, estados desconocidos y umbrales semánticos", () => {
	const theme = getThemeByName("dark")!;
	for (const [percent, filled] of [[undefined, 0], [NaN, 0], [-50, 0], [0, 0], [28, 3], [80, 8], [95, 10], [200, 10]] as const) {
		const row = dots(theme, percent, 10);
		assert.equal(stripTerminalSequences(row), "●".repeat(filled) + "○".repeat(10 - filled));
		assert.equal(visibleWidth(row), 10);
		if (filled) assert.ok(row.includes(theme.getFgAnsi(percent! >= 90 ? "error" : percent! >= 80 ? "warning" : "success")));
	}
	assert.equal(dots(theme, 50, 0), ""); assert.equal(visibleWidth(dots(theme, 50, 3.9)), 3);
	assert.ok(dots(theme, 100, 6, "accent").includes(theme.getFgAnsi("accent")));
});

test("razonamiento: escala de esfuerzo, no ranking inventado del modelo", () => {
	const theme = getThemeByName("dark")!;
	for (const [index, level] of ["off", "minimal", "low", "medium", "high", "xhigh", "max"].entries()) {
		assert.equal(stripTerminalSequences(reasoningDots(theme, level)), "●".repeat(index) + "○".repeat(6 - index));
	}
	assert.equal(stripTerminalSequences(reasoningDots(theme, "desconocido")), "○".repeat(6));
});

test("rectángulos: geometría exacta, Unicode, temas y fondo negro uniforme sin franjas", () => {
	for (const name of ["dark", "light"]) for (const mode of ["truecolor", "256color"] as const) {
		const base = getThemeByName(name)!;
		const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
		const theme = new Theme(colors, colors, mode, { appearance: name === "light" ? "light" : "dark" });
		for (const width of [0, 1, 2, 3, 4, 8, 20, 41, 60]) {
			const box = sidebarBox(theme, "Sesión 漢字🙂\x1b\n".repeat(4), [theme.fg("accent", "Modelo 漢字🙂".repeat(12)), "después\x1b[0mdel reset"], width);
			assert.equal(box.length, 4);
			for (const line of box) {
				assert.equal(visibleWidth(line), width); assert.doesNotMatch(stripTerminalSequences(line), /[\x00-\x1f]/);
				const row = sidebarSurface(theme, line, width);
				assert.equal(visibleWidth(row), width);
				const bg = backgroundAnsi(parseColor(name === "light" ? "#ffffff" : "#000000"), mode);
				for (let col = 0; col < width; col++) assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, col + 1)), bg);
				assert.equal(getActiveBackgroundAnsi(row), "");
			}
		}
		const plain = sidebarBox(theme, "Sesión", ["Modelo"], 41).map(stripTerminalSequences);
		assert.match(plain[0]!, /^┌─ Sesión ─+┐$/); assert.match(plain[1]!, /^│ Modelo +│$/); assert.match(plain[2]!, /^└─+┘$/);
	}
});
