// Session-scoped delegation. Background is the default in persistent sessions; explicit
// background:false retains dependency/chain workflows. No raw delegated tool is executed.
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateHead, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, executeSubagent, paramsSchema, prepare, type Details, type Params } from "./subagent-runner.ts";
import { backgroundDispatcher, taskPool } from "./subagent-background.ts";

interface Job {
	id: string;
	controller: AbortController;
	details: Details;
	result?: AgentToolResult<Details> & { isError?: boolean };
	promise?: Promise<void>;
	reported: boolean;
	notify: boolean;
	/** Terminó con el agente corriendo: su aviso espera al cierre del turno. */
	pending?: boolean;
}
function textResult<T>(text: string, details: T): AgentToolResult<T>;
function textResult(text: string): AgentToolResult<unknown>;
function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> { return { content: [{ type: "text", text }], details }; }
const snapshot = (details: Details) => ({ mode: details.mode, results: details.results.map(({ agent, status, turns, activity }) => ({ agent, status, turns, activity })) });
const jobState = (job: Job): string => job.result ? job.result.isError ? "error" : "done" : job.controller.signal.aborted ? "cancelando" : "running";
const jobSummary = (job: Job): string => `${job.id} · ${jobState(job)}\n${job.details.results.map((r) => `  ${r.agent} · ${r.status}${r.activity ? ` · ${r.activity}` : ""}`).join("\n")}`;

export function subagentsExtension(): InlineExtension {
	return { name: "omi-subagents", builtin: true, replaceable: true, factory(pi) {
		const schedule = taskPool();
		const makeBackgroundContext = backgroundDispatcher(pi);
		const jobs = new Map<string, Job>();
		const foreground = new Map<string, AbortController>();
		let alive = true; let generation = 0;
		// Un aviso encolado durante la corrida llegaba aunque el modelo ya hubiera leído el resultado, y cada
		// uno abría otro turno (en el #69, 16 avisos viejos: 38 llamadas). Esperan al cierre del turno, van
		// juntos y se descartan si el resultado ya se leyó.
		let running = false;
		const take = (): Job[] => {
			const ready = [...jobs.values()].filter((job) => job.pending && job.notify && job.result && !job.reported);
			for (const job of jobs.values()) job.pending = false;
			for (const job of ready) job.notify = false;
			return ready;
		};
		const notice = (ready: readonly Job[]) => ({
			customType: "omi-subagent-done", display: true, details: { jobIds: ready.map((job) => job.id) },
			content: ready.length === 1
				? `Subagente ${ready[0]!.id}: ${jobState(ready[0]!)}. Obtené el resultado y su uso con subagent action:result id:${ready[0]!.id}.`
				: `Subagentes terminados: ${ready.map((job) => `${job.id} (${jobState(job)})`).join(", ")}. Obtené cada resultado y su uso con subagent action:result y su id.`,
		});
		const announce = () => { const ready = take(); if (ready.length) pi.sendMessage(notice(ready), { triggerTurn: true, deliverAs: "followUp" }); };
		const emit = (phase: "start" | "update" | "end", id: string, details: Details, args?: Params, isError?: boolean) => {
			if (alive) pi.events.emit("omi:subagents", { phase, id, details: snapshot(details), ...(args ? { args } : {}), ...(isError === undefined ? {} : { isError }) });
		};
		const cancel = (id: string): boolean => {
			const job = jobs.get(id);
			const targets = id === "all" ? [...jobs.values()].filter((job) => !job.result).map((job) => job.controller).concat([...foreground.values()]) : [job && !job.result ? job.controller : foreground.get(id)].filter((c): c is AbortController => !!c);
			for (const controller of targets) controller.abort();
			return targets.length > 0;
		};
		const unsubscribe = pi.events.on("omi:subagents:cancel", (value: unknown) => {
			if (alive && value && typeof value === "object" && "id" in value && typeof value.id === "string") cancel(value.id);
		});
		const stop = () => {
			generation++;
			for (const job of jobs.values()) { job.notify = false; if (!job.result) job.controller.abort(); }
			for (const controller of foreground.values()) controller.abort();
		};
		pi.on("session_tree", () => { stop(); jobs.clear(); });
		pi.on("agent_start", () => { running = true; });
		pi.on("agent_before_settle", (event) => {
			if (!alive || event.outcome !== "completed") return;
			const ready = take();
			if (!ready.length) return;
			return { entries: [...event.entries, { type: "custom_message" as const, ...notice(ready) }], continue: true };
		});
		// Con Esc no se relanza nada: el aviso queda para el cierre de la próxima corrida.
		pi.on("agent_settled", (event) => { running = false; if (alive && !event?.aborted) announce(); });
		pi.on("session_shutdown", async () => {
			alive = false; stop(); unsubscribe();
			// Give cooperative streams time to close before the extension runtime is discarded.
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([Promise.allSettled([...jobs.values()].map((job) => job.promise)), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); timer.unref(); })]);
			if (timer) clearTimeout(timer);
			jobs.clear();
		});

		pi.registerTool({
			name: "subagent", label: "Subagentes", exposure: "model-only", executionMode: "sequential",
			description: "Delegá tareas con contexto independiente. Roles: scout, planner, reviewer (sólo read/grep/find/ls), worker (tools del padre con hooks/confirmaciones). Un modo: agent+task, tasks (paralelo) o chain ({previous}). En TUI/RPC corre en BACKGROUND por defecto: devuelve ID inmediatamente, podés seguir conversando y avisa al terminar. background:false espera el resultado (por defecto en print/json). action:status lista progreso; action:result + id obtiene el resultado SIN ESPERAR y contabiliza uso una sola vez; action:cancel + id (o all) solicita cancelación. Hasta 4 lotes de background, 8 tareas/lote, 4 tareas activas globales, 32 turnos y 10 minutos/tarea. Salida 6 KB/200 líneas por tarea, resto en archivo privado. Al cerrar/cambiar sesión o navegar el árbol se cancelan los trabajos, no son jobs persistentes. Mismo filesystem: no es un sandbox.",
			promptSnippet: "Delegar tareas en segundo plano, consultar resultados y cancelar subagentes",
			promptGuidelines: [
				"Usá subagent en background para trabajo independiente y seguí atendiendo al usuario; no esperes ni hagas polling continuo. Al recibir el aviso de finalización usá subagent action:result con su id para incorporar resultado y uso.",
				"Usá subagent background:false sólo si necesitás el resultado antes de continuar. Pasá contexto explícito y no asignes los mismos archivos a workers en paralelo ni los edites mientras un worker trabaja en ellos.",
			],
			parameters: paramsSchema,
			async execute(id, params, signal, onUpdate, ctx) {
				const action = params.action ?? "run";
				if (action !== "run") {
					if (params.agent !== undefined || params.task !== undefined || params.tasks !== undefined || params.chain !== undefined || params.background !== undefined) throw new Error("Las acciones status/result/cancel no reciben tareas ni background.");
					if (action === "status" && !params.id) return textResult([...jobs.values()].map(jobSummary).join("\n\n") || "Sin trabajos de background.");
					if (!params.id) throw new Error("Indicá el id del trabajo.");
					if (action === "cancel") return { ...textResult(cancel(params.id) ? "Cancelación solicitada. No revierte cambios ni operaciones ya ejecutadas." : "No se encontró un trabajo activo con ese id."), isError: !jobs.has(params.id) && !foreground.has(params.id) && params.id !== "all" };
					const job = jobs.get(params.id);
					if (!job) throw new Error("Trabajo no encontrado en esta sesión.");
					if (action === "status" || !job.result) return textResult(jobSummary(job), { jobId: job.id, background: true, ...snapshot(job.details) });
					const result = { ...job.result, details: { ...job.result.details, jobId: job.id, background: true } };
					if (job.reported) delete result.usage;
					job.reported = true;
					return result;
				}
				if (params.id !== undefined) throw new Error("id sólo se usa con status/result/cancel.");
				params = structuredClone(params); // Detached jobs must not retain mutable model-call arguments.
				const { details } = prepare(params, ctx);
				const background = params.background ?? (ctx.mode === "tui" || ctx.mode === "rpc");
				if (background && ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Background requiere una sesión TUI/RPC persistente; usá background:false en print/json.");
				if (signal?.aborted && background) throw new Error("Delegación cancelada antes de comenzar.");
				if (!background) {
					const controller = new AbortController(); const abort = () => controller.abort();
					if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); foreground.set(id, controller);
					emit("start", id, details, params);
					try {
						const result = await executeSubagent(params, ctx, controller.signal, (update) => { emit("update", id, update.details); onUpdate?.(update); }, schedule);
						emit("end", id, result.details, undefined, result.isError); return result;
					} catch (error) { emit("end", id, details, undefined, true); throw error; }
					finally { signal?.removeEventListener("abort", abort); foreground.delete(id); }
				}
				if ([...jobs.values()].filter((job) => !job.result).length >= 4) throw new Error("Ya hay 4 lotes de background; esperá un aviso o cancelá uno antes de lanzar otro.");
				// Don't discard uncollected usage/results to make room for new work.
				for (const [key, job] of jobs) if (jobs.size >= 8 && job.result && job.reported) jobs.delete(key);
				if (jobs.size >= 8) throw new Error("Leé los resultados terminados con action:result antes de lanzar más trabajos.");
				const nestedUsage = emptyUsage();
				const context = makeBackgroundContext(ctx, (result) => { if (result.usage) addUsage(nestedUsage, result.usage); });
				const job: Job = { id: `bg-${randomUUID()}`, controller: new AbortController(), details, reported: false, notify: true };
				jobs.set(job.id, job); const epoch = generation;
				emit("start", job.id, details, params);
				job.promise = Promise.resolve().then(async () => {
					try {
						job.result = await executeSubagent(params, context, job.controller.signal, (update) => {
							job.details = update.details; if (generation === epoch) emit("update", job.id, update.details);
						}, schedule);
					} catch (error) {
						for (const result of job.details.results) if (result.status === "pending" || result.status === "running") { result.status = "error"; result.activity = ""; result.output = "El ejecutor de background falló."; }
						job.result = { ...textResult(truncateHead(error instanceof Error ? error.message : "Falló el subagente", { maxBytes: 6000, maxLines: 200 }).content, job.details), isError: true, usage: emptyUsage() };
					}
					job.details = job.result.details;
					const usage = job.result.usage ?? emptyUsage(); addUsage(usage, nestedUsage); job.result.usage = usage;
					if (alive && generation === epoch) {
						emit("end", job.id, job.details, undefined, job.result.isError);
						pi.appendEntry("omi-subagent-usage", { id: job.id, status: jobState(job), usage });
						if (job.notify) { job.pending = true; if (!running) announce(); }
					}
				}).catch(() => { /* A failed notification must not become an unhandled rejection. Result remains collectible. */ });
				return textResult(`Trabajo ${job.id} iniciado en segundo plano. Seguí atendiendo al usuario: llegará un aviso al terminar. No esperes ni hagas polling.`, { jobId: job.id, background: true, ...snapshot(details) });
			},
		});
	} };
}
