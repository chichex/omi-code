// Bordes de consultar y ejecutar SQL: una escritura en duda nunca se presenta como "no corrió",
// la confirmación no puede esconder SQL y el cliente tolera las formas que la API puede mandar.

import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli/main.ts";
import { ApiError, OmiError } from "../src/core/errors.ts";
import { execFailure } from "../src/tools/sql.ts";
import { queryText, visible } from "../src/tools/sql-format.ts";
import { sqlProblem } from "./helpers/mock-sql.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

function resource(linked: Linked, id: string, environment: string, slug: string, extra: Record<string, unknown> = {}): void {
	linked.workloads.resources.set(id, { id, environment, slug, mode: "local", variable: "POSTGRES_URL_X", state: "lista", engine: "postgres", active_revision: 1, ...extra });
}

const EXEC = { environment: "stage", slug: "app", sql: "UPDATE pagos SET estado = 'ok'" };

function isUnknown(error: OmiError): boolean {
	assert.equal(error.code, "sql_outcome_unknown", error.message);
	assert.match(error.message, /no se sabe si la sentencia se aplicó/);
	assert.match(error.hint ?? "", /omi resources postgres query/);
	assert.doesNotMatch(`${error.message} ${error.hint}`, /revisá la URL|no se pudo conectar/);
	return true;
}

test("omi_postgres_exec_un corte de red después de enviar queda en duda y no se reintenta", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => ({ status: 200, stream: (response) => void response.socket?.destroy() });
	await assert.rejects(linked.call("omi_postgres_exec", EXEC), isUnknown);
	assert.equal(linked.sql.calls.length, 1);
});

test("omi_postgres_exec_una señal abortada después de enviar queda en duda", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const abort = new AbortController();
	linked.sql.respond = () => ({ status: 200, stream: () => abort.abort() });
	await assert.rejects(linked.call("omi_postgres_exec", EXEC, { signal: abort.signal }), isUnknown);
	assert.equal(linked.sql.calls.length, 1);
});

test("omi_postgres_exec_un 5xx que no es de SQL queda en duda; los que OMI resolvió no", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(502, { code: "omi_api_unavailable", message: "No se pudo conectar con OMI API." });
	await assert.rejects(linked.call("omi_postgres_exec", EXEC), isUnknown);
	linked.sql.respond = () => ({ status: 504, text: "gateway timeout" });
	await assert.rejects(linked.call("omi_postgres_exec", EXEC), isUnknown);
	for (const [status, code] of [[503, "sql_agent_unavailable"], [504, "sql_timeout"], [502, "sql_connection_failed"], [422, "sql_error"], [400, "invalid_sql_limits"]] as const) {
		linked.sql.respond = () => sqlProblem(status, { code, message: `mensaje de ${code}` });
		await assert.rejects(linked.call("omi_postgres_exec", EXEC), (error: OmiError) => error.code === code && error.message === `mensaje de ${code}`);
	}
	assert.equal(linked.sql.calls.length, 7);
});

test("omi_postgres_exec_sql_outcome_unknown conserva el SQLSTATE y la posición", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(504, { code: "sql_outcome_unknown", message: "no se sabe si se aplicó", sqlstate: "08006", position: 3 });
	await assert.rejects(linked.call("omi_postgres_exec", EXEC), (error: ApiError) => {
		assert.deepEqual(error.details, { sqlstate: "08006", position: 3 });
		return error.code === "sql_outcome_unknown" && /omi resources postgres query/.test(error.hint ?? "");
	});
});

test("omi_postgres_exec_una respuesta 2xx ilegible dice que la sentencia se ejecutó", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	for (const reply of [{ status: 200, body: { rows: "no es una lista" } }, { status: 200, text: "<html>ok</html>" }]) {
		linked.sql.respond = () => reply;
		await assert.rejects(linked.call("omi_postgres_exec", EXEC), (error: OmiError) => {
			assert.equal(error.code, "sql_result_unreadable");
			assert.match(error.message, /la sentencia se ejecutó/);
			assert.match(error.hint ?? "", /no la repitas/);
			return true;
		});
	}
});

test("execFailure_sólo un fallo anterior al envío puede decir que no se ejecutó", () => {
	const unreachable = (code: string | undefined, name = "Error"): OmiError => {
		const cause = Object.assign(new Error("x"), { name }, code === undefined ? {} : { code });
		return new OmiError("api_unreachable", "no se pudo conectar con https://omi", { cause: new TypeError("fetch failed", { cause }) });
	};
	for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
		const failure = execFailure(unreachable(code)) as OmiError;
		assert.equal(failure.code, "api_unreachable", code);
		assert.match(failure.hint ?? "", /no se ejecutó/);
	}
	for (const error of [unreachable("ECONNRESET"), unreachable("UND_ERR_SOCKET"), unreachable(undefined, "TimeoutError"), new DOMException("aborted", "AbortError"), new Error("otra cosa")]) {
		assert.equal((execFailure(error) as OmiError).code, "sql_outcome_unknown", String(error));
	}
});

test("omi_postgres_query_un corte de red sigue siendo un error de conexión: leer no deja nada en duda", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => ({ status: 200, stream: (response) => void response.socket?.destroy() });
	await assert.rejects(linked.call("omi_postgres_query", { ...EXEC, sql: "SELECT 1" }), (error: OmiError) => error.code === "api_unreachable");
	assert.equal(linked.sql.calls.length, 1);
});

test("visible_escapa cada familia de caracteres que se ve distinto de lo que se envía", () => {
	const cases: [string, string, string][] = [
		["control C0", "\u001b", "\\u001b"],
		["control C1", "\u0085", "\\u0085"],
		["guion blando", "­", "\\u00ad"],
		["marca árabe de dirección", "؜", "\\u061c"],
		["separador mongol", "᠎", "\\u180e"],
		["ancho cero", "​", "\\u200b"],
		["override bidi", "‮", "\\u202e"],
		["aislante bidi", "⁦", "\\u2066"],
		["separador de línea", " ", "\\u2028"],
		["separador de párrafo", " ", "\\u2029"],
		["BOM", "﻿", "\\ufeff"],
		["espacio de no separación", " ", "\\u00a0"],
		["espacio ideográfico", "　", "\\u3000"],
		["tag invisible", "\u{e0041}", "\\u{e0041}"],
		["uso privado", "", "\\ue000"],
		["sustituto suelto", "\ud800", "\\ud800"],
	];
	for (const [name, hidden, shown] of cases) assert.equal(visible(`DROP${hidden}TABLE`), `DROP${shown}TABLE`, name);
	assert.equal(visible("SELECT 'ñandú 日本 🙂'\n\tFROM t"), "SELECT 'ñandú 日本 🙂'\n\tFROM t");
});

test("la tabla distingue NULL de cadena vacía, recorta lo enorme y no deja pasar saltos ni ANSI", () => {
	const text = queryText("app (local) en stage", {
		columns: [{ name: "a", type: "text" }, { name: "b", type: "text" }],
		rows: [[null, ""], ["NULL", "x".repeat(500)], ["uno\ndos\ttres", "\u001b[31mrojo\u001b[0m"]],
		row_count: 3,
		truncated: false,
		duration_ms: 1,
		limits: { max_rows: 500, timeout_seconds: 10, max_response_bytes: 1 },
	});
	const [, , , first, second, third] = text.split("\n");
	assert.match(first ?? "", /^NULL {18} \| '' {78}$/);
	assert.match(second ?? "", /^'NULL' {16} \| x{79}…$/);
	assert.equal(third, "uno\\u000ados\\u0009tres | \\u001b[31mrojo\\u001b[0m" + " ".repeat(57));
	assert.equal(text.split("\n").length, 7);
});

test("el cliente tolera null donde la API omite: errores y resultados de SQL", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(422, { code: "sql_error", message: "falló", sqlstate: "42601", position: null, detail: null, hint: null, field: null });
	await assert.rejects(linked.call("omi_postgres_query", { ...EXEC, sql: "SELEC 1" }), (error: OmiError) => error.code === "sql_error" && error.message === "falló (SQLSTATE 42601)" && error.hint === undefined);
	linked.sql.respond = () => ({
		status: 200,
		body: { columns: [], rows: [], row_count: 0, truncated: false, truncated_by: null, rows_affected: null, command: null, duration_ms: 3, limits: { max_rows: 500, timeout_seconds: 10, max_response_bytes: 1 } },
	});
	const result = await linked.call("omi_postgres_exec", EXEC);
	assert.equal(result.text, "app (local) en stage\nok · 0 filas afectadas · 3 ms");
});

test("un error con sqlstate conserva el aviso de login y la espera de Retry-After", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => ({ status: 429, body: { error: { code: "sql_busy", message: "ocupado", sqlstate: "53300", hint: "probá después" } }, headers: { "Retry-After": "7" } });
	await assert.rejects(linked.call("omi_postgres_query", { ...EXEC, sql: "SELECT 1" }), (error: OmiError) => error.hint === "esperá 7 segundos antes de volver a intentar · probá después");
	linked.sql.respond = () => sqlProblem(401, { code: "session_expired", message: "venció", sqlstate: "28000" });
	await assert.rejects(linked.call("omi_postgres_query", { ...EXEC, sql: "SELECT 1" }), (error: OmiError) => /omi login/.test(error.hint ?? ""));
});

test("sólo se elige un Postgres con una base activa, y nunca entre varios", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_nueva", "stage", "nueva", { state: "provisionando", active_revision: 0 });
	const seen: string[] = [];
	const guard = { surface: "cli" as const, canAsk: true, preApproved: false, stageAuthorized: false, grantStage() {}, ask: async () => (seen.push("pregunta"), true) };
	for (const params of [{ environment: "stage" }, { environment: "stage", slug: "nueva" }, { resourceId: "res_nueva" }]) {
		await assert.rejects(linked.call("omi_postgres_exec", { ...params, sql: "DELETE FROM t" }, { guard }), (error: OmiError) => {
			assert.equal(error.code, "resource_not_active");
			assert.match(error.message, /nueva.*provisionando/);
			return true;
		});
	}
	assert.deepEqual(seen, [], "no se pide confirmación para un recurso inutilizable");
	resource(linked, "res_app", "stage", "app");
	resource(linked, "res_redis", "stage", "cache", { engine: "redis" });
	await linked.call("omi_postgres_query", { environment: "stage", sql: "SELECT 1" });
	assert.deepEqual(linked.sql.calls.map((call) => call.resourceID), ["res_app"]);
	resource(linked, "res_otra", "stage", "otra", { state: "cambio_fallido" });
	await assert.rejects(linked.call("omi_postgres_query", { environment: "stage", sql: "SELECT 1" }), (error: OmiError) => error.code === "usage_error" && error.hint === "app (lista), otra (cambio_fallido)");
	await assert.rejects(linked.call("omi_postgres_query", { resourceId: "res_redis", sql: "SELECT 1" }), (error: OmiError) => error.code === "resource_not_found");
});

test("la CLI acepta un SQL que empieza con guion después de -- y lo sugiere si falta", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const ok = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--", "-- activos\nSELECT 1"], ok), 0, ok.errors());
	assert.equal(linked.sql.calls[0]?.body.sql, "-- activos\nSELECT 1");
	const missing = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "-- activos\nSELECT 1"], missing), 2);
	assert.match(missing.errors(), /empieza con un guion.*`--`.*--file -/s);
});

test("exec nunca se aprueba sin un humano: ni flags, ni archivo, ni stdin, ni variables de entorno", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const env = { OMI_POLL_INTERVAL_MS: "1", CI: "true", OMI_YES: "1", OMI_ASSUME_YES: "1", OMI_CONFIRM: "s", FORCE: "1" };
	const base = ["resources", "postgres", "exec", "--env", "stage"];
	for (const args of [[...base, "--yes", "--json", "DELETE FROM t"], [...base, "--yes", "--file", "-"], [...base, "--file", "-", "--json"]]) {
		const io = linked.io({ env, stdin: "s\nDELETE FROM t" });
		assert.equal(await run(args, io), 2, args.join(" "));
		assert.match(io.errors(), /guardrail_confirmation_required|requiere confirmación humana/);
		assert.deepEqual(io.prompts, []);
	}
	assert.deepEqual(linked.sql.calls, []);
	assert.deepEqual(linked.mutations(), []);
});

test("los errores de topes y de agente ausente llegan con el mensaje de OMI", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const limits = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--max-rows", "501", "SELECT 1"], limits), 1);
	assert.match(limits.errors(), /max_rows debe estar entre 1 y 500/);
	linked.sql.respond = () => sqlProblem(503, { code: "sql_agent_unavailable", message: "el agente del control plane no tomó la consulta: puede estar desconectado, ocupado o sin actualizar; no se ejecutó nada" });
	const agent = linked.io();
	assert.equal(await run(["resources", "postgres", "exec", "--env", "stage", "--json", "DELETE FROM t"], linked.io({ interactive: true, answers: ["s"] })), 1);
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--json", "SELECT 1"], agent), 1);
	assert.deepEqual(JSON.parse(agent.errors()), { error: { code: "sql_agent_unavailable", message: "el agente del control plane no tomó la consulta: puede estar desconectado, ocupado o sin actualizar; no se ejecutó nada" } });
});

test("ni la salida ni los errores de consultar y ejecutar llevan el token de la sesión", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const outputs: string[] = [];
	const collect = async (args: string[], options = {}): Promise<void> => {
		const io = linked.io(options);
		await run(args, io);
		outputs.push(io.output(), io.errors());
	};
	await collect(["resources", "postgres", "query", "--env", "stage", "--json", "SELECT 1"]);
	await collect(["resources", "postgres", "exec", "--env", "stage", "DELETE FROM t"], { interactive: true, answers: ["s"] });
	linked.sql.respond = () => sqlProblem(422, { code: "sql_error", message: "falló", sqlstate: "42601" });
	await collect(["resources", "postgres", "query", "--env", "stage", "SELECT 1"]);
	linked.sql.respond = () => ({ status: 200, stream: (response) => void response.socket?.destroy() });
	await collect(["resources", "postgres", "exec", "--env", "stage", "--json", "DELETE FROM t"], { interactive: true, answers: ["s"] });
	assert.ok(outputs.join("\n").length > 200);
	assert.doesNotMatch(outputs.join("\n"), /prs_test|Bearer/);
});
