// omi_deploy y omi_promote. OMI no tiene SSE de deploys ni ruta de promoción:
// se observa por polling, y promover es un deploy común en prod.

import { Type } from "typebox";
import type { MutationOptions } from "../client/http.ts";
import { DeploymentSchema, DeploymentsSchema, type Deployment } from "../client/views.ts";
import { OmiError } from "../core/errors.ts";
import { enforce, type EnvironmentName } from "../guardrails/policy.ts";
import { assertVersion } from "../publish/version.ts";
import { environmentOf, environmentPath, linkedService, openScope, readService, type Scope } from "./scope.ts";
import { defineTool, type ToolResult, type ToolRuntime } from "./types.ts";

/** Lease de un job de deploy más un margen para el rollback. */
const DEPLOY_DEADLINE_MS = 25 * 60_000;
/** El panel consulta cada 3 s; el intervalo base del cliente es de 2 s. */
const DEPLOY_POLL_BACKOFF = 1.5;

const STAGES = Type.Union([Type.Literal("stage"), Type.Literal("prod")]);

export async function followDeployment(scope: Scope, path: string, started: Deployment, runtime: ToolRuntime): Promise<Deployment> {
	let reported = 0;
	const report = (deployment: Deployment): void => {
		for (const step of deployment.steps.slice(reported)) {
			runtime.progress?.(step.instance === undefined ? step.kind : `${step.kind} ${step.instance}`);
		}
		reported = deployment.steps.length;
	};
	report(started);
	const deadline = Date.now() + DEPLOY_DEADLINE_MS;
	let current = started;
	while (current.status === "en_curso") {
		if (Date.now() > deadline) throw new OmiError("deployment_timeout", `el deploy ${started.id} no terminó a tiempo`, { hint: "`omi status` muestra su estado" });
		await scope.client.wait(runtime.signal, scope.client.pollIntervalMs * DEPLOY_POLL_BACKOFF);
		const { deployments } = await scope.client.request("GET", path, DeploymentsSchema, runtime.signal ? { signal: runtime.signal } : {});
		const latest = deployments.find((deployment) => deployment.id === started.id);
		if (latest === undefined) throw new OmiError("deployment_missing", `el deploy ${started.id} desapareció del historial`);
		current = latest;
		report(current);
	}
	return current;
}

function failure(deployment: Deployment, service: string): OmiError {
	const logs = deployment.instance_log_id === undefined ? "" : ` · crash logs: omi_crash_logs instanceLogId=${deployment.instance_log_id}`;
	const rollback = deployment.rollback === undefined ? "" : ` · ${deployment.rollback}`;
	return new OmiError("deployment_failed", `el deploy de ${service} ${deployment.to_version} falló: ${deployment.error ?? deployment.instance_log_error ?? "sin detalle"}`, {
		hint: `revisá los logs${logs}${rollback}`,
	});
}

export async function runDeployment(scope: Scope, service: string, environment: EnvironmentName, version: string, runtime: ToolRuntime, durable: { idempotencyKey?: string; onReceipt?: MutationOptions["onReceipt"]; onStarted?: (deployment: Deployment) => Promise<void> } = {}): Promise<ToolResult> {
	const path = `${environmentPath(scope, service, environment)}/deployments`;
	const started = await scope.client.mutate("POST", path, DeploymentSchema, {
		body: { version },
		projectPath: scope.projectPath,
		...(runtime.signal ? { signal: runtime.signal } : {}),
		...(durable.idempotencyKey ? { idempotencyKey: durable.idempotencyKey } : {}),
		...(durable.onReceipt ? { onReceipt: durable.onReceipt } : {}),
		onQueued: (state) => runtime.progress?.(`deploy en cola: ${state}`),
	});
	await durable.onStarted?.(started);
	const finished = await followDeployment(scope, path, started, runtime);
	if (finished.status !== "exitoso") throw failure(finished, service);
	return { text: `${service} ${version} desplegada en ${environment}`, data: finished };
}

export const deployTool = defineTool({
	name: "omi_deploy",
	label: "OMI: desplegar",
	description: "Despliega una versión publicada en un ambiente y sigue el rolling instancia por instancia hasta que termine.",
	parameters: Type.Object({
		service: Type.Optional(Type.String()),
		environment: STAGES,
		version: Type.String({ description: "Semver sin v" }),
	}),
	run: async (params, runtime) => {
		assertVersion(params.version);
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const environment = environmentOf(await readService(scope, service.name), params.environment);
		await enforce(
			{
				operation: "deploy",
				environment: params.environment,
				summary: `Deploy de ${service.name} en ${params.environment}`,
				diff: `${params.environment}: ${environment.current_version ?? "sin versión"} → ${params.version}`,
			},
			runtime.guard,
		);
		return runDeployment(scope, service.name, params.environment, params.version, runtime);
	},
});

export const promoteTool = defineTool({
	name: "omi_promote",
	label: "OMI: promover a prod",
	description: "Promueve a prod la versión que corre en stage. Siempre pide confirmación humana.",
	parameters: Type.Object({ service: Type.Optional(Type.String()) }),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const prod = environmentOf(await readService(scope, service.name), "prod");
		const { version, blocked_reason: blocked } = prod.promotion ?? {};
		// La API no valida blocked_reason al publicar: frena el cliente.
		if (blocked !== undefined || version === undefined) {
			throw new OmiError("promotion_blocked", `no se puede promover ${service.name}: ${blocked ?? "stage no tiene versión"}`);
		}
		await enforce(
			{
				operation: "promote",
				environment: "prod",
				summary: `Promover ${service.name} a prod`,
				diff: `prod: ${prod.current_version ?? "sin versión"} → ${version}`,
			},
			runtime.guard,
		);
		return runDeployment(scope, service.name, "prod", version, runtime);
	},
});
