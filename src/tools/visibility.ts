// omi_visibility_set: quién alcanza un ambiente. Publicarlo en internet siempre lo decide un humano.

import { Type } from "typebox";
import { EnvironmentSchema, type EnvironmentView } from "../client/views.ts";
import { OmiError } from "../core/errors.ts";
import { enforce } from "../guardrails/policy.ts";
import { environmentOf, environmentPath, linkedService, openScope, readService, type Scope } from "./scope.ts";
import { defineTool, type ToolResult, type ToolRuntime } from "./types.ts";

/** Lease del job que reaplica el bundle del ambiente, con margen. */
const APPLY_DEADLINE_MS = 5 * 60_000;
/**
 * El acceso lo deja listo un reconciliador de omi-api que pasa cada 30 s y trabaja en dos vueltas:
 * el bundle de ingress en el agente (hasta 120 s) y la publicación en Cloudflare. Lo normal son 1 a 3 min.
 */
const ACCESS_DEADLINE_MS = 5 * 60_000;
const PUBLIC = "publico";
const STATUS_HINT = "`omi status` muestra la visibilidad y el acceso de cada ambiente";

const REACH: Readonly<Record<string, string>> = {
	privado: "alcanzable sólo desde su propio namespace",
	organizacion: "alcanzable desde los services de la organización en el mismo ambiente",
};

const Parameters = Type.Object({
	service: Type.Optional(Type.String()),
	environment: Type.Union([Type.Literal("stage"), Type.Literal("prod")]),
	visibility: Type.Union([Type.Literal("privado"), Type.Literal("organizacion"), Type.Literal(PUBLIC)]),
});

/** Un ambiente de una omi-api que informa el bundle de visibilidad: esta tool no opera sin él. */
type Environment = EnvironmentView & { visibility_apply: NonNullable<EnvironmentView["visibility_apply"]> };

interface Target {
	scope: Scope;
	service: string;
	environment: string;
	runtime: ToolRuntime;
}

function withApply(environment: EnvironmentView): Environment {
	if (environment.visibility_apply === undefined) {
		throw new OmiError("unexpected_response", `respuesta inesperada de OMI: el ambiente ${environment.name} no informa visibility_apply`, {
			hint: "puede ser una versión de omi-api incompatible: corré `omi upgrade`",
		});
	}
	return { ...environment, visibility_apply: environment.visibility_apply };
}

async function readEnvironment(target: Target): Promise<Environment> {
	return withApply(environmentOf(await readService(target.scope, target.service), target.environment));
}

/**
 * omi-api sólo trata la misma visibilidad como pedido nuevo si falló el bundle o si quedó un cambio
 * deshecho para reintentar. Ese reintento no viaja en la vista: se nota en que el acceso fallido no
 * trae `retry_at`, que es la hora del reintento automático del reconciliador.
 */
function needsRetry(environment: Environment): boolean {
	return environment.visibility_apply.state === "fallida" || (environment.access.state === "fallido" && environment.access.retry_at === undefined);
}

function describeChange(current: Environment, desired: string): string {
	const change = current.visibility === desired ? `${desired} (reintento)` : `${current.visibility} → ${desired}`;
	const exposure = desired === PUBLIC ? `publica ${current.hostname} en internet` : REACH[desired];
	const withdrawal = current.visibility === PUBLIC && desired !== PUBLIC ? [`retira ${current.hostname} de internet`] : [];
	return [`${current.name}: ${change}`, ...withdrawal, ...(exposure === undefined ? [] : [exposure])].join("\n");
}

/** Espera a que el bundle de visibilidad en curso termine, bien o mal. */
async function awaitApply(target: Target, from: Environment): Promise<Environment> {
	const deadline = Date.now() + APPLY_DEADLINE_MS;
	let current = from;
	while (current.visibility_apply.state === "aplicando") {
		if (Date.now() > deadline) {
			throw new OmiError("visibility_timeout", `la visibilidad de ${target.service} en ${target.environment} no terminó de aplicarse a tiempo`, { hint: STATUS_HINT });
		}
		target.runtime.progress?.("visibilidad aplicando");
		await target.scope.client.wait(target.runtime.signal);
		current = await readEnvironment(target);
	}
	return current;
}

function assertApplied(target: Target, environment: Environment): void {
	if (environment.visibility_apply.state !== "fallida") return;
	throw new OmiError(
		"visibility_apply_failed",
		`la visibilidad de ${target.service} en ${target.environment} no se aplicó: ${environment.visibility_apply.last_error ?? "sin detalle"}`,
		{ hint: "repetí la operación para reintentarla" },
	);
}

/** Sin versión desplegada el reconciliador no toma el ambiente: no hay nada que esperar. */
function accessSettled(environment: Environment): boolean {
	return environment.current_version === undefined || environment.access.state === "listo" || environment.access.state === "fallido";
}

/** Espera al reconciliador de acceso. Si no llega a tiempo devuelve el último estado: lo informa quien llama. */
async function awaitAccess(target: Target, from: Environment): Promise<Environment> {
	const deadline = Date.now() + ACCESS_DEADLINE_MS;
	let current = from;
	let reported = "";
	while (!accessSettled(current) && Date.now() <= deadline) {
		if (current.access.state !== reported) target.runtime.progress?.(`acceso ${current.access.state}`);
		reported = current.access.state;
		await target.scope.client.wait(target.runtime.signal);
		current = await readEnvironment(target);
	}
	return current;
}

/** Lo que falta para que el ambiente sea alcanzable, o undefined si el acceso quedó listo. */
function accessGap(environment: Environment): { text: string; failed: boolean } | undefined {
	const { state, last_error: lastError, retry_at: retryAt } = environment.access;
	if (environment.current_version === undefined) {
		return { text: `acceso ${state}: sin versión desplegada, el hostname se publica con el primer deploy`, failed: false };
	}
	if (state === "listo") return undefined;
	if (state === "fallido") {
		const retry = retryAt === undefined ? "" : `. OMI lo reintenta solo (próximo intento: ${retryAt})`;
		return { text: `el acceso falló: ${lastError ?? "sin detalle"}${retry}\n${STATUS_HINT}`, failed: true };
	}
	return { text: `el acceso sigue ${state} y no quedó listo a tiempo\n${STATUS_HINT}`, failed: true };
}

function report(target: Target, environment: Environment, previous: string, headline: string): ToolResult {
	const gap = accessGap(environment);
	const data = {
		service: target.service,
		environment: environment.name,
		visibility: environment.visibility,
		previous,
		hostname: environment.hostname,
		visibility_apply: environment.visibility_apply.state,
		access: environment.access.state,
		access_ready: environment.access.state === "listo",
		...(environment.access.last_error === undefined ? {} : { access_error: environment.access.last_error }),
		...(environment.access.retry_at === undefined ? {} : { access_retry_at: environment.access.retry_at }),
	};
	const text = `${target.service} en ${environment.name}: ${headline} · ${gap?.text ?? "acceso listo"}`;
	return gap?.failed === true ? { text, data, failed: true } : { text, data };
}

export const visibilitySetTool = defineTool({
	name: "omi_visibility_set",
	label: "OMI: cambiar visibilidad",
	description:
		"Cambia la visibilidad de un ambiente: privado, organizacion o publico (su hostname queda en internet). Siempre pide confirmación humana, también en stage. Espera a que el cambio se aplique y a que el acceso quede listo; si el acceso falla o no llega a tiempo, el resultado sale fallido.",
	parameters: Parameters,
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const target: Target = { scope, service: linkedService(scope.link, params.service).name, environment: params.environment, runtime };
		// Con un cambio en curso la visibilidad leída todavía puede ser la anterior: se decide sobre el estado final.
		const current = await awaitApply(target, await readEnvironment(target));
		if (current.visibility === params.visibility && !needsRetry(current)) {
			return report(target, await awaitAccess(target, current), current.visibility, `ya es ${params.visibility}`);
		}
		await enforce(
			{
				operation: "visibility",
				environment: params.environment,
				summary: `Visibilidad de ${target.service} en ${params.environment}`,
				diff: describeChange(current, params.visibility),
			},
			runtime.guard,
		);
		const updated = await scope.client.mutate("PUT", `${environmentPath(scope, target.service, params.environment)}/visibility`, EnvironmentSchema, {
			body: { visibility: params.visibility },
			projectPath: scope.projectPath,
			onQueued: (state) => runtime.progress?.(`cambio de visibilidad en cola: ${state}`),
			...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
		});
		const applied = await awaitApply(target, withApply(updated));
		assertApplied(target, applied);
		const settled = await awaitAccess(target, applied);
		if (current.visibility !== settled.visibility) return report(target, settled, current.visibility, `${current.visibility} → ${settled.visibility}`);
		// Un reintento aceptado deja el acceso de cero: si sigue fallido sin reintento propio, omi-api no hizo nada.
		const ignored = settled.access.state === "fallido" && settled.access.retry_at === undefined;
		return report(target, settled, current.visibility, ignored ? `ya es ${settled.visibility}` : `${settled.visibility} reaplicada`);
	},
});
