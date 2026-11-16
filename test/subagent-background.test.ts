import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { subagentsExtension } from "../src/tui/subagents.ts";
import { DISPATCH_TOOL } from "../src/tui/subagent-runner.ts";

function message(text = "DONE"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "mock", model: "m", stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(result: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	if (result.stopReason === "aborted") events.push({ type: "error", reason: "aborted", error: result });
	else events.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" : "stop", message: result });
	return events;
}
function setup(respond: (context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof stream> | Promise<ReturnType<typeof stream>>) {
	const tools = new Map<string, ToolDefinition>(); const handlers = new Map<string, ((event?: unknown) => unknown)[]>();
	const notifications: unknown[] = []; const audit: unknown[] = []; const updates: unknown[] = []; const scopes: string[] = []; const bus = createEventBus();
	bus.on("omi:subagents", (event) => updates.push(event));
	const emit = async (name: string, event?: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event); };
	const extension = subagentsExtension(); if (typeof extension === "function") throw new Error("named extension expected");
	extension.factory({ events: bus, on: (name: string, handler: (event?: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), sendMessage: (...args: unknown[]) => notifications.push(args), appendEntry: (...args: unknown[]) => audit.push(args) } as never);
	const ctx = {
		mode: "tui", cwd: "/worktree", model: { id: "m", provider: "mock", api: "openai-completions" }, thinkingLevel: "off", getSystemPrompt: () => "LAUNCH_CONTEXT",
		modelRegistry: { streamSimple: (_model: unknown, context: TranscriptContext, options?: SimpleStreamOptions) => respond(context, options) },
		tools: [{ name: "read", label: "read", description: "read", parameters: { type: "object" }, execute() { throw new Error("raw read invoked"); } }, {
			name: DISPATCH_TOOL, label: "adapter", description: "adapter", parameters: { type: "object" },
			async execute(id: string, args: unknown, signal?: AbortSignal) {
				scopes.push(id);
				return tools.get(DISPATCH_TOOL)!.execute(id, args as never, signal, undefined, {
					...ctx, executeTool: async (name: string) => {
						assert.equal(name, "read");
						const result = { content: [{ type: "text" as const, text: "HOOKED_READ" }], details: {}, usage: { ...message().usage, totalTokens: 5 } };
						await emit("tool_execution_end", { parentToolCallId: `${id}/1`, result: { ...result, usage: { ...result.usage, totalTokens: 7 } } });
						await emit("tool_execution_end", { parentToolCallId: id, result });
						return { result, isError: false };
					},
				} as never);
			},
		}],
		executeTool() { throw new Error("retained launching scope used in background"); },
	} as unknown as ExtensionToolContext;
	let index = 0;
	const run = (params: unknown, signal?: AbortSignal) => tools.get("subagent")!.execute(`parent-${index++}`, params as never, signal, undefined, ctx);
	return { ctx, tools, notifications, audit, updates, scopes, bus, emit, run };
}
const tick = () => new Promise(setImmediate);
function id(result: { details: unknown }): string { return (result.details as { jobId: string }).jobId; }
async function waitDone(state: ReturnType<typeof setup>, count = 1) {
	for (let i = 0; i < 100 && state.notifications.length < count; i++) await tick();
	assert.equal(state.notifications.length, count, "completion notification missing");
}

for (const mode of ["tui", "rpc"] as const) test(`background ${mode}: control inmediato, contexto congelado, señal propia y resultado/uso una sola vez`, async () => {
	let release: (() => void) | undefined; let childSignal: AbortSignal | undefined; const launched = new AbortController();
	const state = setup(async (context, options) => {
		assert.match(JSON.stringify(context.messages), /LAUNCH_CONTEXT/); assert.doesNotMatch(JSON.stringify(context.messages), /NEW_CONTEXT/);
		childSignal = options?.signal; await new Promise<void>((resolve) => { release = resolve; }); return stream(message());
	});
	Object.assign(state.ctx, { mode });
	const launch = await state.run({ agent: "scout", task: "inspect" }, launched.signal); const jobId = id(launch);
	assert.match(jobId, /^bg-/); assert.equal(launch.usage, undefined);
	Object.assign(state.ctx, { getSystemPrompt: () => "NEW_CONTEXT", model: { id: "different" } }); launched.abort();
	await tick(); assert.equal(childSignal?.aborted, false);
	await state.emit("agent_settled");
	assert.match(JSON.stringify(await state.run({ action: "result", id: jobId })), /running/);
	release!(); await waitDone(state);
	const first = await state.run({ action: "result", id: jobId }); const second = await state.run({ action: "result", id: jobId });
	assert.match(JSON.stringify(first), /DONE/); assert.equal(first.usage?.totalTokens, 12); assert.equal(second.usage, undefined);
	assert.ok(state.updates.some((update) => (update as { phase: string }).phase === "end")); assert.equal(state.audit.length, 1);
	await state.emit("session_shutdown");
});

test("background: tools por contexto fresco, IDs únicos entre turnos, hooks y uso anidado sin duplicar", async () => {
	let calls = 0;
	const state = setup((context) => {
		assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["read"]);
		if (++calls <= 2) {
			const result = message(""); result.stopReason = "toolUse"; result.content = [{ type: "toolCall", id: String(calls), name: "read", arguments: {} }];
			return stream(result);
		}
		assert.match(JSON.stringify(context.messages), /HOOKED_READ/); return stream(message());
	});
	const jobId = id(await state.run({ agent: "worker", task: "read twice" })); await waitDone(state);
	assert.equal(state.scopes.length, 2); assert.notEqual(state.scopes[0], state.scopes[1]);
	const result = await state.run({ action: "result", id: jobId }); assert.equal(result.usage?.totalTokens, 60);
	assert.equal((await state.run({ action: "result", id: jobId })).usage, undefined);
	await assert.rejects(state.tools.get(DISPATCH_TOOL)!.execute("invalid", { ticket: "forged" } as never, undefined, undefined, state.ctx), /Ticket/);
	await state.emit("session_shutdown");
});

for (const stop of ["cancel", "session_tree", "session_shutdown"] as const) test(`background: ${stop} cancela activos y en cola sin arrancar proveedores nuevos`, async () => {
	let started = 0; let aborted = 0;
	const state = setup((_context, options) => {
		started++; const events = createAssistantMessageEventStream();
		options?.signal?.addEventListener("abort", () => { aborted++; const result = message("cancelled"); result.stopReason = "aborted"; events.push({ type: "error", reason: "aborted", error: result }); }, { once: true });
		return events;
	});
	const jobId = id(await state.run({ tasks: Array.from({ length: 8 }, () => ({ agent: "scout", task: "wait" })) }));
	await tick(); assert.equal(started, 4);
	if (stop === "cancel") { state.bus.emit("omi:subagents:cancel", { id: jobId }); await waitDone(state); }
	else { await state.emit(stop); await tick(); assert.equal(state.notifications.length, 0); }
	assert.equal(started, 4); assert.equal(aborted, 4);
	if (stop === "cancel") assert.equal((await state.run({ action: "result", id: jobId })).isError, true);
	if (stop === "session_tree") await assert.rejects(state.run({ action: "result", id: jobId }), /no encontrado/);
	await state.emit("session_shutdown");
});

test("background: máximo cuatro tareas GLOBAL y cuatro lotes, no cuatro por lote", async () => {
	let started = 0; let current = 0; let max = 0; const releases: (() => void)[] = [];
	const state = setup(async () => { started++; current++; max = Math.max(max, current); await new Promise<void>((resolve) => releases.push(resolve)); current--; return stream(message()); });
	for (let i = 0; i < 4; i++) await state.run({ tasks: Array.from({ length: 2 }, () => ({ agent: "worker", task: "work" })) });
	await assert.rejects(state.run({ agent: "worker", task: "fifth batch" }), /4 lotes/);
	await tick(); assert.equal(started, 4);
	for (let i = 0; i < 1000 && state.notifications.length < 4; i++) { for (const release of releases.splice(0)) release(); await tick(); }
	assert.equal(state.notifications.length, 4); assert.equal(max, 4); assert.equal(started, 8); await state.emit("session_shutdown");
});

test("background: no pierde resultados ni uso por desalojar trabajos sin leer", async () => {
	const state = setup(() => stream(message())); const ids: string[] = [];
	for (let i = 0; i < 8; i++) { ids.push(id(await state.run({ agent: "scout", task: "read" }))); await waitDone(state, i + 1); }
	await assert.rejects(state.run({ agent: "scout", task: "ninth" }), /resultados terminados/);
	assert.equal((await state.run({ action: "result", id: ids[0] })).usage?.totalTokens, 12);
	await state.run({ agent: "scout", task: "after collect" }); await waitDone(state, 9); await state.emit("session_shutdown");
});

test("background: acota a 256 scopes delegados aunque un turno pida más tools", async () => {
	let calls = 0;
	const state = setup(() => {
		if (calls++ > 0) return stream(message());
		const result = message(""); result.stopReason = "toolUse";
		result.content = Array.from({ length: 257 }, (_, i) => ({ type: "toolCall" as const, id: String(i), name: "read", arguments: {} }));
		return stream(result);
	});
	await state.run({ agent: "worker", task: "budget" }); await waitDone(state);
	assert.equal(state.scopes.length, 256); await state.emit("session_shutdown");
});

test("background: print/json explícitos no arrancan un job que moriría al salir", async () => {
	const state = setup(() => { throw new Error("must not call provider"); });
	for (const mode of ["print", "json"]) { Object.assign(state.ctx, { mode }); await assert.rejects(state.run({ background: true, agent: "scout", task: "work" }), /persistente/); }
	await assert.rejects(state.run({ action: "cancel" }), /id/);
	await assert.rejects(state.run({ action: "status", task: "invalid" }), /no reciben tareas/);
	await state.emit("session_shutdown");
});
