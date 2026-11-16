// Delegación con el Agent de Pi: contexto propio, pero tools por el pipeline de la sesión padre.
// No crea procesos, no relee ~/.pi ni vuelve a cargar extensiones/credenciales. No es un sandbox.
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateHead, type ExtensionToolContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const ROLES = {
	scout: "Explorá el código y devolvé contexto comprimido con rutas y hallazgos verificables. No implementes cambios.",
	planner: "Diseñá un plan de implementación con pasos, riesgos y pruebas. Inspeccioná el código; no implementes cambios.",
	reviewer: "Revisá el código buscando bugs y regresiones. Reportá hallazgos concretos con rutas y líneas; no modifiques archivos.",
	worker: "Implementá la tarea delegada, verificá los cambios y devolvé un resumen con archivos y pruebas. No hagas trabajo ajeno a la tarea.",
} as const;
type Role = keyof typeof ROLES;
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TURNS = 32;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_BYTES = 6000; // 8 resultados + encabezados quedan debajo de 50 KiB.

const taskSchema = Type.Object({
	agent: Type.Union([Type.Literal("scout"), Type.Literal("planner"), Type.Literal("reviewer"), Type.Literal("worker")]),
	task: Type.String({ minLength: 1, maxLength: 16384 }),
});
const paramsSchema = Type.Object({
	agent: Type.Optional(taskSchema.properties.agent),
	task: Type.Optional(taskSchema.properties.task),
	tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS, description: "Tareas en paralelo; máximo 4 activas. No asignar los mismos archivos a varios workers." })),
	chain: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS, description: "Pasos secuenciales; {previous} recibe la salida del paso anterior. Se detiene ante un error." })),
});
type Params = Static<typeof paramsSchema>;
type Task = Static<typeof taskSchema>;
interface TaskResult {
	agent: Role;
	status: "pending" | "running" | "done" | "error";
	turns: number;
	activity: string;
	output: string;
	outputFile?: string;
	usage: Usage;
}
interface Details {
	mode: "single" | "parallel" | "chain";
	results: TaskResult[];
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function addUsage(total: Usage, usage: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
}
function summary(results: readonly TaskResult[]): string {
	return results.map((r) => `[${r.agent}] ${r.status} · ${r.turns} turnos${r.activity ? ` · ${r.activity}` : ""}`).join("\n");
}
async function boundedOutput(text: string): Promise<{ output: string; outputFile?: string }> {
	const truncated = truncateHead(text, { maxBytes: OUTPUT_BYTES, maxLines: 200 });
	if (!truncated.truncated) return { output: text };
	try {
		const dir = await mkdtemp(join(tmpdir(), "omi-subagent-"));
		const outputFile = join(dir, "output.txt");
		await writeFile(outputFile, text, { mode: 0o600 });
		return { output: `${truncated.content}\n[Salida truncada. Completa en ${outputFile}]`, outputFile };
	} catch {
		return { output: `${truncated.content}\n[Salida truncada. No se pudo guardar el resultado completo en el directorio temporal.]` };
	}
}

/** No ejecutar la implementación cruda: executeTool conserva validación, hooks, cwd y confirmaciones. */
function delegatedTools(ctx: ExtensionToolContext, role: Role): AgentTool[] {
	return ctx.tools.filter((tool) => role === "worker" ? tool.name !== "subagent" : READ_TOOLS.has(tool.name))
		// No delegar orquestadores: podrían alcanzar tools no incluidas o crear delegación recursiva.
		.filter((tool) => !["codemode", "tool_search"].includes(tool.name))
		.map((tool) => ({
			...tool,
			async execute(_id, args, signal, onUpdate) {
				const outcome = await ctx.executeTool(tool.name, args, { ...(signal ? { signal } : {}), ...(onUpdate ? { onUpdate } : {}) });
				return { ...outcome.result, isError: outcome.isError };
			},
		}));
}

async function runTask(task: Task, result: TaskResult, ctx: ExtensionToolContext, signal: AbortSignal, update: () => void): Promise<void> {
	if (signal.aborted) {
		result.status = "error"; result.output = "Subagente cancelado."; update(); return;
	}
	result.status = "running"; update();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Subagente: límite de 10 minutos.")), TIMEOUT_MS);
	let limitReached = false;
	let failed = false;
	const agent = new Agent({
		sessionId: randomUUID(),
		initialState: {
			model: ctx.model!, thinkingLevel: ctx.thinkingLevel ?? "off",
			systemPrompt: `${ctx.getSystemPrompt()}\n\n<delegated_task>\nSos el subagente ${task.agent} de OMI. ${ROLES[task.agent]}\nTu contexto es independiente: sólo recibís esta tarea, no la conversación del padre.\nTrabajás en ${ctx.cwd}. Usá únicamente las tools declaradas para esta tarea. No delegues a otros agentes.\n</delegated_task>`,
			tools: delegatedTools(ctx, task.agent),
		},
		// Usa el modelo, proveedor (incluso custom) y auth resueltos del padre; no API keys del shell.
		streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
		finishTurn({ message }) {
			if (result.turns >= MAX_TURNS && message.stopReason === "toolUse") {
				limitReached = true;
				return { action: "end" };
			}
		},
	});
	const cancel = () => agent.abort();
	controller.signal.addEventListener("abort", cancel, { once: true });
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			result.turns++;
			addUsage(result.usage, message.usage);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				failed = true; result.status = "error";
				result.output = message.errorMessage || `Subagente: ${message.stopReason}`;
			} else {
				result.output = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			}
			update();
		} else if (event.type === "tool_execution_start") {
			result.activity = event.toolName; update();
		}
	});
	try {
		if (!controller.signal.aborted) await agent.prompt(task.task);
		if (controller.signal.aborted) {
			result.status = "error";
			result.output = signal.aborted ? "Subagente cancelado." : "Subagente: límite de 10 minutos.";
		} else if (limitReached) {
			result.status = "error"; result.output = `Subagente: límite de ${MAX_TURNS} turnos.`;
		} else if (!failed) {
			result.status = result.output.trim() ? "done" : "error";
			if (!result.output.trim()) result.output = "El subagente terminó sin respuesta.";
		}
	} catch (error) {
		result.status = "error"; result.output = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", cancel);
		unsubscribe();
	}
	Object.assign(result, await boundedOutput(result.output));
	result.activity = ""; update();
}

async function execute(params: Params, ctx: ExtensionToolContext, signal: AbortSignal, onUpdate?: AgentToolUpdateCallback<Details>): Promise<AgentToolResult<Details>> {
	const hasSingle = params.agent !== undefined || params.task !== undefined;
	if (Number(hasSingle) + Number(params.tasks !== undefined) + Number(params.chain !== undefined) !== 1 || (hasSingle && (!params.agent || !params.task?.trim()))) {
		throw new Error("Indicá exactamente un modo: agent + task, tasks o chain.");
	}
	const tasks = params.tasks ?? params.chain ?? [{ agent: params.agent!, task: params.task! }];
	if (tasks.length < 1 || tasks.length > MAX_TASKS || tasks.some((t) => !Object.hasOwn(ROLES, t.agent) || !t.task.trim())) throw new Error("Se requieren entre 1 y 8 tareas con un agente válido.");
	if (!ctx.model) throw new Error("Elegí un modelo autenticado antes de delegar.");
	const details: Details = {
		mode: params.tasks ? "parallel" : params.chain ? "chain" : "single",
		results: tasks.map((task) => ({ agent: task.agent, status: "pending", turns: 0, activity: "", output: "", usage: emptyUsage() })),
	};
	// Actualizaciones pequeñas e inmutables: no guardar el historial privado de cada subagente en la sesión padre.
	const update = () => onUpdate?.({ content: [{ type: "text", text: summary(details.results) }], details: {
		mode: details.mode,
		results: details.results.map((r) => ({ ...r, output: truncateHead(r.output, { maxBytes: OUTPUT_BYTES, maxLines: 200 }).content, usage: structuredClone(r.usage) })),
	} });
	if (params.tasks) {
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, async () => {
			while (next < tasks.length) {
				const index = next++;
				await runTask(tasks[index]!, details.results[index]!, ctx, signal, update);
			}
		}));
	} else {
		let previous = "";
		for (const [index, task] of tasks.entries()) {
			const result = details.results[index]!;
			await runTask({ ...task, task: params.chain ? task.task.replaceAll("{previous}", () => previous) : task.task }, result, ctx, signal, update);
			if (result.status === "error") break;
			previous = result.output;
		}
	}
	const usage = emptyUsage();
	for (const result of details.results) addUsage(usage, result.usage);
	return {
		content: [{ type: "text", text: details.results.map((r, index) => `### ${index + 1}. ${r.agent} · ${r.status}\n${r.output || "No ejecutado."}`).join("\n\n") }],
		details, usage, isError: details.results.some((r) => r.status !== "done"),
	};
}

export function subagentsExtension(): InlineExtension {
	return {
		name: "omi-subagents", builtin: true, replaceable: true,
		factory(pi) {
			const active = new Set<AbortController>();
			pi.on("session_shutdown", () => { for (const controller of active) controller.abort(); });
			pi.registerTool({
				name: "subagent", label: "Subagentes", exposure: "model-only", executionMode: "sequential",
				description: "Delegá tareas con contexto independiente al mismo modelo y razonamiento de la sesión. Agentes: scout (explora), planner (planifica), reviewer (revisa), worker (implementa). Los tres primeros sólo tienen read/grep/find/ls; worker usa las tools disponibles del padre con sus guardrails. Un modo: agent+task, tasks (paralelo) o chain ({previous}). Máximo 8 tareas, 4 simultáneas y 32 turnos; solicita cancelar a los 10 minutos por tarea. Devuelve hasta 6 KB/200 líneas por tarea y ruta al resultado completo si se trunca. Mismo cwd/filesystem: no es un sandbox.",
				promptSnippet: "Delegar exploración, planificación, revisión o implementación con contexto separado",
				promptGuidelines: ["Usá subagent para tareas autocontenidas; pasá el contexto necesario explícitamente. No asignes los mismos archivos a workers en paralelo."],
				parameters: paramsSchema,
				async execute(_id, params, signal, onUpdate, ctx) {
					const controller = new AbortController();
					const abort = () => controller.abort();
					if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
					active.add(controller);
					try { return await execute(params, ctx, controller.signal, onUpdate); }
					finally { signal?.removeEventListener("abort", abort); active.delete(controller); }
				},
			});
		},
	};
}
