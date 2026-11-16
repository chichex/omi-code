import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import type { Guard, GuardedAction } from "../src/guardrails/policy.ts";
import { sqlProblem } from "./helpers/mock-sql.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

const PROJECT = "/api/v1/organizations/org_acme/projects/tienda";

function resource(linked: Linked, id: string, environment: string, slug: string, mode = "local"): void {
	linked.workloads.resources.set(id, { id, environment, slug, mode, variable: `POSTGRES_URL_${slug.toUpperCase()}`, state: "lista", engine: "postgres", active_revision: 1 });
}

/** Un humano que responde y deja registrado lo que le mostraron. */
function human(answer: boolean, seen: GuardedAction[]): Guard {
	return {
		surface: "cli",
		canAsk: true,
		preApproved: false,
		stageAuthorized: false,
		grantStage() {},
		ask: async (action) => {
			seen.push(action);
			return answer;
		},
	};
}

test("omi_postgres_query_consulta el recurso del ambiente sin pedir confirmación, tampoco en prod", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_ventas", "prod", "ventas");
	// Sin humano posible: una lectura no lo necesita en ningún ambiente.
	const result = await linked.call("omi_postgres_query", { environment: "prod", slug: "ventas", sql: "SELECT id, email, datos FROM usuarios" }, { guard: humanless() });
	assert.deepEqual(linked.sql.calls, [{ action: "query", resourceID: "res_ventas", body: { sql: "SELECT id, email, datos FROM usuarios" } }]);
	assert.deepEqual(linked.mutations(), [`POST ${PROJECT}/resources/res_ventas/query`]);
	assert.deepEqual(result.data, {
		resource: { id: "res_ventas", environment: "prod", slug: "ventas", mode: "local" },
		columns: [{ name: "id", type: "integer" }, { name: "email", type: "text" }, { name: "datos", type: "jsonb" }],
		rows: [[1, "ada@omi.test", { plan: "pro" }], [2, null, null]],
		row_count: 2,
		truncated: false,
		duration_ms: 12,
		limits: { max_rows: 500, timeout_seconds: 10, max_response_bytes: 1_048_576 },
	});
	assert.equal(
		result.text,
		[
			"ventas (local) en prod",
			"id | email        | datos         ",
			"---+--------------+---------------",
			"1  | ada@omi.test | {\"plan\":\"pro\"}",
			"2  | NULL         | NULL          ",
			"2 filas · truncado: no · 12 ms",
		].join("\n"),
	);
});

test("omi_postgres_query_manda los topes sólo si se piden", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	await linked.call("omi_postgres_query", { environment: "stage", slug: "app", sql: "SELECT 1", maxRows: 20, timeoutSeconds: 3 });
	assert.deepEqual(linked.sql.calls[0]?.body, { sql: "SELECT 1", max_rows: 20, timeout_seconds: 3 });
});

test("omi_postgres_query_un resultado cortado lo dice en el texto y en los datos", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => ({
		status: 200,
		body: { columns: [{ name: "n", type: "integer" }], rows: [[1], [2]], row_count: 2, truncated: true, truncated_by: "rows", duration_ms: 4, limits: { max_rows: 2, timeout_seconds: 10, max_response_bytes: 1_048_576 } },
	});
	const result = await linked.call("omi_postgres_query", { environment: "stage", slug: "app", sql: "SELECT n FROM numeros", maxRows: 2 });
	assert.match(result.text, /2 filas · truncado: sí, por el tope de 2 filas: hay más · 4 ms$/);
	assert.equal((result.data as { truncated: boolean; truncated_by: string }).truncated_by, "rows");
});

test("omi_postgres_query_resuelve el recurso por id, por ambiente o pide desambiguar", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	resource(linked, "res_ventas", "stage", "ventas", "externa");
	resource(linked, "res_prod", "prod", "app");
	await linked.call("omi_postgres_query", { resourceId: "res_ventas", sql: "SELECT 1" });
	await linked.call("omi_postgres_query", { environment: "prod", sql: "SELECT 1" });
	assert.deepEqual(linked.sql.calls.map((call) => call.resourceID), ["res_ventas", "res_prod"]);
	await assert.rejects(
		linked.call("omi_postgres_query", { environment: "stage", sql: "SELECT 1" }),
		(error: OmiError) => error.code === "usage_error" && error.hint === "app (lista), ventas (lista)",
	);
	await assert.rejects(linked.call("omi_postgres_query", { environment: "stage", slug: "otra", sql: "SELECT 1" }), (error: OmiError) => error.code === "resource_not_found");
	await assert.rejects(linked.call("omi_postgres_query", { resourceId: "res_no", sql: "SELECT 1" }), (error: OmiError) => error.code === "resource_not_found");
	await assert.rejects(linked.call("omi_postgres_query", { sql: "SELECT 1" }), (error: OmiError) => error.code === "usage_error");
	assert.equal(linked.sql.calls.length, 2);
});

test("omi_postgres_query_un error de Postgres trae SQLSTATE, posición y sugerencia", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(422, { code: "sql_error", message: 'relation "usuarios" does not exist', sqlstate: "42P01", position: 15, hint: "revisá el esquema", detail: "detalle" });
	await assert.rejects(
		linked.call("omi_postgres_query", { environment: "stage", slug: "app", sql: "SELECT * FROM usuarios" }),
		(error: OmiError & { details?: unknown }) => {
			assert.equal(error.code, "sql_error");
			assert.equal(error.message, 'relation "usuarios" does not exist (SQLSTATE 42P01, posición 15)');
			assert.equal(error.hint, "detalle · revisá el esquema");
			assert.deepEqual(error.details, { sqlstate: "42P01", position: 15 });
			return true;
		},
	);
});

test("omi_postgres_exec_muestra ambiente, base y SQL completo, y ejecuta sólo con el sí del humano", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_ventas", "prod", "ventas", "externa");
	const seen: GuardedAction[] = [];
	const sql = "DELETE FROM pruebas\nWHERE creado < now() - interval '1 day'";
	const result = await linked.call("omi_postgres_exec", { environment: "prod", slug: "ventas", sql }, { guard: human(true, seen) });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.operation, "resource");
	assert.equal(seen[0]?.environment, "prod");
	assert.equal(seen[0]?.summary, "Ejecutar SQL en Postgres ventas (prod)");
	assert.equal(seen[0]?.diff, ["Ambiente: prod", "Base: ventas (externa) · res_ventas", "SQL:", sql].join("\n"));
	assert.deepEqual(linked.sql.calls, [{ action: "exec", resourceID: "res_ventas", body: { sql } }]);
	assert.equal(result.text, "ventas (externa) en prod\nDELETE 1 · 1 fila afectada · 7 ms");
	assert.deepEqual((result.data as { rows_affected: number; command: string }).rows_affected, 1);
});

for (const environment of ["stage", "prod"]) {
	test(`omi_postgres_exec_sin humano no ejecuta nada en ${environment}, tampoco con stage autorizado ni --yes`, async (t) => {
		const linked = await linkedProject(t);
		resource(linked, "res_app", environment, "app");
		const preApproved: Guard = { ...humanless(true), preApproved: true };
		await assert.rejects(
			linked.call("omi_postgres_exec", { environment, slug: "app", sql: "DELETE FROM pruebas" }, { guard: preApproved }),
			(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED && /DELETE FROM pruebas/.test(error.hint ?? ""),
		);
		assert.deepEqual(linked.sql.calls, []);
		assert.deepEqual(linked.mutations(), []);
	});
}

test("omi_postgres_exec_si el humano dice que no, no ejecuta", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	await assert.rejects(
		linked.call("omi_postgres_exec", { environment: "stage", slug: "app", sql: "DROP TABLE pagos" }, { guard: human(false, []) }),
		(error: OmiError) => error.code === "guardrail_declined",
	);
	assert.deepEqual(linked.sql.calls, []);
});

test("omi_postgres_exec_la confirmación deja a la vista los caracteres que podrían esconder SQL", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const seen: GuardedAction[] = [];
	const sql = "SELECT 1;\u001b[2K\rDROP TABLE pagos -- ‮oculto\u0000";
	await assert.rejects(linked.call("omi_postgres_exec", { environment: "stage", slug: "app", sql }, { guard: human(false, seen) }));
	assert.equal(seen[0]?.diff.split("SQL:\n")[1], "SELECT 1;\\u001b[2K\\u000dDROP TABLE pagos -- \\u202eoculto\\u0000");
});

test("omi_postgres_exec_un resultado en duda dice que hay que verificar antes de repetir", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(504, { code: "sql_outcome_unknown", message: "el agente tomó la ejecución y no respondió a tiempo: no se sabe si se aplicó" });
	await assert.rejects(
		linked.call("omi_postgres_exec", { environment: "stage", slug: "app", sql: "UPDATE pagos SET estado = 'ok'" }),
		(error: OmiError) => error.code === "sql_outcome_unknown" && /omi resources postgres query/.test(error.hint ?? ""),
	);
});
