// omi_postgres_query y omi_postgres_exec: SQL sobre un Postgres del proyecto.
// Leer es libre en cualquier ambiente, porque Postgres mismo impide que escriba. Ejecutar siempre pide un humano.

import { Type, type Static } from "typebox";
import { ResourcesSchema, SqlResultSchema, type ResourceSchema } from "../client/views.ts";
import { ApiError, OmiError, UsageError } from "../core/errors.ts";
import { assertCanProceed, enforce, type EnvironmentName, type GuardedAction } from "../guardrails/policy.ts";
import { openScope, type Scope } from "./scope.ts";
import { execText, queryText, visible } from "./sql-format.ts";
import { defineTool } from "./types.ts";

/** Espera del pedido HTTP además del timeout de la sentencia: omi-api entrega el pedido al agente y espera su resultado. */
const REQUEST_GRACE_MS = 30_000;
/** Sin timeout pedido rige el de omi-api, que el cliente no conoce: se espera hasta su máximo de 5 minutos. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000 + REQUEST_GRACE_MS;

const SqlParameters = Type.Object({
	environment: Type.Optional(Type.Union([Type.Literal("stage"), Type.Literal("prod")])),
	slug: Type.Optional(Type.String({ description: "Nombre del recurso. Hace falta si el ambiente tiene más de un Postgres" })),
	resourceId: Type.Optional(Type.String({ description: "res_...: alternativa a environment y slug" })),
	sql: Type.String({ description: "Una sola sentencia SQL" }),
	maxRows: Type.Optional(Type.Integer({ minimum: 1, description: "Menos filas que el tope de OMI (500 por defecto). No puede pedir más" })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Menos tiempo que el tope de OMI (10 s por defecto). No puede pedir más" })),
});

type SqlParams = Static<typeof SqlParameters>;
type Resource = Static<typeof ResourceSchema>;

function notFound(what: string): OmiError {
	return new OmiError("resource_not_found", `no hay ${what}`, { hint: "`omi resources list` muestra los recursos del proyecto" });
}

/** Un recurso por id, o el único que coincide con ambiente y slug. Nunca elige entre varios. */
async function findResource(scope: Scope, params: SqlParams): Promise<Resource> {
	if (params.resourceId === undefined && params.environment === undefined) throw new UsageError("indicá el ambiente (y el slug) o el id del recurso");
	const filter = params.resourceId === undefined && params.environment !== undefined ? `?environment=${params.environment}` : "";
	const { resources } = await scope.client.request("GET", `${scope.projectPath}/resources${filter}`, ResourcesSchema);
	if (params.resourceId !== undefined) {
		const found = resources.find((candidate) => candidate.id === params.resourceId);
		if (found === undefined) throw notFound(`un recurso ${params.resourceId} en el proyecto`);
		return found;
	}
	const matches = resources.filter((candidate) => params.slug === undefined || candidate.slug === params.slug);
	const [only, ...others] = matches;
	if (only === undefined) throw notFound(`un Postgres ${params.slug ?? ""} en ${params.environment}`.replace("  ", " "));
	if (others.length > 0) throw new UsageError(`hay varios Postgres en ${params.environment}: indicá cuál con el slug`, matches.map((candidate) => candidate.slug).join(", "));
	return only;
}

function requestBody(params: SqlParams): Record<string, unknown> {
	return {
		sql: params.sql,
		...(params.maxRows === undefined ? {} : { max_rows: params.maxRows }),
		...(params.timeoutSeconds === undefined ? {} : { timeout_seconds: params.timeoutSeconds }),
	};
}

async function send(scope: Scope, resource: Resource, action: "query" | "exec", params: SqlParams, signal: AbortSignal | undefined) {
	const result = await scope.client.request("POST", `${scope.projectPath}/resources/${encodeURIComponent(resource.id)}/${action}`, SqlResultSchema, {
		body: requestBody(params),
		timeoutMs: params.timeoutSeconds === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : params.timeoutSeconds * 1000 + REQUEST_GRACE_MS,
		...(signal === undefined ? {} : { signal }),
	});
	const title = `${resource.slug} (${resource.mode}) en ${resource.environment}`;
	const data = { resource: { id: resource.id, environment: resource.environment, slug: resource.slug, mode: resource.mode }, ...result };
	return { title, result, data };
}

export const postgresQueryTool = defineTool({
	name: "omi_postgres_query",
	label: "OMI: consultar Postgres",
	description:
		"Corre una consulta de sólo lectura (SELECT, VALUES, TABLE, WITH) en un Postgres del proyecto, en stage o prod, sin confirmación: Postgres mismo impide que escriba. Devuelve columnas con su tipo, filas y si el resultado se cortó. Para escribir usá omi_postgres_exec.",
	parameters: SqlParameters,
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const resource = await findResource(scope, params);
		const { title, result, data } = await send(scope, resource, "query", params, runtime.signal);
		return { text: queryText(title, result), data };
	},
});

export const postgresExecTool = defineTool({
	name: "omi_postgres_exec",
	label: "OMI: ejecutar SQL en Postgres",
	description:
		"Ejecuta una sentencia que puede escribir (INSERT, UPDATE, DELETE, DDL) en un Postgres del proyecto. Siempre pide confirmación humana, en cualquier ambiente, mostrando el ambiente, la base y el SQL completo. Devuelve las filas afectadas y las de RETURNING. Para leer usá omi_postgres_query.",
	parameters: SqlParameters,
	run: async (params, runtime) => {
		const target = params.slug ?? params.resourceId ?? "?";
		const baseAction: GuardedAction = {
			operation: "resource",
			...(params.environment === undefined ? {} : { environment: params.environment as EnvironmentName }),
			summary: `Ejecutar SQL en Postgres ${target}${params.environment === undefined ? "" : ` (${params.environment})`}`,
			diff: `SQL:\n${visible(params.sql)}`,
		};
		// Sin humano posible no se manda nada a la API.
		assertCanProceed(baseAction, runtime.guard);
		const scope = await openScope(runtime);
		const resource = await findResource(scope, params);
		await enforce(
			{
				operation: "resource",
				environment: resource.environment as EnvironmentName,
				summary: `Ejecutar SQL en Postgres ${resource.slug} (${resource.environment})`,
				diff: [`Ambiente: ${resource.environment}`, `Base: ${resource.slug} (${resource.mode}) · ${resource.id}`, "SQL:", visible(params.sql)].join("\n"),
			},
			runtime.guard,
		);
		try {
			const { title, result, data } = await send(scope, resource, "exec", params, runtime.signal);
			return { text: execText(title, result), data };
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "sql_outcome_unknown") throw error;
			throw new ApiError(error.code, error.message, error.status, "verificá el estado con `omi resources postgres query` antes de repetirla");
		}
	},
});
