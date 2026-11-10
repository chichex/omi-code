import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { backgroundAnsi, colorToHex, getOsc8LinkAtColumn, mixColors, parseColor, sliceByColumn, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getActiveBackgroundAnsi } from "../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { getThemeByName, Theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { field, modalEntry, notice, OmiCommandPalette, OmiInfoModal, section } from "../src/tui/workspace/modals.ts";
import { OmiModelPicker, type PickerResult } from "../src/tui/workspace/model-picker.ts";
import { MODAL_CONTENT_ROW, modalBodyRows, modalHeight, modalLines, modalSelection } from "../src/tui/workspace/presentation.ts";

function palette(name: "dark" | "light", mode: "truecolor" | "256color" = "truecolor"): Theme {
	const base = getThemeByName(name)!;
	const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
	return new Theme(colors, colors, mode, { appearance: name });
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const model: Model<Api> = { id: "gpt-6.1-sol", name: "Modelo 漢字 🙂", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 } };

for (const name of ["dark", "light"] as const) for (const mode of ["truecolor", "256color"] as const) {
	test(`workspace_modales: cabeceras, fondos y selección conservan el color por celda · ${name}/${mode}`, () => {
		const theme = palette(name, mode); const base = parseColor(name === "light" ? "#f3f4f5" : "#15191c");
		const tones = ["syntaxType", "mdLink", "success", "warning", "syntaxVariable"] as const;
		const headers = new Set<string>();
		for (const color of tones) {
			const bodyBg = backgroundAnsi(mixColors(base, theme.colors[color], .025), mode);
			const headerBg = backgroundAnsi(mixColors(base, theme.colors[color], .12), mode);
			const selectedBg = backgroundAnsi(mixColors(base, theme.colors.accent, .16), mode);
			const content = [modalEntry(theme, field("Rama", "feature", "syntaxType"), color),
				modalEntry(theme, field("Estado", "OPEN", "success"), color), modalSelection(theme, "› Seleccionado", 76), "antes\x1b[0mdespués\x1b[49mfin\x1b[m"];
			const lines = modalLines(theme, "Título 漢字 🙂", content, 80, { color, subtitle: "Sección · detalle" });
			assert.equal(lines.length, content.length + 7); assert.ok(lines.every((line) => visibleWidth(line) === 80));
			assert.ok(lines[0]!.includes(theme.getFgAnsi(color))); headers.add(theme.getFgAnsi(color));
			assert.ok(lines[1]!.includes("\x1b[1m"), "el título tiene negrita real");
			assert.ok(lines[MODAL_CONTENT_ROW]!.includes(theme.fg("syntaxType", "feature")));
			assert.ok(lines[MODAL_CONTENT_ROW + 1]!.includes(theme.fg("success", "OPEN")));
			for (const [row, line] of lines.entries()) {
				for (let column = 0; column < 80; column++) {
					const expected = row === 1 || row === 2 ? headerBg : row === MODAL_CONTENT_ROW + 2 && column >= 2 && column < 78 ? selectedBg : bodyBg;
					assert.equal(getActiveBackgroundAnsi(sliceByColumn(line, 0, column + 1)), expected, `${row}:${column}`);
				}
				assert.equal(getActiveBackgroundAnsi(line), "", "ninguna fila filtra el fondo al resto de la TUI");
			}
		}
		assert.ok(headers.size >= (mode === "truecolor" ? 5 : 4));
		for (const width of [0, 1, 2, 3, 4, 8, 20, 40, 80, 140]) {
			const lines = modalLines(theme, "Título 漢字 🙂\x1b\n".repeat(20), [theme.fg("error", "texto largo ".repeat(50))], width);
			assert.ok(lines.every((line) => visibleWidth(line) === width), `${width} columnas`);
			assert.doesNotMatch(plain(lines), /\x1b|\n\n/);
		}
	});
}

test("workspace_modales: contenido externo se sanea y sólo HTTP(S) sin credenciales genera enlaces", () => {
	const theme = palette("dark");
	for (const entry of ["\x1b[31mtexto\x07", field("Autor\n", "valor\x1b[2J"), notice("aviso\x1b]8;;file:///tmp/secreto\x07"), section("Sección\r\x1b")]) {
		const line = modalEntry(theme, entry, "accent");
		assert.doesNotMatch(line, /\x1b\[31m|\x1b\[2J|\x1b\]8|[\r\n\x07]/);
	}
	for (const url of ["file:///tmp/secreto", "javascript:alert(1)", "https://user:pass@example.test/a", "https://example.test/\x1b]8;;file:///tmp/a\x07", "https://"]) {
		assert.equal(getOsc8LinkAtColumn(modalEntry(theme, url, "accent"), 0), undefined, url);
	}
	const url = "https://github.com/chichex/omi-code/pull/21";
	const modal = new OmiInfoModal({ title: "PR", content: [url], theme: () => theme, rows: () => 40, redraw() {}, done() {} });
	const lines = modal.render(28);
	assert.equal(getOsc8LinkAtColumn(lines[MODAL_CONTENT_ROW]!, 2), url);
	assert.equal(getOsc8LinkAtColumn(lines[MODAL_CONTENT_ROW]!, 0), undefined, "el borde no es un enlace");
	assert.equal(getOsc8LinkAtColumn(lines.at(-1)!, 2), undefined, "el enlace se cierra antes del pie");
});

test("workspace_modales: scroll, rueda, Home/End y resize mantienen el pie visible y permiten leer todo", () => {
	let rows = 24; let theme = palette("dark"); let closed = 0;
	const modal = new OmiInfoModal({ title: "Detalle", subtitle: "Sólo lectura", content: Array.from({ length: 100 }, (_, i) => `Línea ${i} · 漢字 🙂 · ${"contenido ".repeat(5)}`),
		theme: () => theme, rows: () => rows, redraw() {}, done() { closed++; } });
	for (const height of [12, 16, 24, 40]) for (const width of [28, 40, 80, 104]) {
		rows = height; const lines = modal.render(width);
		assert.ok(lines.length <= modalHeight(rows), `${width}x${rows}`); assert.ok(lines.every((line) => visibleWidth(line) === width));
		assert.match(stripTerminalSequences(lines.at(-1)!), /└.*┘$/); assert.match(stripTerminalSequences(lines.at(-2)!), /Esc.*cerrar/);
	}
	rows = 24;
	const initial = modal.render(80); modal.handleInput("\x1b[6~"); assert.notEqual(plain(modal.render(80)), plain(initial));
	modal.handleInput("\x1b[F"); const end = plain(modal.render(80)); assert.match(end, /Línea 99/);
	modal.handleInput("\x1b[B"); assert.equal(plain(modal.render(80)), end, "no avanza fuera del contenido");
	modal.handleInput("\x1b[H"); assert.equal(plain(modal.render(80)), plain(initial));
	assert.deepEqual(modal.handleMouse({ type: "wheel", wheelDelta: 3 } as never), { handled: true });
	assert.notEqual(plain(modal.render(80)), plain(initial));
	modal.handleInput("\x1b[5~"); assert.equal(plain(modal.render(80)), plain(initial));
	theme = palette("light"); modal.invalidate(); const light = modal.render(80);
	assert.equal(plain(light), plain(initial)); assert.notEqual(light[1], initial[1], "el modal abierto usa el tema vigente");
	for (const key of ["\x1b", "\x03", "\r"]) modal.handleInput(key);
	assert.equal(closed, 3);
});

test("workspace_paleta: marco común, teclado y mouse conservan selección incluso entre press y click", () => {
	let rows = 16; let selected: string | undefined;
	const theme = palette("dark"); const items = Array.from({ length: 20 }, (_, i) => ({ value: `command-${i}`, label: `Comando ${i}` }));
	const modal = new OmiCommandPalette({ items, keys: { matches: () => false } as never, theme: () => theme, rows: () => rows, redraw() {}, done(value) { selected = value; } });
	let lines = modal.render(60); assert.ok(lines.length <= modalHeight(rows));
	modal.handleInput("\x1b[B"); lines = modal.render(60);
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes("Comando 4")); assert.ok(y >= MODAL_CONTENT_ROW);
	modal.handleMouse({ type: "press", button: "left", x: 4, y, width: 60 } as never);
	modal.render(60); // La lista centrada cambia de posición; el click sigue perteneciendo al item presionado.
	modal.handleMouse({ type: "click", button: "left", x: 4, y, width: 60 } as never);
	assert.equal(selected, "command-4");
	selected = undefined; modal.handleInput("\r"); assert.equal(selected, "command-4");
	for (const key of ["\x1b", "\x03"]) { modal.handleInput(key); assert.equal(selected, undefined); }
	rows = 40; lines = modal.render(80); assert.match(plain(lines), /▌ OMI · Comandos/);
	assert.equal(modal.handleMouse({ type: "click", button: "left", x: 0, y: MODAL_CONTENT_ROW, width: 80 } as never), undefined);
});

test("workspace_selector: lista y revisión caben, conservan colores y permiten leer la ficha sin perder los atajos", () => {
	let rows = 24; let result: PickerResult | undefined; let theme = palette("dark");
	const selection = () => result;
	const picker = new OmiModelPicker({ models: [model], current: model, thinking: "high", favorites: [], contextTokens: 1000, theme: () => theme, maxRows: () => rows, render() {}, done(value) { result = value; } });
	const assertFits = (component: Component, width: number) => {
		const lines = component.render(width); assert.ok(lines.length <= modalHeight(rows), `${width}x${rows}: ${lines.length}`);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
		assert.match(stripTerminalSequences(lines.at(-1)!), /└.*┘$/); return lines;
	};
	for (rows of [12, 16, 24, 40]) for (const width of [28, 40, 80, 112]) assertFits(picker, width);
	picker.handleInput("\r"); rows = 24;
	const first = assertFits(picker, 80); assert.match(plain(first.slice(-3)), /Enter aplicar/);
	picker.handleInput("\x1b[F"); const last = assertFits(picker, 80);
	assert.match(plain(last), /Misma conversación/); assert.notEqual(plain(first), plain(last));
	assert.equal(result, undefined, "el scroll no aplica el modelo");
	picker.handleMouse({ type: "wheel", wheelDelta: -1000 } as never); assert.equal(plain(assertFits(picker, 80)), plain(first));
	for (rows of [12, 16, 24, 40]) for (const width of [28, 40, 80, 112]) assertFits(picker, width);
	theme = palette("light"); picker.invalidate(); const light = assertFits(picker, 112); assert.ok(light[0]!.includes(theme.getFgAnsi("accent")));
	picker.handleInput("\r"); assert.equal(selection()?.choice?.model.id, model.id);
});

test("workspace_selector: contexto insuficiente tiene advertencia inmediata y nunca ofrece aplicar", () => {
	let result: PickerResult | undefined;
	const theme = palette("dark");
	const picker = new OmiModelPicker({ models: [model], thinking: "high", favorites: [], contextTokens: 300000, theme, maxRows: () => 24, render() {}, done(value) { result = value; } });
	picker.handleInput("\r");
	const lines = picker.render(80); assert.match(plain(lines), /Contexto insuficiente/); assert.match(plain(lines), /supera el límite/);
	assert.ok(lines[0]!.includes(theme.getFgAnsi("warning"))); assert.doesNotMatch(plain(lines.slice(-3)), /Enter aplicar/);
	picker.handleInput("\r"); assert.equal(result, undefined);
	assert.equal(modalBodyRows(24, 2), modalBodyRows(24) - 1);
});
