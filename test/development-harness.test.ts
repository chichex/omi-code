import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { developmentHarnessExtension } from "../src/tui/development.ts";
import { testIo } from "./helpers/io.ts";

test("development_harness es opt-in: registrar no ejecuta modelo, GitHub ni cambia tools de la sesión", async () => {
	const io = testIo({ homeDir: "/tmp/omi-development-test" }); const tools = new Map<string, { defaultActive?: boolean }>(); const commands = new Map<string, unknown>(); const events = new Map<string, Function>();
	const calls: string[] = [];
	const pi = {
		registerTool: (tool: { name: string; defaultActive?: boolean }) => tools.set(tool.name, tool), registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (name: string, handler: Function) => events.set(name, handler),
		events: { emit: () => {} }, getActiveTools: () => ["read", "bash", "edit", "write"], getAllTools: () => [],
		setActiveTools: () => calls.push("tools"), appendEntry: () => calls.push("entry"), sendUserMessage: () => calls.push("model"),
	} as unknown as ExtensionAPI;
	const extension = developmentHarnessExtension(io, []);
	if (typeof extension === "function") await extension(pi); else await extension.factory(pi);
	assert.ok(commands.has("omi-work"));
	for (const name of ["omi_workflow", "omi_workflow_check", "omi_workflow_lens", "omi_workflow_inspect", "omi_workflow_commit"]) assert.ok(tools.has(name), name);
	assert.deepEqual(calls, []);
	for (const tool of tools.values()) assert.equal(tool.defaultActive, false, "el chat normal no declara tools del workflow antes de iniciarlo");
	const ctx = { cwd: io.cwd, mode: "tui", sessionManager: { getBranch: () => [] }, ui: { setStatus: () => {}, notify: () => {} } } as unknown as ExtensionContext;
	await events.get("session_start")!({}, ctx);
	assert.deepEqual(calls, []);
	assert.equal(await events.get("tool_call")!({ toolName: "write", input: { path: "file", content: "x" } }, ctx), undefined, "el chat normal no se convierte en workflow por abrir OMI");
});
