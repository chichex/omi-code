// omi_env_list y omi_env_set. PUT reemplaza la lista completa: lo que no se manda, se borra.

import { Type } from "typebox";
import type { EnvironmentView, Variable } from "../client/views.ts";
import { EnvironmentSchema } from "../client/views.ts";
import { OmiError, UsageError } from "../core/errors.ts";
import { enforce } from "../guardrails/policy.ts";
import { ENV_PORT, RESERVED_ENV_PREFIX, RESOURCE_ENV_PREFIX } from "../protocol/constants.ts";
import { environmentOf, environmentPath, linkedService, openScope, readService } from "./scope.ts";
import { readSecretValue } from "./secrets.ts";
import { defineTool } from "./types.ts";

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_VARIABLES = 100;
const MAX_VALUE_BYTES = 32_768;

const EnvironmentParam = Type.Union([Type.Literal("stage"), Type.Literal("prod")]);

export function assertVariableName(name: string): void {
	if (!VARIABLE_NAME.test(name)) throw new UsageError(`nombre de variable inválido: ${name}`);
	if (name === ENV_PORT || name.startsWith(RESERVED_ENV_PREFIX)) throw new UsageError(`${name} la inyecta OMI`);
	if (name.startsWith(RESOURCE_ENV_PREFIX)) throw new UsageError(`${name} la gestiona un recurso de OMI`);
}

function describeVariable(variable: Variable): string {
	return variable.secret ? `${variable.name} (secreto)` : `${variable.name}=${variable.value ?? ""}`;
}

export interface VariableChange {
	set?: { name: string; value: string }[];
	unset?: string[];
	secrets?: { name: string; value: string }[];
}

export interface VariablePlan {
	next: Variable[];
	diff: string[];
	touchesSecrets: boolean;
}

/** Núcleo puro: cada secreto existente viaja con value null, que significa conservarlo. */
export function planVariables(current: readonly Variable[], change: VariableChange): VariablePlan {
	const byName = new Map(current.map((variable) => [variable.name, variable]));
	const diff: string[] = [];
	let touchesSecrets = false;
	for (const name of change.unset ?? []) {
		const previous = byName.get(name);
		if (previous === undefined) continue;
		byName.delete(name);
		touchesSecrets ||= previous.secret;
		diff.push(`- ${previous.secret ? `${name} (secreto)` : name}`);
	}
	for (const { name, value } of change.set ?? []) {
		const previous = byName.get(name);
		if (previous?.secret === true) {
			throw new OmiError("secret_requires_input", `${name} es un secreto: su valor no se pasa como parámetro`, {
				hint: "usá secrets con fromEnv, o `omi env set --secret` en una terminal",
			});
		}
		byName.set(name, { name, secret: false, value });
		if (previous === undefined) diff.push(`+ ${name}=${value}`);
		else if (previous.value !== value) diff.push(`~ ${name}: ${previous.value ?? ""} → ${value}`);
	}
	for (const { name, value } of change.secrets ?? []) {
		const previous = byName.get(name);
		byName.set(name, { name, secret: true, value });
		touchesSecrets = true;
		diff.push(previous?.secret === true ? `~ ${name} (secreto rotado)` : `+ ${name} (secreto)`);
	}
	const next = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	if (next.length > MAX_VARIABLES) throw new UsageError(`un ambiente admite hasta ${MAX_VARIABLES} variables`);
	return { next, diff, touchesSecrets };
}

function assertValueSize(name: string, value: string): void {
	if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new UsageError(`${name} supera ${MAX_VALUE_BYTES} bytes`);
}

export const envListTool = defineTool({
	name: "omi_env_list",
	label: "OMI: listar variables",
	description: "Lista las variables de un ambiente. Los secretos aparecen sólo por nombre: su valor no se puede leer.",
	parameters: Type.Object({ service: Type.Optional(Type.String()), environment: EnvironmentParam }),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const environment = environmentOf(await readService(scope, service.name), params.environment);
		const managed = environment.managed_variables.map((variable) => variable.name);
		const lines = [...environment.variables.map(describeVariable), ...managed.map((name) => `${name} (de un recurso)`)];
		return {
			text: lines.join("\n") || `${params.environment} no tiene variables`,
			data: { variables: environment.variables, managed_variables: environment.managed_variables },
		};
	},
});

const SetParameters = Type.Object({
	service: Type.Optional(Type.String()),
	environment: EnvironmentParam,
	set: Type.Optional(Type.Array(Type.Object({ name: Type.String(), value: Type.String() }), { description: "Variables no secretas" })),
	unset: Type.Optional(Type.Array(Type.String())),
	secrets: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				fromEnv: Type.Optional(Type.String({ description: "Variable local que trae el valor. Sin ella, se le pide al humano" })),
			}),
			{ description: "Secretos a crear o rotar. El valor nunca va en este parámetro" },
		),
	),
});

export const envSetTool = defineTool({
	name: "omi_env_set",
	label: "OMI: cambiar variables",
	description: "Cambia variables de un ambiente con reemplazo atómico, conservando los secretos existentes. No rige hasta el próximo deploy.",
	parameters: SetParameters,
	run: async (params, runtime) => {
		const names = [...(params.set ?? []).map((variable) => variable.name), ...(params.secrets ?? []).map((secret) => secret.name)];
		names.forEach(assertVariableName);
		for (const variable of params.set ?? []) assertValueSize(variable.name, variable.value);
		if (names.length === 0 && (params.unset ?? []).length === 0) throw new UsageError("no hay cambios: pasá set, unset o secrets");

		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const environment: EnvironmentView = environmentOf(await readService(scope, service.name), params.environment);
		// Primero con marcadores: el diff que confirma el humano no necesita los valores.
		const placeholders = (params.secrets ?? []).map(({ name }) => ({ name, value: "" }));
		const preview = planVariables(environment.variables, {
			...(params.set === undefined ? {} : { set: params.set }),
			...(params.unset === undefined ? {} : { unset: params.unset }),
			secrets: placeholders,
		});
		await enforce(
			{
				operation: preview.touchesSecrets ? "secrets" : "variables",
				environment: params.environment,
				summary: `Variables de ${service.name} en ${params.environment}`,
				diff: preview.diff.join("\n"),
			},
			runtime.guard,
		);

		const secrets: { name: string; value: string }[] = [];
		for (const { name, fromEnv } of params.secrets ?? []) {
			const value = await readSecretValue(name, fromEnv, runtime);
			assertValueSize(name, value);
			secrets.push({ name, value });
		}
		const plan = planVariables(environment.variables, {
			...(params.set === undefined ? {} : { set: params.set }),
			...(params.unset === undefined ? {} : { unset: params.unset }),
			secrets,
		});
		const updated = await scope.client.mutate("PUT", `${environmentPath(scope, service.name, params.environment)}/variables`, EnvironmentSchema, {
			body: { variables: plan.next },
			projectPath: scope.projectPath,
		});
		return {
			text: [`Variables de ${service.name} en ${params.environment} actualizadas (rigen en el próximo deploy)`, ...plan.diff].join("\n"),
			data: { variables: updated.variables, changes: plan.diff },
		};
	},
});
