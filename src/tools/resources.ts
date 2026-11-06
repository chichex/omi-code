// omi_resources_list y omi_postgres_manage. Todo cambio pasa por vista previa y confirmación.

import { Type, type Static } from "typebox";
import { ResourceConfirmationSchema, ResourceOperationSchema, ResourcePreviewSchema, ResourcesSchema } from "../client/views.ts";
import { OmiError, UsageError } from "../core/errors.ts";
import { assertCanProceed, enforce, type EnvironmentName, type GuardedAction } from "../guardrails/policy.ts";
import { openScope, type Scope } from "./scope.ts";
import { readSecretValue } from "./secrets.ts";
import { defineTool, type ToolRuntime } from "./types.ts";

const OPERATION_DEADLINE_MS = 15 * 60_000;
const IN_PROGRESS = ["esperando", "probando", "provisionando", "aplicando", "compensando", "reconciliando", "recuperando"];
const NEEDS_CONNECTION = ["replace", "recover"];

const EnvironmentParam = Type.Union([Type.Literal("stage"), Type.Literal("prod")]);

export const resourcesListTool = defineTool({
	name: "omi_resources_list",
	label: "OMI: listar recursos",
	description: "Lista los Postgres externos y locales del proyecto. Nunca trae la conexión.",
	parameters: Type.Object({ environment: Type.Optional(EnvironmentParam) }),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const query = params.environment === undefined ? "" : `?environment=${params.environment}`;
		const { resources } = await scope.client.request("GET", `${scope.projectPath}/resources${query}`, ResourcesSchema);
		const lines = resources.map((resource) => `${resource.environment}/${resource.slug} (${resource.mode}): ${resource.state} · ${resource.variable}`);
		return { text: lines.join("\n") || "El proyecto no tiene recursos", data: { resources } };
	},
});

const ManageParameters = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("delete"), Type.Literal("retry"), Type.Literal("recover")]),
	environment: Type.Optional(EnvironmentParam),
	slug: Type.Optional(Type.String()),
	mode: Type.Optional(Type.Union([Type.Literal("externa"), Type.Literal("local")])),
	resourceId: Type.Optional(Type.String({ description: "res_...: obligatorio salvo en create" })),
	connectionFromEnv: Type.Optional(Type.String({ description: "Variable local con la URI. La conexión nunca va en un parámetro" })),
	version: Type.Optional(Type.String({ description: "Sólo local: 17 o 16" })),
	size: Type.Optional(Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")])),
	diskGib: Type.Optional(Type.Integer()),
});

type ManageParams = Static<typeof ManageParameters>;

function targetOf(params: ManageParams): string {
	return params.action === "create" ? `${params.slug ?? "?"} en ${params.environment ?? "?"}` : (params.resourceId ?? "?");
}

function assertTarget(params: ManageParams): void {
	if (params.action === "create") {
		if (params.environment === undefined || params.slug === undefined) throw new UsageError("create necesita environment y slug");
		return;
	}
	if (params.resourceId === undefined) throw new UsageError(`${params.action} necesita resourceId`);
}

function needsConnection(params: ManageParams): boolean {
	return (params.action === "create" && params.mode !== "local") || NEEDS_CONNECTION.includes(params.action);
}

function previewBody(params: ManageParams, connection: string | undefined): Record<string, unknown> {
	const optional: [string, unknown][] = [
		["resource_id", params.resourceId],
		["environment", params.environment],
		["slug", params.slug],
		["connection", connection],
		["mode", params.mode],
		["version", params.version],
		["size", params.size],
		["disk_gib", params.diskGib],
	];
	return { action: params.action, ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)) };
}

async function awaitOperation(scope: Scope, operationID: string, runtime: ToolRuntime): Promise<Static<typeof ResourceOperationSchema>> {
	const deadline = Date.now() + OPERATION_DEADLINE_MS;
	const path = `${scope.projectPath}/resource-operations/${encodeURIComponent(operationID)}`;
	while (Date.now() < deadline) {
		const operation = await scope.client.request("GET", path, ResourceOperationSchema);
		if (!IN_PROGRESS.includes(operation.state)) return operation;
		runtime.progress?.(`operación ${operation.state}`);
		await scope.client.wait(runtime.signal);
	}
	throw new OmiError("resource_operation_timeout", `la operación ${operationID} no terminó a tiempo`, {
		hint: "`omi resources list` muestra su estado",
	});
}

export const postgresManageTool = defineTool({
	name: "omi_postgres_manage",
	label: "OMI: gestionar Postgres",
	description: "Alta, reemplazo de conexión, baja, reintento o recuperación de un Postgres. Siempre pide confirmación humana.",
	parameters: ManageParameters,
	run: async (params, runtime) => {
		assertTarget(params);
		const baseAction: GuardedAction = {
			operation: "resource",
			...(params.environment === undefined ? {} : { environment: params.environment as EnvironmentName }),
			summary: `Postgres ${params.action}: ${targetOf(params)}`,
			diff: `${params.action} ${targetOf(params)}`,
		};
		// Sin humano posible no se manda ni la vista previa, que llevaría la conexión.
		assertCanProceed(baseAction, runtime.guard);
		const connection = needsConnection(params) ? await readSecretValue("la conexión de Postgres", params.connectionFromEnv, runtime) : undefined;

		const scope = await openScope(runtime);
		const preview = await scope.client.request("POST", `${scope.projectPath}/resource-previews`, ResourcePreviewSchema, {
			body: previewBody(params, connection),
		});
		const impact = preview.services.flatMap((service) => service.changes.map((change) => `  ${service.name}: ${change.change} ${change.name}`));
		await enforce(
			{
				...baseAction,
				environment: preview.environment as EnvironmentName,
				diff: [
					`${preview.action} ${preview.slug} (${preview.mode}) en ${preview.environment} · ${preview.variable}`,
					...impact,
					...(preview.pending_configuration ? ["Incluye configuración pendiente de desplegar"] : []),
				].join("\n"),
			},
			runtime.guard,
		);
		const confirmation = await scope.client.request(
			"POST",
			`${scope.projectPath}/resource-previews/${encodeURIComponent(preview.id)}/confirm`,
			ResourceConfirmationSchema,
			{ body: { include_pending_configuration: preview.pending_configuration, confirmation_name: params.action === "delete" ? preview.slug : "" } },
		);
		const operation = await awaitOperation(scope, confirmation.operation_id, runtime);
		if (operation.state === "requiere_confirmacion") {
			throw new OmiError("resource_preview_stale", "el impacto cambió mientras esperaba", { hint: "volvé a correr la operación" });
		}
		if (operation.state !== "exitoso" && operation.state !== "recuperada") {
			throw new OmiError("resource_operation_failed", `la operación terminó ${operation.state}: ${operation.error ?? "sin detalle"}`);
		}
		return {
			text: `Postgres ${preview.slug}: ${preview.action} ${operation.state}`,
			data: { operation_id: operation.id, resource_id: operation.resource_id, state: operation.state, variable: preview.variable },
		};
	},
});
