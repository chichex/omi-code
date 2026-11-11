import assert from "node:assert/strict";
import { test } from "node:test";
import { getMarkdownTheme, UserMessageComponent, type ExtensionContext, type MarkdownTransformer, type Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
// El componente nativo consulta el tema global de Pi, también en el renderer real.
import { getThemeByName, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { tempDir, testIo } from "./helpers/io.ts";

async function harness(home: string, options: { args?: string[]; setting?: string; mode?: string } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const transformers: MarkdownTransformer[] = []; const applied: Theme[] = [];
	let theme = getThemeByName(options.setting ?? "dark")!; setThemeInstance(theme);
	const ctx = {
		mode: options.mode ?? "tui", cwd: home, isIdle: () => true, isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
		ui: {
			get theme() { return theme; }, getTheme: getThemeByName,
			setTheme: (value: Theme) => { applied.push(value); theme = value; setThemeInstance(value); },
			setHeader() {}, setFooter() {}, notify() {}, getEditorComponent: () => () => undefined,
			onTerminalInput: () => () => {},
		},
	} as unknown as ExtensionContext;
	const extension = workspaceExtension(testIo({ cwd: home, homeDir: home, env: {} }), ["--offline", ...(options.args ?? [])]);
	if (typeof extension === "function") throw new Error("expected named extension");
	await extension.factory({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerCommand() {}, registerMarkdownTransformer: (transformer: MarkdownTransformer) => transformers.push(transformer),
		getSettings: () => ({ theme: options.setting }),
	} as never);
	const transform = (value: string, messageType: "user" | "assistant" | "assistant-thinking" = "user", isStreaming = false) => transformers[0]!(value, { messageType, isStreaming, availableWidth: 80 });
	assert.equal(transform("antes de iniciar"), "antes de iniciar");
	await handlers.get("session_start")!({}, ctx);
	return { transformers, transform, applied, theme: () => theme, stop: async () => { await handlers.get("session_shutdown")!({}, ctx); } };
}

test("workspace_mensajes propios: encabezado visual y fondo distinto sin reescribir el contenido", async (t) => {
	const ui = await harness(await tempDir(t)); t.after(ui.stop);
	const original = "Revisá **este cambio**.\n\n1. Mantener lista\n2. Mantener orden\n\n```ts\nconst ejemplo = 1;\n```\n\n> Cita original\n\n[Enlace](https://example.com)";
	const transformed = ui.transform(original);
	assert.equal(stripTerminalSequences(transformed), `**▌ Vos**\n\n${original}`);
	assert.equal(ui.transform(""), ""); assert.equal(ui.transform(" \n"), " \n");
	for (const messageType of ["assistant", "assistant-thinking"] as const) {
		for (const streaming of [false, true]) assert.equal(ui.transform(original, messageType, streaming), original);
	}
	assert.equal(ui.applied.length, 1);
	assert.deepEqual(ui.theme().colors.userMessageBg, parseColor("#182b23"));
	assert.deepEqual(ui.theme().colors.userMessageText, parseColor("#edf5f0"));
	assert.notDeepEqual(ui.theme().colors.userMessageBg, parseColor("#050607"));
	await ui.stop(); assert.equal(ui.transform(original), original);
});

test("workspace_renderer nativo conserva Markdown, etiqueta única y ancho al redimensionar y restaurar mensajes", async (t) => {
	const ui = await harness(await tempDir(t)); t.after(ui.stop);
	const original = "Pedido propio con 漢字 y emoji 🙂 que se ajusta al ancho.\n\n1. Primera\n2. Segunda\n\n```ts\nconst valor = 1;\n```\n\n> Cita original";
	for (const restored of [false, true]) {
		const component = new UserMessageComponent(original, getMarkdownTheme(), 1, ui.transformers, restored ? "entry-id" : undefined, restored ? "2026-01-01T00:00:00Z" : undefined);
		for (const width of [132, 80, 28, 12, 80]) {
			component.invalidate(); const lines = component.render(width); const plain = lines.map(stripTerminalSequences).join("\n");
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width=${width}`);
			assert.equal(plain.match(/▌ Vos/g)?.length, 1);
			assert.match(plain, /1\. Primera/); assert.match(plain, /2\. Segunda/);
			assert.match(plain, /│ Cita/);
			assert.ok(lines.some((line) => line.includes(ui.theme().getBgAnsi("userMessageBg"))));
		}
	}
});

test("workspace_el encabezado respeta temas explícitos y no reemplaza su paleta", async (t) => {
	for (const options of [{ setting: "light" }, { args: ["--use-theme", "light"] }]) {
		const ui = await harness(await tempDir(t), options);
		try { assert.equal(ui.applied.length, 0); assert.match(stripTerminalSequences(ui.transform("pedido")), /▌ Vos/); }
		finally { await ui.stop(); }
	}
});

for (const mode of ["rpc", "json", "print"]) {
	test(`workspace_${mode} no agrega etiquetas al Markdown`, async (t) => {
		const ui = await harness(await tempDir(t), { mode }); t.after(ui.stop);
		assert.equal(ui.transform("sin formato adicional"), "sin formato adicional"); assert.equal(ui.applied.length, 0);
	});
}
