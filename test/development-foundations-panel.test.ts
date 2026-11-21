import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AUTO_WARNINGS, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { fakeTui, KEYS, typed } from "./helpers/questions.ts";

type Panel = Component & Focusable & { handleInput(data: string): void; dispose(): void };
function isPanel(value: unknown): value is Panel {
	return !!value && typeof value === "object" && "render" in value && typeof value.render === "function" && "handleInput" in value && typeof value.handleInput === "function" && "dispose" in value && typeof value.dispose === "function" && "focused" in value && typeof value.focused === "boolean" && "invalidate" in value && typeof value.invalidate === "function";
}
const block = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...STRICT_POLICY } });
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
async function mount(initial: unknown = undefined, appearance: "light" | "dark" = "dark", previousAccepted?: unknown) {
	// El rojo por capacidad ausente es un assert explícito, no un fallo del comando o del loader de tests.
	const url = new URL("../src/tui/development-foundations-panel.ts", import.meta.url);
	assert.ok(existsSync(url), "falta el panel dedicado Foundations");
	const loaded: unknown = await import(url.href);
	assert.ok(loaded && typeof loaded === "object" && "FoundationsPanel" in loaded, "falta el panel dedicado Foundations");
	const constructor: unknown = Reflect.get(loaded, "FoundationsPanel"); assert.ok(typeof constructor === "function");
	const size = { columns: 80, rows: 24 }; let theme = getThemeByName(appearance)!;
	const results: (FoundationsBlock | undefined)[] = [];
	const panel: unknown = Reflect.construct(constructor, [{ repo: "test/repo", initial, previousAccepted, product: "repo", kbUrl: "https://kb.test/mcp", tui: fakeTui(size), theme: () => theme, rows: () => size.rows, done: (value: FoundationsBlock | undefined) => results.push(value) }]);
	assert.ok(isPanel(panel)); panel.focused = true;
	const lines = () => panel.render(size.columns);
	const screen = () => lines().map(stripTerminalSequences).join("\n");
	const press = (...keys: string[]) => { for (const key of keys) { panel.handleInput(key); lines(); } };
	return { panel, size, results, lines, screen, press, setTheme: (appearance: "light" | "dark") => { theme = getThemeByName(appearance)!; panel.invalidate(); } };
}

test("foundations_panel: vertical con v2 precargado, editor integrado/foco y acciones visibles, no wizard", async () => {
	const f = await mount(block(["git push *", "npm publish"])); const screen = f.screen();
	assert.match(screen, /Foundations.*test\/repo/);
	const rows = screen.split("\n");
	const policies = ["arranque", "receta", "push"].map((word) => rows.findIndex((row) => row.toLowerCase().includes(word)));
	assert.ok(policies[0]! >= 0 && policies[1]! > policies[0]! && policies[2]! > policies[1]!);
	assert.match(screen, /git push \*/); assert.match(screen, /npm publish/);
	assert.match(screen, /Guardar/); assert.match(screen, /Cancelar/);
	assert.doesNotMatch(screen, /Escribir otra respuesta|Catálogo:|git push \* \| npm publish/);
	assert.ok(f.lines().some((line) => line.includes(CURSOR_MARKER)), "el foco llega al Editor de Pi");
	f.press(KEYS.tab); assert.ok(!f.lines().some((line) => line.includes(CURSOR_MARKER)), "el botón no conserva cursor del editor");
	assert.deepEqual(f.results, [], "abrir y navegar no guardan"); f.panel.dispose(); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: legacy/ausente no precargan comandos ni auto, parten vacíos y ask", async () => {
	for (const initial of [undefined, { version: 1, repo: "test/repo", comandos: ["NO-HEREDAR"], politica: { arranque: "auto", receta: "auto", push_pr: "auto", fuera_de_catalogo: "auto" } }]) {
		const f = await mount(initial); const screen = f.screen();
		assert.doesNotMatch(screen, /NO-HEREDAR/); assert.equal((screen.match(/ask/g) ?? []).length >= 3, true);
		f.press("\x13"); assert.deepEqual(f.results, [], "revisar no guarda");
		assert.match(f.screen(), /SIMPLE/); f.press("\x13"); assert.deepEqual(f.results, [block()]);
	}
});
test("foundations_panel: precargar v2 no la presenta como aceptada; el diff usa sólo la aceptación explícita anterior", async () => {
	const initial = block(["git push *"]);
	const fresh = await mount(initial); fresh.screen(); fresh.press("\x13");
	assert.match(fresh.screen(), /Antes: política estricta/); assert.doesNotMatch(fresh.screen(), /Antes: última revisión aceptada/);
	const accepted = await mount(initial, "dark", initial); accepted.screen(); accepted.press("\x13");
	assert.match(accepted.screen(), /Antes: última revisión aceptada/);
});
test("foundations_panel: Enter separa reglas, vacías se omiten; revisar/volver conserva borrador y políticas", async () => {
	const f = await mount();
	f.press(...typed("git push *"), KEYS.enter, KEYS.enter, ...typed("npm publish"));
	f.press(KEYS.shiftTab, KEYS.shiftTab, KEYS.shiftTab, KEYS.space); // editor -> push -> receta -> arranque
	f.press("\x13"); assert.deepEqual(f.results, []);
	const review = f.screen(); assert.match(review, /Revis|Guardar/); assert.match(review, /git push \*/);
	f.press(KEYS.esc); assert.match(f.screen(), /npm publish/);
	f.press("\x13", "\x13");
	assert.deepEqual(f.results, [{ ...block(["git push *", "npm publish"]), politica: { ...STRICT_POLICY, arranque: "auto" } }]);
});
test("foundations_panel: errores por línea no recortan ni pierden borrador; se corrige sin reiniciar", async () => {
	const f = await mount(); f.press(paste("git push *\n\n npm test"), "\x13");
	assert.match(f.screen(), /Línea 3|Regla 3/); assert.match(f.screen(), /espacios|borde/); assert.deepEqual(f.results, []);
	f.press("\x01", "\x1b[3~"); // Home lógico y Delete: quitar sólo el espacio inválido
	f.press("\x13", "\x13"); assert.deepEqual(f.results, [block(["git push *", "npm test"])]);
});
test("foundations_panel: un pegado con invisibles/tabs no se normaliza para convertirse en regla válida", async () => {
	for (const invisible of ["\t", "\u202e", "\u{E0100}"]) {
		const f = await mount(block(["git push *"])); f.press(paste(`echo a${invisible}b`));
		const screen = f.screen(); assert.ok(!screen.includes(invisible)); assert.match(screen, /\\u|\\t|invisible|control/i);
		assert.deepEqual(f.results, []); assert.match(screen, /git push \*/); f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
	}
});
test("foundations_panel: un pegado largo sigue visible/editable, no marcador paste; wrap y scroll no truncan el valor guardado", async () => {
	const rule = `BEGIN-${"x".repeat(1700)}-FIN`;
	const f = await mount(); f.press(paste(rule)); assert.doesNotMatch(f.screen(), /\[paste #/);
	f.press("\x01"); assert.match(f.screen(), /BEGIN-/);
	f.press("\x05"); assert.match(f.screen(), /-FIN/);
	f.press("\x13", "\x13"); assert.deepEqual(f.results, [block([rule])]);
});
for (const appearance of ["dark", "light"] as const) test(`foundations_panel: límites de 80x24, resize 132x40 y tema dinámico ${appearance}`, async () => {
	const f = await mount(block(Array.from({ length: 100 }, (_, index) => `command${index} ${"x".repeat(120)}`)), appearance);
	for (const [width, height] of [[80, 24], [132, 40], [80, 24]]) {
		f.size.columns = width!; f.size.rows = height!; f.panel.invalidate();
		assert.ok(f.lines().length <= height! - 2); assert.ok(f.lines().every((line) => visibleWidth(line) <= width!));
		assert.match(f.screen(), /Guardar/); assert.match(f.screen(), /Cancelar/);
		const before = f.lines().join("\n"); f.setTheme(appearance === "light" ? "dark" : "light"); const after = f.lines().join("\n");
		assert.notEqual(before, after); f.setTheme(appearance);
		f.press(KEYS.pageUp, KEYS.pageDown); assert.deepEqual(f.results, []);
	}
	f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
for (const [text, expected] of [["git push *\n\ngit push *", /Línea 3|Regla 3/], [String.raw`echo \x`, /escape/i], ["x".repeat(2001), /2000/], [Array.from({ length: 101 }, (_, index) => `cmd${index}`).join("\n"), /100/], ["   ", /borde|espacios/]] as const) test("foundations_panel: valida sin deduplicar, recortar, aceptar escapes desconocidos ni perder líneas inválidas", async () => {
	const f = await mount(); f.press(paste(text), "\x13");
	assert.match(f.screen(), expected); assert.deepEqual(f.results, []); f.press(KEYS.ctrlC); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: pegado multilínea partido en chunks conserva texto y espacios exactos", async () => {
	const f = await mount(); f.press("\x1b[200~git  push", " *\n\nnpm publish", "\x1b[201~", "\x13", "\x13");
	assert.deepEqual(f.results, [block(["git  push *", "npm publish"])]);
});
test("foundations_panel: revisión muestra íntegros los avisos de todas las políticas auto sin elegir ni guardar por navegar", async () => {
	const f = await mount(); f.press(KEYS.shiftTab, KEYS.shiftTab, KEYS.shiftTab, KEYS.space, KEYS.tab, KEYS.space, KEYS.tab, KEYS.space, "\x13");
	const screens: string[] = [];
	for (let page = 0; page < 30; page++) { const next = f.screen(); if (screens.at(-1) === next) break; screens.push(next); f.press(KEYS.pageDown); }
	const inspected = screens.flatMap((screen) => screen.split("\n").map((line) => line.replace(/^│ /, "").replace(/ │$/, "").trimEnd())).join(" ").replace(/\s+/g, " ");
	for (const point of ["arranque", "receta", "push_pr"] as const) assert.ok(inspected.includes(AUTO_WARNINGS[point]), `aviso de ${point}`);
	assert.deepEqual(f.results, []); f.press(KEYS.esc); f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: review de reglas largas preserva espacios con marcadores de continuación literal", async () => {
	const f = await mount(block([`cmd${" ".repeat(82)}TAIL`])); f.screen(); f.press("\x13");
	assert.match(f.screen(), /^│ ↳/m); assert.deepEqual(f.results, []);
	f.press(KEYS.esc, KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: achicar a un pane no inspeccionable bloquea Guardar pero permite cancelar", async () => {
	const f = await mount(); f.screen(); f.size.columns = 30; f.size.rows = 12; f.panel.invalidate(); f.screen();
	f.press("\x13", "\x13"); assert.deepEqual(f.results, []); f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: el ancho real del componente también impide guardar aunque la terminal física sea amplia", async () => {
	const f = await mount();
	for (const key of ["\x13", "\x13"]) { f.panel.render(30); f.panel.handleInput(key); }
	assert.deepEqual(f.results, []); f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: Esc/CtrlC/dispose son cancelación idempotente, nunca grant ni guardado", async () => {
	for (const key of [KEYS.esc, KEYS.ctrlC]) {
		const f = await mount(block(["git push *"])); f.press(key, "\x13"); f.panel.dispose();
		assert.deepEqual(f.results, [undefined]);
	}
});
