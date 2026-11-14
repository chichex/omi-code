// omi_visibility_set: quién alcanza un ambiente. Publicarlo en internet siempre lo decide un humano.

import { Type } from "typebox";
import { EnvironmentSchema, type EnvironmentView } from "../client/views.ts";
import { OmiError } from "../core/errors.ts";
import { enforce } from "../guardrails/policy.ts";
import { environmentOf, environmentPath, linkedService, openScope, readService, type Scope } from "./scope.ts";
import { defineTool, type ToolRuntime } from "./types.ts";

/** Lease del job que reaplica el bundle del ambiente, con margen. */
const APPLY_DEADLINE_MS = 5 * 60_000;
const PUBLIC = "publico";

const REACH: Readonly<Record<string, string>> = {
	privado: "alcanzable sólo desde su propio namespace",
	organizacion: "alcanzable desde los services de la organización en el mismo ambiente",
};

const Parameters = Type.Object({
	service: Type.Optional(Type.String()),
	environment: Type.Union([Type.Literal("stage"), Type.Literal("prod")]),
	visibility: Type.Union([Type.Literal("privado"), Type.Literal("organizacion"), Type.Literal(PUBLIC)]),
});

/** OMI trata como pedido nuevo la misma visibilidad cuando el intento anterior quedó fallido. */
function needsRetry(environment: EnvironmentView): boolean {
	return environment.visibility_apply.state === "fallida" || environment.access.state === "fallido";
}

function describeChange(current: EnvironmentView, desired: string): string {
	const change = current.visibility === desired ? `${desired} (reintento)` : `${current.visibility} → ${desired}`;
	const exposure = desired === PUBLIC ? `publica ${current.hostname} en internet` : REACH[desired];
	const withdrawal = current.visibility === PUBLIC && desired !== PUBLIC ? [`retira ${current.hostname} de internet`] : [];
	return [`${current.name}: ${change}`, ...withdrawal, ...(exposure === undefined ? [] : [exposure])].join("\n");
}

function summarize(service: string, environment: EnvironmentView, previous: string) {
	return {
		service,
		environment: environment.name,
		visibility: environment.visibility,
		previous,
		hostname: environment.hostname,
		visibility_apply: environment.visibility_apply.state,
		access: environment.access.state,
	};
}

async function awaitApply(scope: Scope, service: string, updated: EnvironmentView, runtime: ToolRuntime): Promise<EnvironmentView> {
	const deadline = Date.now() + APPLY_DEADLINE_MS;
	let current = updated;
	while (current.visibility_apply.state === "aplicando") {
		if (Date.now() > deadline) {
			throw new OmiError("visibility_timeout", `la visibilidad de ${service} en ${updated.name} no terminó de aplicarse a tiempo`, { hint: "`omi status` muestra su estado" });
		}
		runtime.progress?.("visibilidad aplicando");
		await scope.client.wait(runtime.signal);
		current = environmentOf(await readService(scope, service), updated.name);
	}
	if (current.visibility_apply.state === "fallida") {
		throw new OmiError("visibility_apply_failed", `la visibilidad de ${service} en ${updated.name} no se aplicó: ${current.visibility_apply.last_error ?? "sin detalle"}`, {
			hint: "repetí la operación para reintentarla",
		});
	}
	return current;
}

export const visibilitySetTool = defineTool({
	name: "omi_visibility_set",
	label: "OMI: cambiar visibilidad",
	description:
		"Cambia la visibilidad de un ambiente: privado, organizacion o publico (su hostname queda en internet). Siempre pide confirmación humana, también en stage.",
	parameters: Parameters,
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const current = environmentOf(await readService(scope, service.name), params.environment);
		if (current.visibility === params.visibility && !needsRetry(current)) {
			return { text: `${service.name} en ${params.environment} ya es ${params.visibility}`, data: summarize(service.name, current, current.visibility) };
		}
		await enforce(
			{
				operation: "visibility",
				environment: params.environment,
				summary: `Visibilidad de ${service.name} en ${params.environment}`,
				diff: describeChange(current, params.visibility),
			},
			runtime.guard,
		);
		const updated = await scope.client.mutate("PUT", `${environmentPath(scope, service.name, params.environment)}/visibility`, EnvironmentSchema, {
			body: { visibility: params.visibility },
			projectPath: scope.projectPath,
			onQueued: (state) => runtime.progress?.(`cambio de visibilidad en cola: ${state}`),
			...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
		});
		const applied = await awaitApply(scope, service.name, updated, runtime);
		const data = summarize(service.name, applied, current.visibility);
		const change = current.visibility === applied.visibility ? `${applied.visibility} reaplicada` : `${current.visibility} → ${applied.visibility}`;
		return { text: `${service.name} en ${params.environment}: ${change} · acceso ${data.access}`, data };
	},
});
