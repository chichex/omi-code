// omi_postgres_query y omi_postgres_exec: SQL sobre un Postgres del proyecto.
// Leer es libre en cualquier ambiente, porque Postgres mismo impide que escriba. Ejecutar siempre pide un humano.

import { Type, type Static } from "typebox";
import { ResourcesSchema, SqlResultSchema, type ResourceSchema } from "../client/views.ts";
import { ApiError, EXIT_ERROR, OmiError, UsageError } from "../core/errors.ts";
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

function label(resource: Resource): string {
	return `${resource.slug} (${resource.state})`;
}

/** Con `active_revision` en 0 omi-api responde resource_not_active: todavía no hay una base que consultar. Sin el dato, decide la API. */
function assertUsable(resource: Resource): Resource {
	if (resource.active_revision !== 0) return resource;
	throw new OmiError("resource_not_active", `el Postgres ${resource.slug} de ${resource.environment} está ${resource.state}: todavía no tiene una base activa`, {
		hint: "`omi resources list` muestra su estado",
	});
}

/** El id manda, pero no puede contradecir lo demás: `--env stage` con el id de una base de prod no corre contra prod. */
function assertMatches(resource: Resource, params: SqlParams): Resource {
	const asked = [
		...(params.environment !== undefined && params.environment !== resource.environment ? [`el ambiente ${params.environment}`] : []),
		...(params.slug !== undefined && params.slug !== resource.slug ? [`el slug ${params.slug}`] : []),
	];
	if (asked.length === 0) return resource;
	throw new OmiError("resource_mismatch", `el recurso ${resource.id} es ${resource.slug} de ${resource.environment}, no ${asked.join(" ni ")}: no se envió nada`, {
		exitCode: EXIT_ERROR,
		hint: "sacá el flag que no coincide o corregí el id",
	});
}

/**
 * Un Postgres por id, o el único del ambiente que coincide con el slug. Nunca elige entre varios, estén
 * activos o no: el destino de un comando no puede depender del estado de otra base.
 */
async function findResource(scope: Scope, params: SqlParams): Promise<Resource> {
	if (params.resourceId === undefined && params.environment === undefined) throw new UsageError("indicá el ambiente (y el slug) o el id del recurso");
	const filter = params.resourceId === undefined && params.environment !== undefined ? `?environment=${params.environment}` : "";
	const listed = await scope.client.request("GET", `${scope.projectPath}/resources${filter}`, ResourcesSchema);
	// Hoy todo recurso es un Postgres; sólo se descarta el que diga ser otra cosa.
	const resources = listed.resources.filter((candidate) => (candidate.engine ?? "postgres") === "postgres");
	if (params.resourceId !== undefined) {
		const found = resources.find((candidate) => candidate.id === params.resourceId);
		if (found === undefined) throw notFound(`un Postgres ${params.resourceId} en el proyecto`);
		return assertUsable(assertMatches(found, params));
	}
	const matches = resources.filter((candidate) => params.slug === undefined || candidate.slug === params.slug);
	const [only, ...others] = matches;
	if (only === undefined) throw notFound(`un Postgres ${params.slug ?? ""} en ${params.environment}`.replace("  ", " "));
	if (others.length > 0) throw new UsageError(`hay varios Postgres en ${params.environment}: indicá cuál con el slug o con el id`, matches.map(label).join(", "));
	return assertUsable(only);
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

const VERIFY_HINT = "verificá el estado con `omi resources postgres query` antes de repetirla";
/**
 * Códigos propios de omi-api que garantizan que la sentencia no se aplicó: la rechazó antes de entregarla
 * al agente, el agente no la corrió, o Postgres la canceló con rollback. Es una lista blanca: cualquier
 * otra respuesta después de enviar (un 4xx o un 5xx de un proxy, un código que no está acá) queda en duda.
 */
const SETTLED_CODES = [
	"authentication_required", "session_expired", "forbidden", "organization_not_found", "project_not_found",
	"invalid_json", "invalid_sql", "invalid_sql_limits",
	"resource_not_found", "resource_not_active", "resource_secret_unavailable", "decommissioning", "control_plane_unavailable",
	"sql_busy", "sql_agent_unavailable", "sql_error", "sql_timeout", "sql_connection_failed",
];
/** Fallos de red que ocurren antes de que el pedido salga: no hay conexión por la que haya viajado. */
const NEVER_SENT = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

function networkCode(error: OmiError): string | undefined {
	for (let cause: unknown = error.cause, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth += 1) {
		const code = (cause as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

/**
 * Qué decirle a quien lanzó una ejecución que falló después de confirmarla. Una escritura no es
 * idempotente: si el pedido pudo salir y no volvió una respuesta que diga qué pasó, queda en duda.
 * Nunca se reintenta.
 */
export function execFailure(error: unknown): unknown {
	const unknown = (details?: ApiError["details"]): ApiError =>
		new ApiError("sql_outcome_unknown", "la ejecución se envió y no volvió una respuesta: no se sabe si la sentencia se aplicó", 504, VERIFY_HINT, details);
	if (error instanceof ApiError) {
		if (error.code === "sql_outcome_unknown") return new ApiError(error.code, `${error.message}: no se sabe si la sentencia se aplicó`, error.status, VERIFY_HINT, error.details);
		return SETTLED_CODES.includes(error.code) ? error : unknown(error.details);
	}
	if (error instanceof OmiError && error.code === "unexpected_response") {
		return new OmiError("sql_result_unreadable", "la sentencia se ejecutó, pero no se pudo leer el resultado que devolvió OMI", {
			hint: "no la repitas: mirá cómo quedó con `omi resources postgres query`; si persiste, corré `omi upgrade`",
			cause: error,
		});
	}
	if (error instanceof OmiError && error.code === "api_unreachable" && NEVER_SENT.includes(networkCode(error) ?? "")) {
		return new OmiError(error.code, error.message, { hint: "el pedido no llegó a salir: no se ejecutó nada. Revisá la URL con --api u OMI_API_URL", cause: error.cause });
	}
	return unknown();
}

export const postgresQueryTool = defineTool({
	name: "omi_postgres_query",
	label: "OMI: consultar Postgres",
	description:
		"Corre una consulta de sólo lectura (SELECT, VALUES, TABLE, WITH) en un Postgres del proyecto, en stage o prod, sin confirmación. Es libre porque OMI la corre en una transacción de sólo lectura que Postgres hace cumplir y, en una base local, con un rol sin permisos de escritura; en una base externa depende del rol de la URI con que se dio de alta. Los datos devueltos llegan al modelo: no consultes lo que no deba salir de la base. Devuelve columnas con su tipo, filas y si el resultado se cortó. Para escribir usá omi_postgres_exec.",
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
			throw execFailure(error);
		}
	},
});
