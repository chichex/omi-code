import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { OmiModelPicker, PickerResult } from "../src/tui/workspace/model-picker.ts";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const base: Model<Api> = { id: "model", name: "Model", provider: "test", api: "anthropic-messages", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function harness(home: string, options: { authenticated?: boolean; busy?: boolean; cancel?: boolean } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: () => Promise<void> }>();
	const selections: Model<Api>[] = []; const thinking: string[] = []; const notifications: string[] = [];
	const scoped = { ...base, id: "scoped", name: "Scoped model" }; let pickerCount = 0;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const context = {
		mode: "tui", cwd: home, model: base, scopedModels: [{ model: scoped }], thinkingLevel: "off",
		isIdle: () => !options.busy, isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: .5 }),
		modelRegistry: { getAvailable: () => { throw new Error("No enumerar fuera de --models"); } },
		ui: {
			getTheme: () => undefined, setHeader() {}, setFooter() {}, getEditorComponent: () => () => undefined,
			onTerminalInput: (handler: typeof terminalInput) => { terminalInput = handler; return () => { terminalInput = undefined; }; }, notify: (message: string) => notifications.push(message),
			custom: async (factory: (_ui: unknown, _theme: unknown, _keys: unknown, done: (result: PickerResult) => void) => OmiModelPicker) => {
				pickerCount++; let result: PickerResult | undefined;
				const picker = factory({ requestRender() {} }, {}, {}, (value) => { result = value; });
				if (options.cancel) picker.handleInput("\x1b"); else { picker.handleInput("\r"); picker.handleInput("\r"); }
				return result;
			},
		},
	} as unknown as ExtensionContext;
	const extension: InlineExtension = workspaceExtension(testIo({ homeDir: home, cwd: home, env: {} }), ["--offline"]);
	if (typeof extension === "function") throw new Error("expected named extension");
	await extension.factory({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: () => Promise<void> }) => { commands.set(name, command); },
		getSettings: () => ({}), setModel: async (model: Model<Api>) => { selections.push(model); return options.authenticated !== false; },
		setThinkingLevel: (level: string) => thinking.push(level),
	} as never);
	await handlers.get("session_start")?.({}, context);
	return { commands, selections, thinking, notifications, pickerCount: () => pickerCount, input: (data: string) => terminalInput?.(data), stop: async () => { await handlers.get("session_shutdown")?.({}, context); } };
}

test("workspace_las vistas usan Control 1/2/3 con CSI-u y modifyOtherKeys, sin interceptar números ni Option", async (t) => {
	const ui = await harness(await tempDir(t)); t.after(ui.stop);
	for (const code of [49, 50, 51]) {
		assert.deepEqual(ui.input(`\x1b[${code};5u`), { consume: true });
		assert.deepEqual(ui.input(`\x1b[27;5;${code}~`), { consume: true });
	}
	for (const input of ["1", "2", "3", "¡", "™", "£", "\x1b1", "\x1b2", "\x1b3", "\x01", "\x00"]) assert.equal(ui.input(input), undefined);
});

test("workspace_el selector respeta scopedModels y aplica mediante el runtime, no escribe auth ni defaults", async (t) => {
	const ui = await harness(await tempDir(t)); t.after(ui.stop);
	await ui.commands.get("omi-model")!.handler();
	assert.deepEqual(ui.selections.map((model) => model.id), ["scoped"]); assert.deepEqual(ui.thinking, ["off"]);
});

test("workspace_sin autenticación no cambia razonamiento y explica /login", async (t) => {
	const ui = await harness(await tempDir(t), { authenticated: false }); t.after(ui.stop);
	await ui.commands.get("omi-model")!.handler(); assert.equal(ui.thinking.length, 0); assert.ok(ui.notifications.some((message) => message.includes("/login")));
});

test("workspace_cancelar selector no llama setModel", async (t) => {
	const ui = await harness(await tempDir(t), { cancel: true }); t.after(ui.stop);
	await ui.commands.get("omi-model")!.handler(); assert.equal(ui.selections.length, 0);
});

test("workspace_un turno activo no se cambia de modelo por detrás", async (t) => {
	const ui = await harness(await tempDir(t), { busy: true }); t.after(ui.stop);
	await ui.commands.get("omi-model")!.handler(); assert.equal(ui.selections.length, 0); assert.equal(ui.pickerCount(), 0);
});
