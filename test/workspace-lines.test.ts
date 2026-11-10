import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { changedFileLine } from "../src/tui/workspace/presentation.ts";

const theme = getThemeByName("dark")!;

test("workspace_contadores por archivo: verde/rojo también en la fila seleccionada", () => {
	for (const selected of [false, true]) {
		const line = changedFileLine(theme, { status: "MM", path: "src/file.ts", lines: { added: 12, removed: 4 } }, 80, selected);
		assert.ok(line.includes(theme.fg("success", "+12")));
		assert.ok(line.includes(theme.fg("error", "−4")));
		assert.match(stripTerminalSequences(line), /MM src\/file.ts\s+\+12 −4$/);
		assert.equal(visibleWidth(line), 80);
	}
});

test("workspace_contadores se conservan a la derecha al truncar rutas y no desbordan panes angostos", () => {
	const file = { status: " M", path: "src/漢字/🙂/" + "nested/".repeat(25) + "file.ts", lines: { added: 123, removed: 45 } };
	for (const width of [0, 1, 3, 8, 12, 20, 28, 40, 80, 132]) {
		const line = changedFileLine(theme, file, width, true); const plain = stripTerminalSequences(line);
		assert.ok(visibleWidth(line) <= width, `width=${width}`);
		if (width >= 12) { assert.ok(plain.endsWith("+123 −45")); assert.match(plain, /…/); }
	}
});

test("workspace_binarios, nuevos y estadísticas no disponibles no se presentan como cero", () => {
	for (const [file, expected] of [
		[{ status: "??", path: ".env" }, /nuevo$/],
		[{ status: " M", path: "binary.dat", lines: "binary" as const }, /binario$/],
		[{ status: " M", path: "unavailable.ts" }, /—$/],
	] as const) {
		const plain = stripTerminalSequences(changedFileLine(theme, file, 60));
		assert.match(plain, expected); assert.doesNotMatch(plain, /\+0|−0/);
	}
	const plain = stripTerminalSequences(changedFileLine(theme, { status: "R ", path: "renamed.ts", lines: { added: 0, removed: 0 } }, 60));
	assert.match(plain, /\+0 −0$/);
});
