// Rutas de consultar y ejecutar SQL del doble de omi-api: copian el contrato de chichex/omi#157.

import { Problem, requireProjectFor, requireSessionFor, strictBodyOf, type MockOmi, type MockRequest, type MockResponse } from "./mock-omi.ts";
import type { WorkloadState } from "./mock-workloads.ts";

/** Topes por defecto de omi-api: 500 filas, 10 s y 1 MiB de respuesta. */
const LIMITS = { max_rows: 500, timeout_seconds: 10, max_response_bytes: 1_048_576 };

export interface SqlCall {
	action: "query" | "exec";
	resourceID: string;
	body: Record<string, unknown>;
}

export interface SqlState {
	calls: SqlCall[];
	/** Respuesta del próximo pedido; sin ella responde un resultado fijo. */
	respond: ((call: SqlCall) => MockResponse) | undefined;
}

export function sqlProblem(status: number, error: Record<string, unknown>): MockResponse {
	return { status, body: { error } };
}

function limitOf(body: Record<string, unknown>, key: "max_rows" | "timeout_seconds"): number {
	const requested = body[key];
	if (requested === undefined) return LIMITS[key];
	if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > LIMITS[key]) {
		throw new Problem(400, "invalid_sql_limits", `${key} debe estar entre 1 y ${LIMITS[key]}`);
	}
	return requested;
}

function run(action: SqlCall["action"], request: MockRequest, params: Record<string, string>, mock: MockOmi, workloads: WorkloadState, state: SqlState): MockResponse {
	requireSessionFor(request, mock);
	requireProjectFor(params, mock);
	const body = strictBodyOf(request, ["sql", "max_rows", "timeout_seconds"]);
	const resourceID = params.resourceID ?? "";
	if (!workloads.resources.has(resourceID)) throw new Problem(404, "resource_not_found", "el recurso no existe");
	if (typeof body.sql !== "string" || body.sql.trim() === "") throw new Problem(400, "invalid_sql", "el SQL es obligatorio");
	const limits = { ...LIMITS, max_rows: limitOf(body, "max_rows"), timeout_seconds: limitOf(body, "timeout_seconds") };
	const call: SqlCall = { action, resourceID, body };
	state.calls.push(call);
	if (state.respond !== undefined) return state.respond(call);
	if (action === "exec") {
		return { status: 200, body: { columns: [], rows: [], row_count: 0, truncated: false, rows_affected: 1, command: "DELETE 1", duration_ms: 7, limits } };
	}
	return {
		status: 200,
		body: {
			columns: [{ name: "id", type: "integer" }, { name: "email", type: "text" }, { name: "datos", type: "jsonb" }],
			rows: [[1, "ada@omi.test", { plan: "pro" }], [2, null, null]],
			row_count: 2,
			truncated: false,
			duration_ms: 12,
			limits,
		},
	};
}

export function installSql(mock: MockOmi, workloads: WorkloadState): SqlState {
	const state: SqlState = { calls: [], respond: undefined };
	const resource = "/api/v1/organizations/{organizationID}/projects/{projectSlug}/resources/{resourceID}";
	mock.route(`POST ${resource}/query`, (request, params) => run("query", request, params, mock, workloads, state));
	mock.route(`POST ${resource}/exec`, (request, params) => run("exec", request, params, mock, workloads, state));
	return state;
}
