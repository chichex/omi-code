import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AUTO_WARNINGS, DEFAULT_POLICY, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { fakeTui, KEYS, typed } from "./helpers/questions.ts";

type Panel = Component & Focusable & { handleInput(data: string): void; dispose(): void };
function isPanel(value: unknown): value is Panel {
	return !!value && typeof value === "object" && "render" in value && typeof value.render === "function" && "handleInput" in value && typeof value.handleInput === "function" && "dispose" in value && typeof value.dispose === "function" && "focused" in value && typeof value.focused === "boolean" && "invalidate" in value && typeof value.invalidate === "function";
}
const block = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...STRICT_POLICY } });
/** Sin v2 vigente el panel parte del default que vale: todo auto. */
const fresh = (confirmar: string[] = []): FoundationsBlock => ({ ...block(confirmar), politica: { ...DEFAULT_POLICY } });
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
/** El panel abre en la primera política: tres filas abajo está Reglas de comandos y Enter abre su editor. */
const TO_RULES = [KEYS.down, KEYS.down, KEYS.down, KEYS.enter];
const legacy = { version: 1, repo: "test/repo", comandos: ["NO-HEREDAR"], politica: { arranque: "auto", receta: "auto", push_pr: "auto", fuera_de_catalogo: "auto" } };
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
	/** Texto corrido sin marco: los avisos largos se parten en varias filas. */
	const flat = () => lines().map((line) => stripTerminalSequences(line).replace(/^│ /, "").replace(/ │$/, "").trim()).join(" ").replace(/\s+/g, " ");
	const cursor = () => lines().some((line) => line.includes(CURSOR_MARKER));
	const press = (...keys: string[]) => { for (const key of keys) { panel.handleInput(key); lines(); } };
	return { panel, size, results, lines, screen, flat, cursor, press, setTheme: (appearance: "light" | "dark") => { theme = getThemeByName(appearance)!; panel.invalidate(); } };
}

test("foundations_panel: vertical, abre en las políticas con las reglas a la vista; Enter abre el editor y Esc vuelve", async () => {
	const f = await mount(block(["git push *", "npm publish"])); const screen = f.screen();
	assert.match(screen, /Foundations.*test\/repo/);
	const rows = screen.split("\n");
	const policies = ["arranque", "receta", "push"].map((word) => rows.findIndex((row) => row.toLowerCase().includes(word)));
	assert.ok(policies[0]! >= 0 && policies[1]! > policies[0]! && policies[2]! > policies[1]!);
	assert.match(screen, /git push \*/); assert.match(screen, /npm publish/);
	assert.match(screen, /Guardar/); assert.match(screen, /Cancelar/);
	assert.doesNotMatch(screen, /Escribir otra respuesta|Catálogo:|git push \* \| npm publish/);
	assert.ok(!f.cursor(), "abre en las políticas, no escribiendo reglas");
	f.press(...TO_RULES); assert.ok(f.cursor(), "Enter en Reglas lleva el foco al Editor de Pi");
	f.press(KEYS.esc); assert.ok(!f.cursor(), "Esc vuelve a la lista: la fila no conserva el cursor del editor");
	f.press(KEYS.enter); assert.ok(f.cursor()); f.press(KEYS.tab); assert.ok(!f.cursor(), "Tab también sale del editor");
	assert.deepEqual(f.results, [], "abrir y navegar no guardan"); f.panel.dispose(); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: legacy/ausente no precargan comandos, parten vacíos y con el default vigente (auto)", async () => {
	for (const initial of [undefined, legacy]) {
		const f = await mount(initial); const screen = f.screen();
		assert.doesNotMatch(screen, /NO-HEREDAR/); assert.doesNotMatch(screen, /\bv[12]\b|obsolet|hered/i, "sin hablar de versiones"); assert.equal((screen.match(/auto/g) ?? []).length >= 3, true);
		f.press("\x13"); assert.deepEqual(f.results, [], "revisar no guarda");
		assert.match(f.screen(), /ningún comando del proyecto pide confirmación/); f.press("\x13"); assert.deepEqual(f.results, [fresh()]);
	}
});
test("foundations_panel: precargar v2 no la presenta como aceptada; el diff usa sólo la aceptación explícita anterior", async () => {
	const initial = block(["git push *"]);
	const fresh = await mount(initial); fresh.screen(); fresh.press("\x13");
	assert.match(fresh.screen(), /Antes: sin Foundations \(por defecto: todo auto\)/); assert.doesNotMatch(fresh.screen(), /Antes: última revisión aceptada/);
	const accepted = await mount(initial, "dark", initial); accepted.screen(); accepted.press("\x13");
	assert.match(accepted.screen(), /Antes: última revisión aceptada/);
});
test("foundations_panel: Enter separa reglas, vacías se omiten; revisar/volver conserva borrador y políticas", async () => {
	const f = await mount();
	f.press(...TO_RULES, ...typed("git push *"), KEYS.enter, KEYS.enter, ...typed("npm publish"));
	f.press(KEYS.esc, KEYS.up, KEYS.up, KEYS.up, KEYS.space); // editor -> reglas -> push -> receta -> arranque
	f.press("\x13"); assert.deepEqual(f.results, []);
	const review = f.screen(); assert.match(review, /Revis|Guardar/); assert.match(review, /git push \*/);
	f.press(KEYS.esc); assert.match(f.screen(), /npm publish/);
	f.press("\x13", "\x13");
	assert.deepEqual(f.results, [{ ...block(["git push *", "npm publish"]), politica: { ...DEFAULT_POLICY, arranque: "ask" } }]);
});
test("foundations_panel: errores por línea no recortan ni pierden borrador; se corrige sin reiniciar", async () => {
	const f = await mount(); f.press(...TO_RULES, paste("git push *\n\n npm test"), "\x13");
	assert.match(f.screen(), /Línea 3|Regla 3/); assert.match(f.screen(), /espacios|borde/); assert.deepEqual(f.results, []);
	f.press("\x01", "\x1b[3~"); // Home lógico y Delete: quitar sólo el espacio inválido
	f.press("\x13", "\x13"); assert.deepEqual(f.results, [fresh(["git push *", "npm test"])]);
});
test("foundations_panel: un pegado con invisibles/tabs no se normaliza para convertirse en regla válida", async () => {
	for (const invisible of ["\t", "\u202e", "\u{E0100}"]) {
		const f = await mount(block(["git push *"])); f.press(...TO_RULES, paste(`echo a${invisible}b`));
		const screen = f.screen(); assert.ok(!screen.includes(invisible)); assert.match(screen, /\\u|\\t|invisible|control/i);
		assert.deepEqual(f.results, []); assert.match(screen, /git push \*/); f.press(KEYS.esc, KEYS.esc); assert.deepEqual(f.results, [undefined]);
	}
});
test("foundations_panel: un pegado largo sigue visible/editable, no marcador paste; wrap y scroll no truncan el valor guardado", async () => {
	const rule = `BEGIN-${"x".repeat(1700)}-FIN`;
	const f = await mount(); f.press(...TO_RULES, paste(rule)); assert.doesNotMatch(f.screen(), /\[paste #/);
	f.press("\x01"); assert.match(f.screen(), /BEGIN-/);
	f.press("\x05"); assert.match(f.screen(), /-FIN/);
	f.press("\x13", "\x13"); assert.deepEqual(f.results, [fresh([rule])]);
});
for (const appearance of ["dark", "light"] as const) test(`foundations_panel: límites de 80x24, resize 132x40 y tema dinámico ${appearance}`, async () => {
	const f = await mount(block(Array.from({ length: 100 }, (_, index) => `command${index} ${"x".repeat(120)}`)), appearance);
	for (const [index, [width, height]] of [[80, 24], [132, 40], [80, 24]].entries()) {
		f.size.columns = width!; f.size.rows = height!; f.panel.invalidate();
		assert.ok(f.lines().length <= height! - 2); assert.ok(f.lines().every((line) => visibleWidth(line) <= width!));
		assert.match(f.screen(), /Guardar/); assert.match(f.screen(), /Cancelar/);
		f.press(...(index === 0 ? TO_RULES : [KEYS.enter])); assert.ok(f.cursor(), "el editor de reglas también entra");
		assert.ok(f.lines().length <= height! - 2); assert.ok(f.lines().every((line) => visibleWidth(line) <= width!));
		f.press(KEYS.esc);
		const before = f.lines().join("\n"); f.setTheme(appearance === "light" ? "dark" : "light"); const after = f.lines().join("\n");
		assert.notEqual(before, after); f.setTheme(appearance);
		f.press(KEYS.pageUp, KEYS.pageDown); assert.deepEqual(f.results, []);
	}
	f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
for (const [text, expected] of [["git push *\n\ngit push *", /Línea 3|Regla 3/], [String.raw`echo \x`, /escape/i], ["x".repeat(2001), /2000/], [Array.from({ length: 101 }, (_, index) => `cmd${index}`).join("\n"), /100/], ["   ", /borde|espacios/]] as const) test("foundations_panel: valida sin deduplicar, recortar, aceptar escapes desconocidos ni perder líneas inválidas", async () => {
	const f = await mount(); f.press(...TO_RULES, paste(text), "\x13");
	assert.match(f.screen(), expected); assert.deepEqual(f.results, []); f.press(KEYS.ctrlC); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: pegado multilínea partido en chunks conserva texto y espacios exactos", async () => {
	const f = await mount(); f.press(...TO_RULES, "\x1b[200~git  push", " *\n\nnpm publish", "\x1b[201~", "\x13", "\x13");
	assert.deepEqual(f.results, [fresh(["git  push *", "npm publish"])]);
});
test("foundations_panel: revisión muestra íntegros los avisos de todas las políticas auto sin elegir ni guardar por navegar", async () => {
	const f = await mount(block()); f.press(KEYS.space, KEYS.down, KEYS.space, KEYS.down, KEYS.space, "\x13");
	const screens: string[] = [];
	for (let page = 0; page < 30; page++) { const next = f.screen(); if (screens.at(-1) === next) break; screens.push(next); f.press(KEYS.pageDown); }
	const inspected = screens.flatMap((screen) => screen.split("\n").map((line) => line.replace(/^│ /, "").replace(/ │$/, "").trimEnd())).join(" ").replace(/\s+/g, " ");
	for (const point of ["arranque", "receta", "push_pr"] as const) assert.ok(inspected.includes(AUTO_WARNINGS[point]), `aviso de ${point}`);
	assert.deepEqual(f.results, []); f.press(KEYS.esc); f.press(KEYS.esc); assert.deepEqual(f.results, [undefined]);
});
test("foundations_panel: review de reglas largas preserva espacios con marcadores de continuación literal", async () => {
	const rule = `cmd${" ".repeat(82)}TAIL`; const f = await mount(block([rule])); f.screen(); f.press("\x13");
	const chunks = f.screen().split("\n").filter((line) => /^│ [│↳] /.test(line)).map((line) => line.slice(2, -2));
	assert.equal(chunks.length, 2, "se recorren ambos tramos de la regla, no la leyenda del pie");
	const literal = chunks.map((line, index) => index === chunks.length - 1 ? line.slice(2).trimEnd() : line.slice(2)).join("");
	assert.equal(literal, `  + ${rule}`, "la revisión muestra el literal completo, incluidos los 82 espacios y TAIL");
	assert.deepEqual(f.results, []);
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

test("foundations_panel: ↑↓ y Tab recorren filas sin escribir reglas; Espacio y ←→ cambian sólo la política enfocada", async () => {
	const f = await mount(block());
	f.press(...typed("jk"), KEYS.down, KEYS.space, KEYS.tab, KEYS.right, KEYS.shiftTab, KEYS.up, KEYS.left);
	assert.ok(!f.cursor()); assert.doesNotMatch(f.screen(), /jk/);
	f.press("\x13", "\x13");
	assert.deepEqual(f.results, [{ ...block(), politica: { arranque: "ask", receta: "auto", push_pr: "auto" } }]);
});
test("foundations_panel: cada política ocupa una fila corta; la explicación es sólo de la fila enfocada", async () => {
	const f = await mount(fresh());
	const policyRows = f.screen().split("\n").filter((row) => /arranque|receta|push \+ pr draft/i.test(row));
	assert.ok(policyRows.every((row) => !row.includes(AUTO_WARNINGS.arranque.slice(0, 20)) && !row.includes(AUTO_WARNINGS.receta.slice(0, 20))), "la fila no arrastra el aviso");
	assert.ok(f.flat().includes(AUTO_WARNINGS.arranque)); assert.ok(!f.flat().includes(AUTO_WARNINGS.receta));
	f.press(KEYS.down); assert.ok(f.flat().includes(AUTO_WARNINGS.receta)); assert.ok(!f.flat().includes(AUTO_WARNINGS.arranque));
	f.press(KEYS.down, KEYS.down); assert.match(f.flat(), /piden tu sí antes de correr/);
});
test("foundations_panel: el editor de reglas explica qué poner, con ejemplos, y qué pasa si queda vacío", async () => {
	const f = await mount(); f.press(...TO_RULES); const text = f.flat();
	assert.match(text, /git push \*/); assert.match(text, /gh pr merge \*/);
	assert.match(text, /\* cualquier texto/); assert.match(text, /compuestos/i);
	assert.match(text, /Vacía: ningún comando simple pide confirmación/);
	assert.match(text, /Esc volver/); assert.deepEqual(f.results, []);
});
test("foundations_panel: pegar desde la lista abre el editor de reglas y conserva el texto exacto", async () => {
	const f = await mount(); f.press(paste("git push *")); assert.ok(f.cursor());
	f.press("\x13", "\x13"); assert.deepEqual(f.results, [fresh(["git push *"])]);
});
test("foundations_panel: una lista larga se resume en la fila de reglas", async () => {
	const f = await mount(block(Array.from({ length: 12 }, (_, index) => `cmd${index}`)));
	assert.match(f.screen(), /12 reglas/); assert.match(f.screen(), /cmd0/); assert.match(f.screen(), /y 9 más/); assert.doesNotMatch(f.screen(), /cmd11/);
});
