// A background job outlives the launching tool call. Never retain its executeTool scope:
// Pi takes/clears that recorder on tool result and agent_end. Acquire a fresh ToolContext
// per delegated call instead, using our own context-only adapter. The actual target ALWAYS
// goes through ctx.executeTool (validation, user hooks and native confirmations).
import { randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DISPATCH_TOOL, type ScheduleTask } from "./subagent-runner.ts";

interface Dispatch {
	name: string;
	args: unknown;
	signal: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
}

export function backgroundDispatcher(pi: ExtensionAPI) {
	const tickets = new Map<string, Dispatch>();
	const charges = new Map<string, (result: AgentToolResult<unknown>) => void>();
	pi.on("tool_execution_end", (event) => {
		// Count each nested tool's OWN usage, including deeper tools. Pi's recorder no
		// longer has a live model-issued result to attach these background calls to.
		const root = event.parentToolCallId?.split("/")[0];
		if (root) charges.get(root)?.(event.result);
	});
	pi.registerTool({
		name: DISPATCH_TOOL, label: "Contexto de subagente", exposure: "deferred",
		description: "Adaptador interno de contextos. Sólo acepta tickets efímeros del ejecutor de subagentes; no invocar directamente.",
		parameters: Type.Object({ ticket: Type.String() }),
		async execute(_id, { ticket }, _signal, _onUpdate, ctx) {
			const call = tickets.get(ticket);
			if (!call) throw new Error("Ticket de subagente inexistente o consumido.");
			tickets.delete(ticket);
			const outcome = await ctx.executeTool(call.name, call.args, { signal: call.signal, ...(call.onUpdate ? { onUpdate: call.onUpdate } : {}) });
			return { ...outcome.result, isError: outcome.isError };
		},
	});
	return (ctx: ExtensionToolContext, onResult: (result: AgentToolResult<unknown>) => void): ExtensionToolContext => {
		const adapter = ctx.tools.find((tool) => tool.name === DISPATCH_TOOL);
		if (!adapter) throw new Error("El adaptador de tools de background no está disponible.");
		// Freeze the launch context, not the conversation or the launching tool's abort signal.
		const context = Object.create(ctx) as ExtensionToolContext;
		let calls = 0;
		Object.defineProperties(context, {
			model: { value: ctx.model }, thinkingLevel: { value: ctx.thinkingLevel }, cwd: { value: ctx.cwd },
			getSystemPrompt: { value: (() => { const prompt = ctx.getSystemPrompt(); return () => prompt; })() },
			tools: { value: [...ctx.tools] },
			executeTool: { value: async (name: string, args: unknown, options: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback } = {}) => {
				if (!options.signal) throw new Error("Una llamada de background necesita señal de cancelación propia.");
				if (++calls > 256) throw new Error("Subagente: límite de 256 llamadas delegadas por lote.");
				const ticket = randomUUID(); tickets.set(ticket, { name, args, signal: options.signal, ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}) });
				const scope = `omi-background-${randomUUID()}`; charges.set(scope, onResult);
				try {
					// Invoke ONLY our context adapter, never a raw delegated tool implementation.
					// A unique scope avoids reused nested-call IDs across parent turns/compaction.
					const result = await adapter.execute(scope, { ticket }, options.signal) as AgentToolResult<unknown> & { isError?: boolean };
					return { result, isError: result.isError === true };
				} finally { tickets.delete(ticket); charges.delete(scope); }
			} },
		});
		return context;
	};
}

/** One pool for foreground + all background batches, not four additional workers per call. */
export function taskPool(limit = 4): ScheduleTask {
	let active = 0;
	const queue: (() => void)[] = [];
	return (work, signal) => new Promise<void>((resolve, reject) => {
		let taken = false;
		const abort = () => {
			if (taken) return;
			taken = true;
			const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1);
			signal.removeEventListener("abort", abort);
			// runTask records cancellation without starting a model when already aborted.
			void work().then(resolve, reject);
		};
		const start = () => {
			if (taken) return;
			taken = true; signal.removeEventListener("abort", abort); active++;
			void work().then(resolve, reject).finally(() => { active--; queue.shift()?.(); });
		};
		if (signal.aborted) abort();
		else if (active < limit) start();
		else { queue.push(start); signal.addEventListener("abort", abort, { once: true }); }
	});
}
