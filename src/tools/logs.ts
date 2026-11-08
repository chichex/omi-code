// omi_logs_tail y omi_crash_logs: lo que el agente necesita para diagnosticar solo.

import { Type } from "typebox";
import { readSse } from "../client/sse.ts";
import { InstanceLogDetailSchema, InstanceLogsSchema } from "../client/views.ts";
import { OmiError } from "../core/errors.ts";
import { environmentPath, linkedService, openScope, readService, environmentOf, type Scope } from "./scope.ts";
import { defineTool, type ToolRuntime } from "./types.ts";

const DEFAULT_LINES = 200;
const MAX_LINES = 5_000;
const DEFAULT_DURATION_SECONDS = 30;
/** omi-api cierra el stream a los 30 minutos. */
const MAX_DURATION_SECONDS = 1_800;
const AGENT_STATES = ["attached", "waiting", "busy"];

const Target = {
	service: Type.Optional(Type.String()),
	environment: Type.Union([Type.Literal("stage"), Type.Literal("prod")]),
};

interface TailResult {
	lines: string[];
	stopped: "lines" | "duration" | "closed" | "error";
	agent: string;
	error?: string;
}

/** Acumula sobre `result`: si el tiempo corta la lectura, lo leído no se pierde. */
async function collectLines(scope: Scope, path: string, limit: number, signal: AbortSignal, result: TailResult, runtime: ToolRuntime): Promise<void> {
	const response = await scope.client.stream(path, signal);
	if (response.body === null) return;
	for await (const frame of readSse(response.body)) {
		if (frame.event === "stream-error") {
			result.stopped = "error";
			result.error = frame.data;
			return;
		}
		if (frame.event !== undefined) {
			if (AGENT_STATES.includes(frame.event)) result.agent = frame.event;
			continue;
		}
		result.lines.push(frame.data);
		runtime.progress?.(frame.data);
		if (result.lines.length >= limit) {
			result.stopped = "lines";
			return;
		}
	}
}

export const logsTailTool = defineTool({
	name: "omi_logs_tail",
	label: "OMI: logs en vivo",
	description: "Lee los logs en vivo de un ambiente hasta juntar cierta cantidad de líneas o cumplir una duración. Arranca con las últimas 100 líneas.",
	parameters: Type.Object({
		...Target,
		lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })),
		durationSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_DURATION_SECONDS })),
	}),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		environmentOf(await readService(scope, service.name), params.environment);
		const path = `${environmentPath(scope, service.name, params.environment)}/logs`;
		const limit = params.lines ?? DEFAULT_LINES;
		const expired = AbortSignal.timeout((params.durationSeconds ?? DEFAULT_DURATION_SECONDS) * 1_000);
		const signal = runtime.signal === undefined ? expired : AbortSignal.any([expired, runtime.signal]);
		const result: TailResult = { lines: [], stopped: "closed", agent: "waiting" };
		try {
			await collectLines(scope, path, limit, signal, result, runtime);
		} catch (error) {
			if (!expired.aborted) throw error;
			// El límite de tiempo es un corte esperado: devuelve lo leído hasta acá.
			result.stopped = "duration";
		}
		const text = [...result.lines, ...(result.error === undefined ? [] : [`stream cortado: ${result.error}`])].join("\n");
		return { text: text || "Sin líneas en el período", data: result, ...(result.stopped === "error" ? { failed: true } : {}) };
	},
});

export const crashLogsTool = defineTool({
	name: "omi_crash_logs",
	label: "OMI: crash logs",
	description: "Recupera hasta 1.000 líneas capturadas de instancias caídas o deploys fallidos. Sin id, trae la captura más reciente.",
	parameters: Type.Object({
		...Target,
		instanceLogId: Type.Optional(Type.String({ description: "ilog_...: sale de instance_log_id de un deploy fallido" })),
		deploymentId: Type.Optional(Type.String()),
	}),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const path = `${environmentPath(scope, service.name, params.environment)}/instance-logs`;
		const { instance_logs: captures } = await scope.client.request("GET", path, InstanceLogsSchema);
		const chosen = captures.find((capture) => {
			if (params.instanceLogId !== undefined) return capture.id === params.instanceLogId;
			return params.deploymentId === undefined || capture.deployment_id === params.deploymentId;
		});
		if (chosen === undefined) {
			if (params.instanceLogId !== undefined) throw new OmiError("instance_log_not_found", `no existe la captura ${params.instanceLogId}`);
			return { text: `Sin capturas en ${params.environment}: se guardan 7 días`, data: { captures, logs: [] } };
		}
		const detail = await scope.client.request("GET", `${path}/${encodeURIComponent(chosen.id)}`, InstanceLogDetailSchema);
		return {
			text: [`${detail.id} · ${detail.pod}/${detail.container} · ${detail.reason} · ${detail.finished_at}`, ...detail.lines].join("\n"),
			data: { captures, logs: [detail] },
		};
	},
});
