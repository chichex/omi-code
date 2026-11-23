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

function toolMessage(turn: number, text = ""): AssistantMessage {
	const result = message(text); result.stopReason = "toolUse";
	result.content.push({ type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "toolCall", id: String(turn), name: "read", arguments: {} });
	return result;
}

for (const cooperative of [true, false]) test(`subagent: cierre reservado ${cooperative ? "cooperativo" : "ignorado"} interrumpe chain`, async () => {
	let calls = 0;
	const { run, seen } = setup((context) => {
		calls++;
		const users = context.messages.filter((m) => m.role === "user");
		assert.equal(users.length, calls < 32 ? 1 : 2);
		if (calls === 32) {
			const closing = JSON.stringify(users.at(-1));
			assert.match(closing, /cierre/i);
			for (const word of [/avances/i, /archivos/i, /verificaciones/i, /pendientes/i]) assert.match(closing, word);
			if (cooperative) return stream(message("Avances: cambio parcial. Archivos: src/example.ts. Verificaciones: no ejecutadas. Pendientes: probar."));
		}
		return stream(toolMessage(calls, calls === 8 ? "Parcial útil: falta verificar." : ""));
	});
	const result = await run({ chain: [{ agent: "scout", task: "loop" }, { agent: "worker", task: "NEVER" }] });
	const details = result.details as { results: { status: string; turns: number; output: string }[] };
	assert.equal(calls, 32); assert.equal(result.isError, true);
	assert.equal(details.results[0]!.status, "error"); assert.equal(details.results[0]!.turns, 32);
	assert.equal(details.results[1]!.status, "pending");
	assert.equal(result.usage?.totalTokens, 32 * 12);
	assert.equal(seen.length, cooperative ? 31 : 32);
	const output = details.results[0]!.output;
	assert.match(output, /Interrumpido por límite de turnos/);
	assert.match(output, /### Información recuperada/);
	assert.match(output, cooperative ? /src\/example.ts/ : /Parcial útil/);
	assert.doesNotMatch(output, /PRIVATE_THINKING|READ_OK|tests fallaron|No hubo cambios/);
});

test("subagent: sin texto recuperable usa fallback explícito", async () => {
	let calls = 0;
	const { run } = setup(() => stream(toolMessage(++calls)));
	const result = await run({ agent: "scout", task: "loop" });
	assert.equal(calls, 32); assert.equal(result.isError, true);
	assert.equal((result.details as { results: { output: string }[] }).results[0]!.output, "Interrumpido por límite de turnos; sin resumen recuperable; revisar archivos y verificaciones antes de continuar");
});

test("subagent: final normal en turno 31 no solicita cierre ni cambia salida", async () => {
	let calls = 0;
	const { run } = setup((context) => {
		assert.equal(context.messages.filter((m) => m.role === "user").length, 1);
		return stream(++calls === 31 ? message("Final normal") : toolMessage(calls));
	});
	const result = await run({ agent: "scout", task: "finish" });
	assert.equal(calls, 31); assert.equal(result.isError, false);
	assert.equal((result.details as { results: { output: string }[] }).results[0]!.output, "Final normal");
});

test("subagent: parcial largo interrumpido conserva archivo privado y updates acotados", async () => {
	let calls = 0; const large = "avances reales ".repeat(20000);
	const { run } = setup(() => stream(toolMessage(++calls, calls === 9 ? large : "")));
	const updates: unknown[] = [];
	const result = await run({ agent: "scout", task: "loop" }, undefined, (update) => updates.push(update));
	const first = (result.details as { results: { outputFile?: string }[] }).results[0]!;
	assert.ok(first.outputFile);
	try {
		const full = await readFile(first.outputFile, "utf8");
		assert.match(full, /Interrumpido por límite de turnos/); assert.ok(full.endsWith(large));
		assert.equal((await stat(first.outputFile)).mode & 0o777, 0o600);
		assert.ok(JSON.stringify(result).length < 15000);
		assert.ok(updates.every((update) => JSON.stringify(update).length < 15000));
	} finally { await rm(first.outputFile.replace(/\/output.txt$/, ""), { recursive: true, force: true }); }
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

// Errores del proveedor: un turno con error no corrió sus tools, así que se puede pedir de nuevo desde el mismo contexto.
function failure(errorMessage: string): AssistantMessage {
	return { ...message(""), content: [], stopReason: "error", errorMessage };
}
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise(setImmediate); }
	assert.fail(`No ocurrió: ${what}`);
}
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await new Promise(setImmediate); }
type Outcome = { results: { status: string; turns: number; output: string; activity: string }[] };

test("subagent: un error transitorio se reintenta a los 2 s desde el último resultado, sin repetir tools", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const contexts: string[] = []; let calls = 0;
	const { run, seen } = setup((context) => {
		calls++; contexts.push(JSON.stringify(context.messages));
		if (calls === 1) return stream(toolMessage(1));
		if (calls === 2) return stream(failure("Our servers are currently overloaded"));
		return stream(message("Listo: cambio verificado."));
	});
	const pending = run({ agent: "worker", task: "implement" });
	await until(() => calls === 2, "el turno con error"); await settle();
	t.mock.timers.tick(1999); await settle();
	assert.equal(calls, 2, "no reintenta antes de 2 s");
	t.mock.timers.tick(1);
	const result = await pending;
	const first = (result.details as Outcome).results[0]!;
	assert.equal(calls, 3); assert.deepEqual(seen, ["read"], "la tool del primer turno corre una sola vez");
	assert.equal(result.isError, false); assert.equal(first.status, "done");
	assert.equal(first.output, "Listo: cambio verificado.");
	assert.equal(first.turns, 2, "el turno fallido que se reintenta no cuenta");
	assert.equal(contexts[2], contexts[1], "el reintento sigue del mismo contexto, sin el mensaje con error");
	assert.equal(result.usage?.totalTokens, 36, "el uso suma también el turno fallido");
});

test("subagent: cuota o autenticación no se reintentan y el error conserva lo recuperado", async () => {
	for (const error of ["429 insufficient_quota: You exceeded your current quota", "401 Unauthorized"]) {
		let calls = 0;
		const { run } = setup(() => {
			calls++;
			if (calls === 1) return stream(toolMessage(1, "Avance: leí src/auth.ts."));
			if (calls === 2) return stream(failure(error));
			throw new Error("No reintenta un error que no es transitorio");
		});
		const result = await run({ agent: "worker", task: "x" });
		const first = (result.details as Outcome).results[0]!;
		assert.equal(calls, 2, error); assert.equal(result.isError, true); assert.equal(first.status, "error");
		assert.equal(first.output, `### Interrupción\nInterrumpido por un error del proveedor: ${error}. Revisar archivos y verificaciones antes de continuar.\n\n### Información recuperada\nAvance: leí src/auth.ts.`);
	}
});

for (const cut of ["Esc", "10 minutos"] as const) test(`subagent: ${cut} durante la espera del reintento corta sin otra llamada`, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0; const controller = new AbortController(); const activities: string[] = [];
	const { run } = setup(() => { calls++; return stream(failure("Unable to connect. Is the computer able to access the url?")); });
	const pending = run({ agent: "scout", task: "x" }, controller.signal, (update) => activities.push(...(update as { details: Outcome }).details.results.map((r) => r.activity)));
	await until(() => activities.includes("reintento 1/3"), "el aviso del reintento"); await settle();
	if (cut === "Esc") controller.abort(); else t.mock.timers.tick(10 * 60_000);
	const result = await pending;
	assert.equal(calls, 1); assert.equal(result.isError, true);
	assert.equal((result.details as Outcome).results[0]!.output, cut === "Esc" ? "Subagente cancelado." : "Subagente: límite de 10 minutos.");
});

test("subagent: agotados 3 reintentos (2, 4 y 8 s) devuelve la interrupción con lo recuperado", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const errors = ["Our servers are currently overloaded", "Unable to connect", "529 Overloaded", "Our servers are currently overloaded.\n{\"type\":\"overloaded_error\"}"];
	const { run, seen } = setup(() => ++calls === 1 ? stream(toolMessage(1, "Parcial útil: falta verificar.")) : stream(failure(errors[calls - 2]!)));
	const pending = run({ agent: "worker", task: "x" });
	for (const [index, delay] of [2000, 4000, 8000].entries()) {
		await until(() => calls === index + 2, `el error ${index + 1}`); await settle();
		t.mock.timers.tick(delay - 1); await settle();
		assert.equal(calls, index + 2, `no reintenta antes de ${delay} ms`);
		t.mock.timers.tick(1);
	}
	const result = await pending;
	const first = (result.details as Outcome).results[0]!;
	assert.equal(calls, 5, "el pedido inicial y 3 reintentos"); assert.deepEqual(seen, ["read"]);
	assert.equal(result.isError, true); assert.equal(first.status, "error"); assert.equal(first.turns, 2);
	assert.equal(first.output, "### Interrupción\nInterrumpido por un error del proveedor tras 3 reintentos: Our servers are currently overloaded. Revisar archivos y verificaciones antes de continuar.\n\n### Información recuperada\nParcial útil: falta verificar.");
	assert.equal(result.usage?.totalTokens, 60, "el uso suma todos los pedidos");
});

test("subagent: agotados los reintentos sin texto recuperable lo dice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const { run } = setup(() => ++calls === 1 ? stream(toolMessage(1)) : stream(failure("Unable to connect")));
	const pending = run({ agent: "worker", task: "x" });
	for (const [index, delay] of [2000, 4000, 8000].entries()) {
		await until(() => calls === index + 2, `el error ${index + 1}`); await settle();
		t.mock.timers.tick(delay);
	}
	const result = await pending;
	assert.equal(calls, 5);
	assert.equal((result.details as Outcome).results[0]!.output, "Interrumpido por un error del proveedor tras 3 reintentos: Unable to connect; sin resumen recuperable; revisar archivos y verificaciones antes de continuar");
});

test("subagent: el turno reintentado no cuenta para el límite y el cierre reservado sigue en el turno 32", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const { run, seen } = setup((context) => {
		calls++;
		if (calls === 31) return stream(failure("Our servers are currently overloaded"));
		if (context.messages.filter((m) => m.role === "user").length === 2) return stream(message("Avances: parcial. Archivos: src/a.ts. Verificaciones: ninguna. Pendientes: probar."));
		return stream(toolMessage(calls));
	});
	const pending = run({ agent: "worker", task: "loop" });
	await until(() => calls === 31, "el turno 31 con error"); await settle();
	t.mock.timers.tick(2000);
	const result = await pending;
	const first = (result.details as Outcome).results[0]!;
	assert.equal(calls, 33, "30 turnos con tools, el error, el turno 31 reintentado y el cierre");
	assert.equal(seen.length, 31); assert.equal(first.turns, 32);
	assert.match(first.output, /Interrumpido por límite de turnos/); assert.match(first.output, /### Información recuperada\nAvances: parcial\. Archivos: src\/a\.ts/);
});
