import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { colorToHex, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName, Theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { agentDir } from "../src/core/paths.ts";
import { loadWorkspacePreferences, saveWorkspacePreferences, SIDEBAR_SECTIONS, type SidebarSectionId } from "../src/tui/workspace/preferences.ts";
import { OmiSidebarSettings } from "../src/tui/workspace/sidebar-settings.ts";
import { MODAL_CONTENT_ROW, modalHeight } from "../src/tui/workspace/presentation.ts";
import { tempDir } from "./helpers/io.ts";

const defaults = { favorites: [], sidebar: true };
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
function palette(name: "dark" | "light", mode: "truecolor" | "256color" = "truecolor"): Theme {
	const base = getThemeByName(name)!;
	const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
	return new Theme(colors, colors, mode, { appearance: name });
}
function settings(hiddenSections: readonly SidebarSectionId[] = []) {
	let theme = palette("dark"); let rows = 24; let redraws = 0;
	const completed: (SidebarSectionId[] | undefined)[] = [];
	const modal = new OmiSidebarSettings({ hiddenSections, theme: () => theme, rows: () => rows, redraw: () => { redraws++; }, done: (hidden) => completed.push(hidden) });
	return { modal, completed, redraws: () => redraws, setRows: (value: number) => { rows = value; }, setTheme: (value: Theme) => { theme = value; } };
}

test("workspace_preferencias: catálogo de secciones estable y ordenado", () => {
	assert.deepEqual(SIDEBAR_SECTIONS, [{ id: "workspace", label: "Proyecto" }, { id: "session", label: "Sesión" },
		{ id: "actions", label: "GitHub Actions" }, { id: "omi", label: "OMI" }, { id: "subagents", label: "Subagentes" },
		{ id: "resources", label: "Recursos" }, { id: "issue", label: "Issue activo" }]);
});

test("workspace_preferencias: defaults y formato anterior no agregan hiddenSections", async (t) => {
	const home = await tempDir(t);
	assert.deepEqual(await loadWorkspacePreferences(home), defaults);
	await saveWorkspacePreferences(home, { favorites: ["provider/model"], sidebar: false });
	assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["provider/model"], sidebar: false });
	assert.deepEqual(JSON.parse(await readFile(join(agentDir(home), "workspace-ui.json"), "utf8")), { favorites: ["provider/model"], sidebar: false });
});

test("workspace_preferencias: whitelist y dedup no ejecutan ni conservan secciones maliciosas", async (t) => {
	const home = await tempDir(t); const directory = agentDir(home); await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "workspace-ui.json"), JSON.stringify({ favorites: ["provider/model", null, 4, "x".repeat(512)], sidebar: false,
		hiddenSections: ["resources", "__proto__", "resources", "session", "constructor", null, false, {}, "../omi", "\x1b[2J", "WORKSPACE", "issue"], unknown: "ignored" }));
	assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["provider/model"], sidebar: false, hiddenSections: ["resources", "session", "issue"] });
	await writeFile(join(directory, "workspace-ui.json"), '{"__proto__":{"hiddenSections":["omi"]},"favorites":[],"sidebar":true}');
	assert.deepEqual(await loadWorkspacePreferences(home), defaults);
});

test("workspace_preferencias: archivos corruptos y hiddenSections con tipo incorrecto fallan a visible", async (t) => {
	const home = await tempDir(t); const directory = agentDir(home); await mkdir(directory, { recursive: true });
	for (const input of ["", "{", "null", "false", "42", '"text"', "[]", '{"hiddenSections":"omi"}', '{"hiddenSections":null}', '{"hiddenSections":{}}']) {
		await writeFile(join(directory, "workspace-ui.json"), input);
		assert.deepEqual(await loadWorkspacePreferences(home), defaults, input);
	}
	await writeFile(join(directory, "workspace-ui.json"), '{"hiddenSections":[],"sidebar":"false"}');
	assert.deepEqual(await loadWorkspacePreferences(home), { ...defaults, hiddenSections: [] });
	await writeFile(join(directory, "workspace-ui.json"), JSON.stringify({ favorites: Array.from({ length: 1100 }, (_, i) => `p/${i}`) }));
	assert.equal((await loadWorkspacePreferences(home)).favorites.length, 1000, "conserva el límite previo de favoritos");
});

test("workspace_preferencias: guardar sanea hiddenSections sin mutar el valor original", async (t) => {
	const home = await tempDir(t);
	const preferences = { favorites: ["provider/model"], sidebar: true, hiddenSections: ["issue", "issue", "omi"] satisfies SidebarSectionId[] };
	await saveWorkspacePreferences(home, preferences);
	assert.deepEqual(preferences.hiddenSections, ["issue", "issue", "omi"]);
	assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["provider/model"], sidebar: true, hiddenSections: ["issue", "omi"] });
	// La frontera de persistencia también valida callers JavaScript o datos externos asignados en runtime.
	Object.assign(preferences, { hiddenSections: ["omi", "../../outside", "__proto__", "omi", null] });
	await saveWorkspacePreferences(home, preferences);
	assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["provider/model"], sidebar: true, hiddenSections: ["omi"] });
});

test("workspace_preferencias: usa sólo agentDir, escritura privada y reemplazo atómico", async (t) => {
	const home = await tempDir(t); const foreign = join(home, ".pi", "agent"); await mkdir(foreign, { recursive: true });
	const foreignPath = join(foreign, "workspace-ui.json"); const foreignValue = '{"sidebar":false,"hiddenSections":["workspace"]}';
	await writeFile(foreignPath, foreignValue);
	assert.deepEqual(await loadWorkspacePreferences(home), defaults, "no lee preferencias de Pi");
	await saveWorkspacePreferences(home, { favorites: ["old/model"], sidebar: true });
	const directory = agentDir(home); const path = join(directory, "workspace-ui.json");
	await chmod(path, 0o644);
	const next = { favorites: ["next/model"], sidebar: false, hiddenSections: ["actions"] satisfies SidebarSectionId[] };
	await saveWorkspacePreferences(home, next);
	assert.deepEqual(await loadWorkspacePreferences(home), next);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(directory), ["workspace-ui.json"], "no deja temporales");
	assert.equal(await readFile(foreignPath, "utf8"), foreignValue, "no escribe en Pi");
});

test("workspace_preferencias: reemplazar un symlink no escribe en su destino externo", async (t) => {
	const home = await tempDir(t); const outside = join(home, "outside.json"); const value = '{"sidebar":false}';
	await writeFile(outside, value); const directory = agentDir(home); await mkdir(directory, { recursive: true });
	await symlink(outside, join(directory, "workspace-ui.json"));
	await saveWorkspacePreferences(home, { favorites: [], sidebar: true, hiddenSections: ["omi"] });
	assert.equal(await readFile(outside, "utf8"), value);
	assert.deepEqual(await loadWorkspacePreferences(home), { ...defaults, hiddenSections: ["omi"] });
});

test("workspace_preferencias: falla de rename propaga error y limpia temporal", async (t) => {
	const home = await tempDir(t); const directory = agentDir(home); await mkdir(join(directory, "workspace-ui.json"), { recursive: true });
	await assert.rejects(saveWorkspacePreferences(home, defaults));
	assert.deepEqual(await readdir(directory), ["workspace-ui.json"]);
	assert.deepEqual(await loadWorkspacePreferences(home), defaults, "un directorio tampoco impide arrancar");
});

test("workspace_lateral_settings: checkbox visible, Space y Enter alternan sin cerrar; Ctrl+S aplica", () => {
	const hidden: SidebarSectionId[] = ["resources"]; const { modal, completed, redraws } = settings(hidden);
	assert.equal(modal.capturesViewportInput, true);
	let lines = modal.render(90); assert.match(plain(lines), /▌ Personalizar lateral/);
	assert.match(plain(lines), /\[x\] Proyecto/); assert.match(plain(lines), /\[ \] Recursos/);
	assert.match(plain(lines.slice(-4)), /Ctrl\+S guardar.*Esc cancelar/);
	assert.match(plain(lines.slice(-4)), /r Restablecer todo visible/);
	modal.handleInput(" "); lines = modal.render(90); assert.match(plain(lines), /\[ \] Proyecto/);
	modal.handleInput("\r"); assert.match(plain(modal.render(90)), /\[x\] Proyecto/);
	modal.handleInput("\x1b[B"); modal.handleInput("\r");
	assert.deepEqual(completed, [], "Enter nunca aplica ni cierra");
	modal.handleInput("\x13"); assert.deepEqual(completed, [["session", "resources"]]);
	assert.deepEqual(hidden, ["resources"], "el borrador no muta las preferencias recibidas");
	assert.ok(redraws() >= 3);
});

test("workspace_lateral_settings: Esc y Ctrl+C cancelan el borrador; restablecer no guarda hasta Ctrl+S", () => {
	for (const key of ["\x1b", "\x03"]) {
		const { modal, completed } = settings(["omi"]); modal.render(80); modal.handleInput(" "); modal.handleInput(key);
		assert.deepEqual(completed, [undefined]);
	}
	const { modal, completed } = settings(SIDEBAR_SECTIONS.map(({ id }) => id));
	modal.render(90); modal.handleInput("r"); const lines = plain(modal.render(90));
	assert.equal((lines.match(/\[x\]/g) ?? []).length, SIDEBAR_SECTIONS.length);
	assert.deepEqual(completed, []); modal.handleInput("\x13"); assert.deepEqual(completed, [[]]);
});

test("workspace_lateral_settings: mouse alterna una sola vez y conserva el item entre press, render y click", () => {
	const { modal, completed } = settings(); modal.render(80);
	const mouse = (type: "click" | "press", x: number, y: number, button = "left") => modal.handleMouse({ type, button, x, y, width: 80, height: 20 } as never);
	const y = MODAL_CONTENT_ROW + 3;
	assert.deepEqual(mouse("press", 4, y), { handled: true, focus: true });
	assert.match(plain(modal.render(80)), /\[x\] OMI/, "press sólo enfoca");
	assert.ok(mouse("click", 4, y)?.handled); assert.match(plain(modal.render(80)), /\[ \] OMI/);
	for (const [x, row, button] of [[0, y, "left"], [79, y, "left"], [4, 0, "left"], [4, 19, "left"], [4, y, "right"]] as const) {
		assert.equal(mouse("click", x, row, button), undefined);
	}
	assert.deepEqual(completed, []); modal.handleInput("\x13"); assert.deepEqual(completed, [["omi"]]);
});

test("workspace_lateral_settings: mouse conserva el item presionado aunque la lista se recentre", () => {
	const { modal, completed, setRows } = settings(); setRows(16);
	const before = modal.render(80); const y = before.findIndex((line) => stripTerminalSequences(line).includes("Subagentes"));
	assert.ok(y >= MODAL_CONTENT_ROW);
	const event = { button: "left", x: 4, y, width: 80, height: 14 };
	modal.handleMouse({ ...event, type: "press" } as never);
	const after = modal.render(80); assert.notEqual(plain(after), plain(before));
	modal.handleMouse({ ...event, type: "click" } as never);
	modal.handleInput("\x13"); assert.deepEqual(completed, [["subagents"]]);
});

test("workspace_lateral_settings: PageUp/Down y Home/End navegan sin alternar ni cerrar", () => {
	const { modal, completed, setRows } = settings(); setRows(16); modal.render(80);
	modal.handleInput("\x1b[F"); assert.match(plain(modal.render(80)), /→ \[x\] Issue activo/);
	modal.handleInput("\x1b[5~"); assert.doesNotMatch(plain(modal.render(80)), /→ \[x\] Issue activo/);
	modal.handleInput("\x1b[6~"); assert.match(plain(modal.render(80)), /→ \[x\] Issue activo/);
	modal.handleInput("\x1b[H"); assert.match(plain(modal.render(80)), /→ \[x\] Proyecto/);
	assert.deepEqual(completed, []); modal.handleInput("\x13"); assert.deepEqual(completed, [[]]);
});

test("workspace_lateral_settings: rueda navega sin alternar; foco y sección sobreviven scroll, resize y cambio de tema", () => {
	const fixture = settings(); const { modal, completed } = fixture; fixture.setRows(12);
	const first = plain(modal.render(40));
	modal.handleMouse({ type: "wheel", wheelDelta: 1 } as never);
	assert.notEqual(plain(modal.render(40)), first);
	modal.handleInput(" ");
	fixture.setRows(40); fixture.setTheme(palette("light")); modal.invalidate();
	const lines = plain(modal.render(80)); assert.match(lines, /→ \[ \] Sesión/);
	modal.handleMouse({ type: "wheel", wheelDelta: -1 } as never);
	assert.match(plain(modal.render(80)), /→ \[x\] Proyecto/);
	modal.handleInput("\x13"); assert.deepEqual(completed, [["session"]]);
});

test("workspace_lateral_settings: una lista corta sigue permitiendo alcanzar todas las secciones", () => {
	const { modal, completed, setRows } = settings(); setRows(12); modal.render(40);
	for (const section of SIDEBAR_SECTIONS) {
		assert.match(plain(modal.render(40)), new RegExp(section.label)); modal.handleInput(" "); modal.handleInput("\x1b[B");
	}
	modal.handleInput("\x13"); assert.deepEqual(completed, [SIDEBAR_SECTIONS.map(({ id }) => id)]);
});

for (const name of ["dark", "light"] as const) for (const mode of ["truecolor", "256color"] as const) {
	test(`workspace_lateral_settings: rectángulo y foco sin overflow, resize y tema vigente · ${name}/${mode}`, () => {
		const fixture = settings(); const { modal } = fixture; const theme = palette(name, mode); fixture.setTheme(theme);
		for (const rows of [12, 16, 24, 40]) for (const width of [28, 40, 80, 104]) {
			fixture.setRows(rows); const lines = modal.render(width);
			assert.ok(lines.length <= modalHeight(rows), `${width}x${rows}: ${lines.length}`);
			assert.ok(lines.every((line) => visibleWidth(line) === width), `${width}x${rows}`);
			assert.match(stripTerminalSequences(lines[0]!), /^┌.*┐$/); assert.match(stripTerminalSequences(lines.at(-1)!), /^└.*┘$/);
			assert.ok(lines[MODAL_CONTENT_ROW]!.includes("\x1b[1m"), "selección con negrita real");
			assert.ok(lines[0]!.includes(theme.getFgAnsi("accent")));
		}
		fixture.setRows(12);
		for (const width of [0, 1, 2, 3, 4, 8, 20]) {
			const lines = modal.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `ancho estrecho ${width}`);
			assert.ok(lines.length <= modalHeight(12), `alto acotado al estrechar a ${width}: ${lines.length}`);
		}
		fixture.setRows(24); const before = modal.render(80); fixture.setTheme(palette(name === "dark" ? "light" : "dark", mode)); modal.invalidate();
		const after = modal.render(80); assert.equal(plain(before), plain(after)); assert.notDeepEqual(before, after);
	});
}
