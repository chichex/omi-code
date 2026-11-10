import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { OmiModelPicker, filterModels, modelKey, recommendedModels, type PickerResult } from "../src/tui/workspace/model-picker.ts";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { align, bar, fit, surface, tokens } from "../src/tui/workspace/presentation.ts";
import { testIo } from "./helpers/io.ts";

const theme = { fg: (_role: string, value: string) => `\x1b[36m${value}\x1b[39m`, bold: (value: string) => value, style: (value: string) => value, getColorMode: () => "truecolor" } as unknown as Theme;
const base: Model<Api> = { id: "base", name: "Base", provider: "alpha", api: "anthropic-messages", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const models: Model<Api>[] = [
	{ ...base, provider: "alpha", id: "large", name: "中 Model Large", contextWindow: 200000, reasoning: true },
	{ ...base, provider: "beta", id: "small", name: "Small", contextWindow: 32000, reasoning: false },
];
function picker(options: { contextTokens?: number; query?: string; favorites?: string[]; catalog?: Model<Api>[] } = {}) {
	let result: PickerResult | undefined;
	const instance = new OmiModelPicker({ models: options.catalog ?? models, current: models[0], thinking: "high", favorites: options.favorites ?? [], contextTokens: options.contextTokens ?? 10000, initialQuery: options.query ?? "", theme, maxRows: () => 30, render() {}, done(value) { result = value; } });
	return { instance, result: () => result };
}

test("workspace_modelos filtra por palabras y proveedor, favoritos sin duplicar el catálogo", () => {
	const favorites = new Set([modelKey(models[0]!)]);
	assert.equal(filterModels(models, "alpha large", favorites, false).length, 1);
	assert.equal(filterModels(models, "beta", favorites, true).length, 0);
	assert.equal(filterModels(models, "", favorites, true)[0]?.id, "large");
});

test("workspace_recomendados conserva la última versión por familia, sin fijar IDs ni perder custom", () => {
	const ids = ["claude-3-7-sonnet-20250219", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-opus-4-6",
		"gpt-5.9", "gpt-5.10", "gpt-5.10-2027-01-01", "gpt-5.9-mini", "gpt-5.10-mini", "gpt-5.10-codex",
		"gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-3.1-pro", "gemini-3-flash", "gemini-pro-latest",
		"claude-fable-5", "claude-fable-5-1", "grok-4.5", "grok-4.7", "o1", "o3", "o3-mini", "o4-mini", "mi-modelo-local"];
	const catalog = ids.map((id) => ({ ...base, id }));
	assert.deepEqual(recommendedModels(catalog).map((model) => model.id), ["claude-sonnet-4-6", "claude-opus-4-6",
		"gpt-5.10", "gpt-5.10-mini", "gpt-5.10-codex", "gemini-3.1-pro", "gemini-3-flash", "claude-fable-5-1", "grok-4.7", "o3", "o4-mini", "mi-modelo-local"]);
	assert.equal(recommendedModels([...catalog, { ...base, provider: "other", id: "gpt-5.9" }]).at(-1)?.provider, "other");
	assert.ok(recommendedModels(catalog, new Set(["alpha/gpt-5.9"])).some((model) => model.id === "gpt-5.9"));
	assert.deepEqual(catalog.map((model) => model.id), ids, "no muta el catálogo original");
	assert.deepEqual(recommendedModels([]), []);
});

test("workspace_selector abre en el proveedor actual y Tab / Shift Tab recorren proveedores y Todos", () => {
	const { instance, result } = picker();
	assert.match(instance.render(100).join("\n"), /‹ alpha ›/);
	assert.doesNotMatch(instance.render(100).join("\n"), /Small/);
	instance.handleInput("\t");
	assert.match(instance.render(100).join("\n"), /‹ beta ›/);
	assert.doesNotMatch(instance.render(100).join("\n"), /Model Large/);
	instance.handleInput("\x1b[Z");
	assert.match(instance.render(100).join("\n"), /‹ alpha ›/);
	instance.handleInput("\x1b[Z");
	assert.match(instance.render(100).join("\n"), /Todos los proveedores/);
	assert.match(instance.render(100).join("\n"), /Small/);
	instance.handleInput("\x1b[Z");
	instance.handleInput("\r"); instance.handleInput("\r");
	assert.equal(result()?.choice?.model.provider, "beta");
});

test("workspace_selector reduce versiones por defecto, pero preserva actual y favoritos y permite catálogo/búsqueda", () => {
	const catalog = ["gpt-5.1", "gpt-5.2", "claude-sonnet-4-5", "claude-sonnet-4-6"].map((id) => ({ ...base, id, name: id }));
	const { instance } = picker({ catalog });
	let output = instance.render(110).join("\n");
	assert.match(output, /Recomendados/); assert.match(output, /gpt-5.2/); assert.doesNotMatch(output, /gpt-5.1/);
	instance.handleInput("\x01");
	output = instance.render(110).join("\n");
	assert.match(output, /Catálogo/); assert.match(output, /gpt-5.1/);
	instance.handleInput("\x01"); instance.handleInput("5.1");
	assert.match(instance.render(110).join("\n"), /gpt-5.1/);
	const favorite = picker({ catalog, favorites: ["alpha/gpt-5.1"] }).instance;
	assert.match(favorite.render(110).join("\n"), /★ gpt-5.1/);
	const current = new OmiModelPicker({ models: catalog, current: catalog[0], thinking: "high", favorites: [], contextTokens: null, theme, maxRows: () => 30, render() {}, done() {} });
	assert.match(current.render(110).join("\n"), /gpt-5.1 · actual/);
});

test("workspace_selector conserva búsqueda y favoritos al cambiar de proveedor y no agrega modelos", () => {
	const { instance, result } = picker({ query: "small", favorites: ["beta/small", "missing/model"] });
	assert.match(instance.render(100).join("\n"), /Todos los proveedores/);
	instance.handleInput("\t");
	assert.match(instance.render(100).join("\n"), /Sin modelos/);
	instance.handleInput("\x06"); instance.handleInput("\t");
	assert.match(instance.render(100).join("\n"), /★ Favoritos/);
	assert.match(instance.render(100).join("\n"), /Small/);
	instance.handleInput("\x13");
	assert.match(instance.render(100).join("\n"), /Sin modelos/);
	instance.handleInput("\r"); assert.equal(result(), undefined);
	instance.handleInput("\x1b"); assert.deepEqual(result()?.favorites, ["missing/model"]);
});

test("workspace_selector mouse coincide con las filas y no cambia selección durante la revisión", () => {
	const { instance, result } = picker(); instance.handleInput("\x1b[Z");
	const lines = instance.render(100);
	const y = lines.findIndex((line) => line.includes("Small")); assert.ok(y >= 0);
	instance.handleMouse({ type: "click", y } as never);
	assert.match(instance.render(100).join("\n"), /beta\/small/);
	assert.equal(instance.handleMouse({ type: "wheel", wheelDelta: -1 } as never), undefined);
	instance.handleInput("\r"); assert.equal(result()?.choice?.model.id, "small");
});

test("workspace_selector requiere revisar antes de aplicar y sólo ofrece razonamiento soportado", () => {
	const { instance, result } = picker(); instance.handleInput("\r"); assert.equal(result(), undefined);
	instance.handleInput("\t"); instance.handleInput("\r");
	assert.equal(result()?.choice?.model.id, "large"); assert.ok(getSupportedThinkingLevels(models[0]!).includes(result()!.choice!.thinking));
});

test("workspace_selector permite cancelar sin selección y guarda favoritos separadamente", () => {
	const { instance, result } = picker(); instance.handleInput("\x13"); instance.handleInput("\x1b");
	assert.equal(result()?.choice, undefined); assert.deepEqual(result()?.favorites, ["alpha/large"]);
});

test("workspace_selector no cambia a un modelo cuyo contexto es insuficiente", () => {
	const { instance, result } = picker({ query: "small", contextTokens: 100000 }); instance.handleInput("\r");
	assert.match(instance.render(80).join("\n"), /supera el límite/); instance.handleInput("\r"); assert.equal(result(), undefined);
	instance.handleInput("\x1b"); assert.equal(result()?.choice, undefined);
});

test("workspace_modelo sin reasoning se aplica en off", () => {
	const { instance, result } = picker({ query: "small" }); instance.handleInput("\r"); instance.handleInput("\r"); assert.equal(result()?.choice?.thinking, "off");
});

test("workspace_selector vacío, favoritos vacíos, Unicode y anchos pequeños no desbordan", () => {
	for (const catalog of [models, []]) {
		const { instance } = picker({ catalog });
		for (const width of [1, 3, 8, 25, 40, 80]) assert.ok(instance.render(width).every((line) => visibleWidth(line) <= width), `width=${width}`);
		instance.handleInput("\x06"); assert.match(instance.render(80).join("\n"), /Sin modelos/);
	}
	assert.equal(visibleWidth(fit("中abc", 3)), 3); assert.equal(tokens(200000), "200k"); assert.equal(tokens(1000000), "1M");
	assert.equal(visibleWidth(align("left", "right", 15)), 15); assert.equal(visibleWidth(bar(theme, 95, 10)), 10);
});

test("workspace_el fondo respeta un tema claro explícito para no dejar texto negro sobre negro", () => {
	let background: unknown;
	const light = { ...theme, appearance: "light", style: (value: string, options: { bg: unknown }) => { background = options.bg; return value; } } as unknown as Theme;
	assert.equal(surface(light, "text", 8).length, 8); assert.deepEqual(background, parseColor("#ffffff"));
	surface(light, "text", 8, true); assert.deepEqual(background, parseColor("#f3f4f5"));
});

async function bind(extension: InlineExtension) {
	if (typeof extension === "function") throw new Error("expected named extension");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>(); let commands = 0;
	await extension.factory({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); }, registerCommand: () => { commands++; }, registerMarkdownTransformer() {} } as never);
	return { handlers, commands };
}
for (const mode of ["rpc", "json", "print"] as const) {
	test(`workspace_${mode} no toca la UI ni abre recursos de background`, async () => {
		const { handlers } = await bind(workspaceExtension(testIo({ homeDir: "/unused", env: {} }), []));
		const ctx = { mode, ui: new Proxy({}, { get: () => { throw new Error("UI touched"); } }) } as ExtensionContext;
		await handlers.get("session_start")?.({}, ctx); await handlers.get("session_shutdown")?.({}, ctx);
	});
}

test("workspace_OMI_TUI classic no registra eventos ni comandos", async () => {
	const result = await bind(workspaceExtension(testIo({ homeDir: "/unused", env: { OMI_TUI: "classic" } }), [])); assert.equal(result.commands, 0); assert.equal(result.handlers.size, 0);
});
