import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { subagentsExtension } from "../src/tui/subagents.ts";

const model = { id: "test", provider: "custom", api: "openai-completions", reasoning: true };
function message(text: string, error = false): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "custom", model: "test", stopReason: error ? "error" : "stop", ...(error ? { errorMessage: text } : {}), timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } };
}
function stream(result: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	if (result.stopReason === "error" || result.stopReason === "aborted") events.push({ type: "error", reason: result.stopReason, error: result });
	else events.push({ type: "done", reason: result.stopReason === "pending" ? "stop" : result.stopReason, message: result });
	return events;
}
function setup(respond: (context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof stream> | Promise<ReturnType<typeof stream>>) {
	let tool: ToolDefinition;
	let shutdown: () => void = () => {};
	const extension = subagentsExtension();
	assert.equal(typeof extension, "object");
	if (typeof extension === "function") throw new Error("expected named extension");
	extension.factory({ registerTool: (definition: ToolDefinition) => { tool = definition; }, events: { emit() {}, on() { return () => {}; } }, on: (event: string, handler: () => void) => { if (event === "session_shutdown") shutdown = handler; } } as never);
	const seen: string[] = [];
	const ctx = {
		cwd: "/worktree", model, thinkingLevel: "high", getSystemPrompt: () => "PROJECT_INSTRUCTIONS",
		modelRegistry: { streamSimple: (_model: unknown, context: TranscriptContext, options?: SimpleStreamOptions) => { assert.equal(_model, model); assert.equal(options?.reasoning, "high"); return respond(context, options); } },
		tools: ["read", "write", "bash", "omi_postgres_exec", "codemode", "tool_search", "subagent"].map((name) => ({ name, label: name, description: name, parameters: { type: "object" }, execute: () => { throw new Error("No ejecutar tools crudas"); } })),
		executeTool: async (name: string) => { seen.push(name); return { result: { content: [{ type: "text", text: "READ_OK" }], details: {} }, isError: false }; },
	} as unknown as ExtensionToolContext;
	return { ctx, seen, shutdown: () => shutdown(), run: (params: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void) => tool!.execute("parent", params as never, signal, onUpdate, ctx) };
}
function taskText(context: TranscriptContext): string {
	const user = context.messages.find((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

test("subagent: contexto propio, instrucciones del proyecto, modelo y razonamiento del padre", async () => {
	const setupResult = setup((context) => {
		assert.equal(context.messages.filter((m) => m.role === "user").length, 1);
		assert.match(JSON.stringify(context.messages), /PROJECT_INSTRUCTIONS|\/worktree/);
		return stream(message(taskText(context)));
	});
	const result = await setupResult.run({ agent: "scout", task: "TASK_ONLY" });
	assert.equal(result.isError, false); assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /TASK_ONLY/);
	assert.equal(result.usage?.totalTokens, 12);
});

test("subagent: roles de lectura no tienen bash, escrituras, OMI ni orquestadores", async () => {
	for (const role of ["scout", "planner", "reviewer"]) {
		const { run } = setup((context) => {
			assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["read"]);
			return stream(message("ok"));
		});
		assert.equal((await run({ agent: role, task: "inspect" })).isError, false);
	}
});

test("subagent: worker usa executeTool del padre, nunca la implementación cruda", async () => {
	let calls = 0;
	const { run, seen } = setup((context) => {
		if (calls++ === 0) {
			assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["read", "write", "bash", "omi_postgres_exec"]);
			const result = message(""); result.stopReason = "toolUse";
			result.content = [{ type: "toolCall", id: "read", name: "read", arguments: {} }];
			return stream(result);
		}
		assert.match(JSON.stringify(context.messages), /READ_OK/);
		return stream(message("done"));
	});
	const result = await run({ agent: "worker", task: "read" });
	assert.deepEqual(seen, ["read"]); assert.equal(result.isError, false); assert.equal(result.usage?.totalTokens, 24);
});

test("subagent: paralelo limitado a 4, devuelve todos los resultados en orden y suma uso", async () => {
	let active = 0; let max = 0;
	const { run } = setup(async (context) => {
		active++; max = Math.max(max, active);
		await new Promise((resolve) => setTimeout(resolve, taskText(context) === "0" ? 30 : 5));
		active--; return stream(message(taskText(context)));
	});
	const result = await run({ tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "scout", task: String(i) })) });
	assert.equal(max, 4); assert.equal(result.isError, false); assert.equal(result.usage?.totalTokens, 96);
	assert.deepEqual((result.details as { results: { output: string }[] }).results.map((r) => r.output), ["0", "1", "2", "3", "4", "5", "6", "7"]);
});

test("subagent: chain sustituye {previous} literalmente y se detiene ante error", async () => {
	const prompts: string[] = [];
	const { run } = setup((context) => {
		prompts.push(taskText(context));
		return stream(message(prompts.length === 1 ? "$& CONTEXT" : "failed", prompts.length > 1));
	});
	const result = await run({ chain: [{ agent: "scout", task: "start" }, { agent: "planner", task: "plan {previous}" }, { agent: "worker", task: "implement" }] });
	assert.deepEqual(prompts, ["start", "plan $& CONTEXT"]); assert.equal(result.isError, true);
});

test("subagent: marca el paralelo fallido si un hijo falla", async () => {
	const { run } = setup((context) => stream(message(taskText(context), taskText(context) === "bad")));
	const result = await run({ tasks: [{ agent: "scout", task: "ok" }, { agent: "scout", task: "bad" }] });
	assert.equal(result.isError, true); assert.equal(result.usage?.totalTokens, 24);
});

for (const params of [{}, { agent: "scout" }, { task: "x" }, { agent: "scout", task: "x", tasks: [] }, { tasks: [] }, { tasks: Array(9).fill({ agent: "scout", task: "x" }) }]) {
	test(`subagent: rechaza modos inválidos ${JSON.stringify(params)}`, async () => {
		const { run } = setup(() => { throw new Error("No debería llamar al proveedor"); });
		await assert.rejects(run(params));
	});
}

test("subagent: sin modelo no consulta un proveedor ni usa el shell", async () => {
	const state = setup(() => { throw new Error("no llamar"); });
	delete (state.ctx as { model?: unknown }).model;
	await assert.rejects(state.run({ agent: "scout", task: "x" }), /modelo autenticado/);
});

test("subagent: cancelado antes de arrancar no llama al proveedor", async () => {
	const { run } = setup(() => { throw new Error("no llamar"); });
	const result = await run({ agent: "scout", task: "x" }, AbortSignal.abort());
	assert.equal(result.isError, true);
});

for (const shutdown of [false, true]) test(`subagent: ${shutdown ? "shutdown" : "Esc"} cancela el stream y no arranca los pendientes`, async () => {
	let started = 0; const controller = new AbortController();
	const state = setup((_context, options) => {
		started++;
		const events = createAssistantMessageEventStream();
		options?.signal?.addEventListener("abort", () => {
			const result = message("aborted", true); result.stopReason = "aborted";
			events.push({ type: "error", reason: "aborted", error: result });
		}, { once: true });
		queueMicrotask(() => shutdown ? state.shutdown() : controller.abort());
		return events;
	});
	const result = await state.run({ tasks: Array(8).fill({ agent: "worker", task: "wait" }) }, controller.signal);
	assert.equal(result.isError, true); assert.ok(started <= 4);
});

test("subagent: solicita cancelar a los 10 minutos", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { run } = setup((_context, options) => {
		const events = createAssistantMessageEventStream();
		options?.signal?.addEventListener("abort", () => {
			const result = message("aborted", true); result.stopReason = "aborted";
			events.push({ type: "error", reason: "aborted", error: result });
		}, { once: true });
		return events;
	});
	const pending = run({ agent: "scout", task: "wait" });
	await new Promise(setImmediate);
	t.mock.timers.tick(10 * 60_000);
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /10 minutos/);
});

test("subagent: detiene un loop de tools a los 32 turnos", async () => {
	let calls = 0;
	const { run } = setup(() => {
		calls++; const result = message(""); result.stopReason = "toolUse";
		result.content = [{ type: "toolCall", id: String(calls), name: "read", arguments: {} }];
		return stream(result);
	});
	const result = await run({ agent: "scout", task: "loop" });
	assert.equal(calls, 32); assert.equal(result.isError, true);
});

test("subagent: trunca resultados y updates; conserva la salida completa en un archivo privado", async () => {
	const large = "respuesta ".repeat(20000);
	const { run } = setup(() => stream(message(large)));
	const updates: unknown[] = [];
	const result = await run({ agent: "worker", task: "large" }, undefined, (update) => updates.push(update));
	const outputFile = (result.details as { results: { outputFile: string }[] }).results[0]!.outputFile;
	try {
		assert.equal(await readFile(outputFile, "utf8"), large);
		assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
		assert.ok(JSON.stringify(result).length < 15000);
		assert.ok(updates.every((update) => JSON.stringify(update).length < 15000));
	} finally { await rm(outputFile.replace(/\/output.txt$/, ""), { recursive: true, force: true }); }
});
