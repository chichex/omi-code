// `omi resources postgres query|exec`: leer es libre; ejecutar pide un humano en una terminal.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/main.ts";
import { sqlProblem } from "./helpers/mock-sql.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

function resource(linked: Linked, id: string, environment: string, slug: string): void {
	linked.workloads.resources.set(id, { id, environment, slug, mode: "local", variable: `POSTGRES_URL_${slug.toUpperCase()}`, state: "lista" });
}

test("omi resources postgres query_muestra una tabla sin pedir nada, también en prod y sin terminal", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "prod", "app");
	const io = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--env", "prod", "--slug", "app", "SELECT id, email, datos FROM usuarios"], io), 0, io.errors());
	assert.match(io.output(), /^app \(local\) en prod\nid \| email {8}\| datos/);
	assert.match(io.output(), /2 filas · truncado: no · 12 ms$/);
	assert.deepEqual(io.prompts, []);
	assert.deepEqual(linked.sql.calls, [{ action: "query", resourceID: "res_app", body: { sql: "SELECT id, email, datos FROM usuarios" } }]);
});

test("omi resources postgres query_--json es el resultado estructurado y manda los topes pedidos", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const io = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--resource-id", "res_app", "--max-rows", "50", "--timeout", "5", "--json", "SELECT 1"], io), 0, io.errors());
	assert.deepEqual(JSON.parse(io.output()), {
		resource: { id: "res_app", environment: "stage", slug: "app", mode: "local" },
		columns: [{ name: "id", type: "integer" }, { name: "email", type: "text" }, { name: "datos", type: "jsonb" }],
		rows: [[1, "ada@omi.test", { plan: "pro" }], [2, null, null]],
		row_count: 2,
		truncated: false,
		duration_ms: 12,
		limits: { max_rows: 50, timeout_seconds: 5, max_response_bytes: 1_048_576 },
	});
	assert.deepEqual(linked.sql.calls[0]?.body, { sql: "SELECT 1", max_rows: 50, timeout_seconds: 5 });
});

test("omi resources postgres query_lee el SQL de un archivo o de stdin", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	await writeFile(join(linked.repo, "consulta.sql"), "SELECT *\nFROM pagos\n");
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--file", "consulta.sql"], linked.io()), 0);
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--file", "-"], linked.io({ stdin: "SELECT 2" })), 0);
	assert.deepEqual(linked.sql.calls.map((call) => call.body.sql), ["SELECT *\nFROM pagos\n", "SELECT 2"]);
});

test("omi resources postgres query_sin SQL, con SQL repetido o con un número inválido es un error de uso", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	await writeFile(join(linked.repo, "consulta.sql"), "SELECT 1");
	const cases = [
		["resources", "postgres", "query", "--env", "stage"],
		["resources", "postgres", "query", "--env", "stage", "--file", "consulta.sql", "SELECT 1"],
		["resources", "postgres", "query", "--env", "stage", "SELECT", "1"],
		["resources", "postgres", "query", "--env", "stage", "--max-rows", "muchas", "SELECT 1"],
		["resources", "postgres", "query", "--env", "stage", "--file", "no-existe.sql"],
	];
	for (const args of cases) {
		const io = linked.io();
		assert.equal(await run(args, io), 2, `${args.join(" ")}: ${io.errors()}`);
	}
	assert.deepEqual(linked.sql.calls, []);
});

test("omi resources postgres query_un error de Postgres sale con 1 y con SQLSTATE en --json", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	linked.sql.respond = () => sqlProblem(422, { code: "sql_error", message: 'relation "pagos" does not exist', sqlstate: "42P01", position: 15 });
	const io = linked.io();
	assert.equal(await run(["resources", "postgres", "query", "--env", "stage", "--json", "SELECT * FROM pagos"], io), 1);
	assert.deepEqual(JSON.parse(io.errors()), {
		error: { code: "sql_error", message: 'relation "pagos" does not exist (SQLSTATE 42P01, posición 15)', sqlstate: "42P01", position: 15 },
	});
});

test("omi resources postgres exec_en una terminal muestra ambiente, base y SQL, y ejecuta con el sí", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const io = linked.io({ interactive: true, answers: ["s"] });
	assert.equal(await run(["resources", "postgres", "exec", "--env", "stage", "--slug", "app", "DELETE FROM pruebas WHERE id = 7"], io), 0, io.errors());
	assert.match(io.errors(), /Ejecutar SQL en Postgres app \(stage\)\nAmbiente: stage\nBase: app \(local\) · res_app\nSQL:\nDELETE FROM pruebas WHERE id = 7/);
	assert.deepEqual(io.prompts, ["¿Confirmás? [s/N] "]);
	assert.deepEqual(linked.sql.calls, [{ action: "exec", resourceID: "res_app", body: { sql: "DELETE FROM pruebas WHERE id = 7" } }]);
	assert.equal(io.output(), "app (local) en stage\nDELETE 1 · 1 fila afectada · 7 ms");
});

test("omi resources postgres exec_--yes en una terminal no ahorra la confirmación y un no la frena", async (t) => {
	const linked = await linkedProject(t);
	resource(linked, "res_app", "stage", "app");
	const io = linked.io({ interactive: true, answers: ["n"] });
	assert.equal(await run(["resources", "postgres", "exec", "--env", "stage", "--yes", "DROP TABLE pagos"], io), 2);
	assert.match(io.errors(), /--yes no aprueba esta operación/);
	assert.deepEqual(io.prompts, ["¿Confirmás? [s/N] "]);
	assert.deepEqual(linked.sql.calls, []);
});

test("omi resources --help explica consultar y ejecutar", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["resources", "--help"], io), 0);
	assert.match(io.output(), /omi resources postgres query --env <stage\|prod> .*"<sql>"/);
	assert.match(io.output(), /omi resources postgres exec --env <stage\|prod> .*"<sql>"/);
	assert.match(io.output(), /Consultar es de sólo lectura y no pide confirmación en ningún ambiente/);
	assert.match(io.output(), /Ejecutar SQL siempre pide confirmación en una terminal interactiva; --yes no la reemplaza\./);
});
