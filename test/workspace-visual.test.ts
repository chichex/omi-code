import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, parseColor, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
// Mismo contrato versionado que el adaptador de OMI, sin emular el algoritmo de layout.
import { getLayoutBoxesAt, renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { bar } from "../src/tui/workspace/presentation.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value, style: (value: string) => value } as unknown as Theme;

async function visualHarness(home: string) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let root: Component | undefined; let focus: Component | undefined; let hasMessages = false; let unknownUsage = false; let approveSensitive = false;
	const prompts: string[] = []; const confirmations: string[] = [];
	const commands = new Map<string, { handler: () => Promise<void> }>();
	const resources = new Container(); const chat = new Container(); const document = new Container();
	// El header viejo, sus márgenes y anuncios técnicos no deben ocupar el centro.
	document.addChild(new Text("HEADER INTERNO", 0, 1)); document.addChild(resources); document.addChild(chat);
	const editor = new Container(); const footer = new Container();
	const ui = {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true, mode: "fullscreen", terminal: { columns: 132, rows: 40 },
		children: [document, new Container(), new Container(), new Container(), editor, new Container(), footer],
		requestRender() {}, setLayoutRoot: (next: Component) => { root = next; }, hasOverlay: () => false, setFocus: (component: Component) => { focus = component; },
	} as unknown as TUI;
	const ctx = {
		mode: "tui", cwd: home, model: { name: "Modelo real", provider: "proveedor-real", contextWindow: 200000 }, thinkingLevel: "high",
		scopedModels: [], modelRegistry: { getAvailable: () => [] }, isIdle: () => true, isProjectTrusted: () => false,
		sessionManager: { getBranch: () => hasMessages ? [{ type: "message" }] : [] },
		getContextUsage: () => unknownUsage ? undefined : { tokens: 56000, contextWindow: 200000, percent: 28 },
		ui: {
			theme, getTheme: () => undefined, setHeader() {}, getEditorComponent: () => undefined,
			setFooter: (factory: (ui: TUI, theme: Theme, data: unknown) => Component) => footer.addChild(factory(ui, theme, { getExtensionStatuses: () => new Map() })),
			setEditorComponent: (factory: (ui: TUI, theme: unknown, keys: unknown) => Component) => editor.addChild(factory(ui, { borderColor: (value: string) => value }, { getKeys: () => ["ctrl+l"], matches: () => false })),
			onTerminalInput: () => () => {}, notify() {},
			confirm: async (title: string) => {
				confirmations.push(title); handlers.get("ui_prompt_start")?.({}, ctx); handlers.get("ui_prompt_end")?.({}, ctx);
				return approveSensitive;
			},
			custom: async (factory: (ui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) => {
				prompts.push(factory(ui, theme, {}, () => {}).render(90).map(stripTerminalSequences).join("\n"));
			},
		},
	} as unknown as ExtensionContext;
	const extension = workspaceExtension(testIo({ cwd: home, homeDir: home, env: {} }), ["--offline"]);
	if (typeof extension === "function") throw new Error("expected named extension");
	await extension.factory({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: (name: string, command: { handler: () => Promise<void> }) => commands.set(name, command), getSettings: () => ({}) } as never);
	await handlers.get("session_start")!({}, ctx);
	return {
		resources, chat, prompts, confirmations,
		changes: () => commands.get("omi-changes")!.handler(),
		input: (data: string) => focus?.handleInput?.(data),
		approve: () => { approveSensitive = true; },
		frame: (width = 132, height = 40) => { Object.assign(ui.terminal, { columns: width, rows: height }); return renderLayoutFrame(root!, width, height, () => {}); },
		unknown: () => { unknownUsage = true; },
		messages: () => { hasMessages = true; chat.addChild(new Text("CONVERSACIÓN REAL", 0, 0)); },
		stop: async () => { await handlers.get("session_shutdown")!({}, ctx); },
	};
}

test("workspace_geometría real: Inicio, contexto justo sobre Equipo, cuatro barras y modelo en su propia fila", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	for (const [width, height] of [[132, 40], [160, 44], [110, 32], [110, 26]] as const) {
		const frame = ui.frame(width, height); const lines = frame.lines.map(stripTerminalSequences);
		assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /¿Qué hacemos en/); assert.doesNotMatch(lines.join("\n"), /HEADER INTERNO/);
		const side = lines.slice(3, -3).map((line) => Array.from(line).slice(width - 33).join(""));
		assert.ok(side.every((line) => line.startsWith("│")), `${width}x${height}`);
		const context = side.findIndex((line) => line.includes("CONTEXTO"));
		assert.match(side[context + 1]!, /56k \/ 200k tokens.*28%/);
		assert.match(side[context + 2]!, /█{30}/); assert.match(side[context + 4]!, /EQUIPO/);
		assert.equal(side.filter((line) => line.includes("█")).length, 4);
		assert.match(lines[height - 2]!, /Ctrl 1\/2\/3 vistas/); assert.doesNotMatch(lines.slice(-3).join("\n"), /Contexto|56k/);
		assert.match(lines[height - 1]!, /Modelo: Modelo real.*proveedor-real.*Razonamiento: high.*Ctrl L cambiar/);
		assert.match(lines[height - 4]!, /Enter enviar/);
	}
});

test("workspace_panes bajos y angostos conservan modelo y contexto sin lateral ni overflow", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	for (const [width, height] of [[109, 40], [132, 25], [80, 24], [40, 24], [28, 16]] as const) {
		const lines = ui.frame(width, height).lines.map(stripTerminalSequences);
		assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(lines.join("\n"), /CONTEXTO|EQUIPO/);
		assert.match(lines[height - 2]!, /Contexto/); assert.match(lines[height - 1]!, /Modelo: Modelo real/);
	}
	ui.unknown(); const lines = ui.frame(132, 40).lines.map(stripTerminalSequences);
	assert.match(lines.join("\n"), /— \/ 200k tokens/); assert.doesNotMatch(lines.join("\n"), /0 \/ 200k tokens/);
});

test("workspace_no tapa conversación ni diagnósticos y el clic abre el detalle correcto", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	ui.resources.addChild(new Text("DIAGNÓSTICO IMPORTANTE", 0, 0)); ui.messages();
	for (const [width, height] of [[132, 40], [110, 26], [80, 24]] as const) {
		const frame = ui.frame(width, height); const lines = frame.lines.map(stripTerminalSequences);
		assert.doesNotMatch(lines.join("\n"), /¿Qué hacemos/);
		assert.match(lines.join("\n"), /CONVERSACIÓN REAL/); assert.match(lines.join("\n"), /DIAGNÓSTICO IMPORTANTE/);
		const y = width >= 110 ? lines.findIndex((line) => line.includes("CONTEXTO")) : height - 2;
		const x = width - 8; const box = getLayoutBoxesAt(frame, x, y).find((box) => box.component.handleMouse);
		assert.ok(box);
		box.component.handleMouse!({ type: "click", x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height } as never);
		assert.match(ui.prompts.at(-1)!, /Ventana de contexto/);
		// Dejar finalizar el modal para poder abrir el siguiente.
		await Promise.resolve();
		if (width >= 110) {
			const resourceY = lines.findIndex((line) => line.includes("EQUIPO"));
			const resourceBox = getLayoutBoxesAt(frame, x, resourceY).find((box) => box.component.handleMouse)!;
			resourceBox.component.handleMouse!({ type: "click", x: x - resourceBox.rect.x, y: resourceY - resourceBox.rect.y, width: resourceBox.rect.width, height: resourceBox.rect.height } as never);
			assert.match(ui.prompts.at(-1)!, /Recursos · equipo donde corre OMI/); await Promise.resolve();
		}
		const modelBox = getLayoutBoxesAt(frame, 5, height - 1).find((box) => box.component.handleMouse)!;
		modelBox.component.handleMouse!({ type: "click", x: 5, y: height - 1 - modelBox.rect.y, width: modelBox.rect.width, height: modelBox.rect.height } as never);
		assert.match(ui.prompts.at(-1)!, /Elegir modelo · OMI/); await Promise.resolve();
	}
});

test("workspace_Enter abre archivos nuevos, confirma sensibles y vuelve a Cambios sin enviarlos al chat", async (t) => {
	const home = await tempDir(t);
	execFileSync("git", ["init", "-b", "main"], { cwd: home, stdio: "ignore" });
	await mkdir(join(home, "test")); await writeFile(join(home, "test/new.test.ts"), "SOURCE_PREVIEW_ONLY\n");
	await writeFile(join(home, "credentials.json"), "SENSITIVE_PREVIEW_ONLY\n");
	const ui = await visualHarness(home); t.after(ui.stop); await ui.changes();
	const screen = () => ui.frame().lines.map(stripTerminalSequences).join("\n");
	async function waitFor(expected: RegExp): Promise<void> {
		for (let i = 0; i < 80; i++) { if (expected.test(screen())) return; await setTimeout(25); }
		assert.match(screen(), expected);
	}
	await waitFor(/\?\? test\/new.test.ts/);
	assert.doesNotMatch(screen(), /SOURCE_PREVIEW_ONLY|SENSITIVE_PREVIEW_ONLY/);
	// Git ordena credentials.json antes de test/new.test.ts.
	ui.input("\x1b[B"); ui.input("\r");
	await waitFor(/SOURCE_PREVIEW_ONLY/); assert.match(screen(), /ARCHIVO NUEVO/); assert.equal(ui.confirmations.length, 0);
	ui.input("\x7f"); ui.input("\x1b[A"); ui.input("\r");
	await waitFor(/\?\? credentials.json/); assert.equal(ui.confirmations.length, 1); assert.doesNotMatch(screen(), /SENSITIVE_PREVIEW_ONLY/);
	ui.approve(); ui.input("\r"); await waitFor(/SENSITIVE_PREVIEW_ONLY/); assert.equal(ui.confirmations.length, 2);
	assert.match(screen(), /Cambios locales/); assert.doesNotMatch(screen(), /¿Qué hacemos en/);
	assert.equal(ui.chat.children.length, 0, "la previsualización nunca entra en la conversación");
});

test("workspace_barras sólidas: ancho y pista constante, también sin dato o en tema claro", () => {
	const calls: { used: string; track: string }[] = [];
	let used = "";
	const meterTheme = { ...theme, fg: (_role: string, value: string) => { used = value; return value; }, style: (value: string) => { calls.push({ used, track: value }); return value; } } as unknown as Theme;
	for (const percent of [undefined, -1, 0, 28, 80, 95, 100, 200]) {
		assert.equal(bar(meterTheme, percent, 30), "█".repeat(30));
	}
	assert.deepEqual(calls[0], { used: "", track: "█".repeat(30) }); assert.equal(calls[3]!.used.length, 8); assert.equal(calls.at(-1)!.track, "");
	assert.equal(bar(meterTheme, 50, 0), "");
	for (const appearance of ["dark", "light"] as const) {
		let trackColor: unknown;
		const colored = { ...meterTheme, appearance, style: (value: string, options: { fg: unknown }) => { trackColor = options.fg; return value; } } as unknown as Theme;
		bar(colored, 50, 10);
		assert.deepEqual(trackColor, parseColor(appearance === "light" ? "#d0d5d9" : "#292f34"));
	}
});
