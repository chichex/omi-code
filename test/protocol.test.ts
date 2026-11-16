import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { SqlResultSchema } from "../src/client/views.ts";
import * as protocol from "../src/protocol/constants.ts";

const source = readFileSync(new URL("../src/protocol/constants.ts", import.meta.url), "utf8");
const omiRepo = process.env.OMI_REPO;

test("protocolo_no arrastra nombres legacy de prama", () => {
	assert.doesNotMatch(source, /prama/i);
});

test("protocolo_define la URL y el override de la API", () => {
	assert.equal(protocol.DEFAULT_API_URL, "https://app.ohmyinfra.com");
	assert.equal(protocol.API_URL_ENV, "OMI_API_URL");
});

test("protocolo_define variables, headers y archivos", () => {
	assert.deepEqual(
		{
			env: [protocol.ENV_PORT, protocol.ENV_OMI_ENVIRONMENT, protocol.ENV_OMI_VERSION, protocol.RESERVED_ENV_PREFIX],
			ci: protocol.CI_REGISTRY_SECRET,
			trigger: protocol.ENV_TRIGGER_SECRET,
			headers: [protocol.HEADER_JOB, protocol.HEADER_SCHEDULED_AT, protocol.HEADER_ATTEMPT, protocol.HEADER_TIMESTAMP, protocol.HEADER_SIGNATURE],
			files: [protocol.PROJECT_LINK_FILE, protocol.OMI_HOME_DIR, protocol.CREDENTIALS_FILE],
			login: [protocol.HEADER_SESSION_TOKEN, protocol.SESSION_TOKEN_IN_BODY, protocol.SESSION_COOKIE],
		},
		{
			env: ["PORT", "OMI_ENVIRONMENT", "OMI_VERSION", "OMI_"],
			ci: "OMI_REGISTRY_PASSWORD",
			trigger: "OMI_TRIGGER_SECRET",
			headers: ["X-Omi-Job", "X-Omi-Scheduled-At", "X-Omi-Attempt", "X-Omi-Timestamp", "X-Omi-Signature"],
			files: [".omi/project.json", ".omi", "credentials.json"],
			login: ["X-Omi-Session-Token", "body", "__Host-omi_session"],
		},
	);
});

// Sólo corre con un checkout de chichex/omi: `OMI_REPO=../omi npm test`.
test("protocolo_coincide con el código de chichex/omi", { skip: omiRepo === undefined || !existsSync(join(omiRepo, "trigger/trigger.go")) }, () => {
	const read = (path: string): string => readFileSync(join(omiRepo ?? "", path), "utf8");
	const trigger = read("trigger/trigger.go");
	for (const header of [protocol.HEADER_JOB, protocol.HEADER_SCHEDULED_AT, protocol.HEADER_ATTEMPT, protocol.HEADER_TIMESTAMP, protocol.HEADER_SIGNATURE]) {
		assert.ok(trigger.includes(`"${header}"`), `${header} en trigger/trigger.go`);
	}
	assert.ok(read("internal/api/trigger_bundle.go").includes(`"${protocol.ENV_TRIGGER_SECRET}"`));
	const login = read("internal/api/login_http.go");
	assert.ok(login.includes(`"${protocol.HEADER_SESSION_TOKEN}"`), `${protocol.HEADER_SESSION_TOKEN} en internal/api/login_http.go`);
	assert.ok(login.includes(`"${protocol.SESSION_TOKEN_IN_BODY}"`), "valor del header en internal/api/login_http.go");
	assert.ok(read("internal/api/http.go").includes(`sessionCookieName = "${protocol.SESSION_COOKIE}"`), "cookie de sesión en internal/api/http.go");
	const variables = read("internal/api/variables.go");
	for (const name of [protocol.ENV_PORT, protocol.ENV_OMI_ENVIRONMENT, protocol.ENV_OMI_VERSION]) {
		assert.ok(variables.includes(`"${name}"`), `${name} en internal/api/variables.go`);
	}
	assert.ok(variables.includes(`"${protocol.RESERVED_ENV_PREFIX}"`), "prefijo reservado en internal/api/variables.go");
	assert.ok(read("internal/api/api.go").includes(`"${protocol.ROLE_OWNER}"`), "rol de dueño en internal/api/api.go");
	const kit = read("internal/api/kit.go");
	assert.ok(kit.includes(protocol.CI_REGISTRY_SECRET));
	assert.ok(kit.includes("50 << 20"));
	assert.equal(protocol.REGISTRY_CHUNK_BYTES, 50 << 20);
	const versions = read("internal/api/versions.go");
	for (const label of [protocol.LABEL_VERSION, protocol.LABEL_REVISION, protocol.LABEL_CREATED]) {
		assert.ok(versions.includes(label) || kit.includes(label), `${label} en la API`);
	}
});

// El contrato de SQL nace en chichex/omi#157: sin esos archivos en el checkout, se saltea.
test("protocolo_consultar y ejecutar SQL coinciden con el código de chichex/omi", { skip: omiRepo === undefined || !existsSync(join(omiRepo, "internal/api/sql_query_http.go")) }, () => {
	const read = (path: string): string => readFileSync(join(omiRepo ?? "", path), "utf8");
	const routes = read("internal/api/sql_query_http.go");
	assert.ok(routes.includes('/resources/{resourceID}"'), "ruta del recurso");
	for (const action of ["/query", "/exec"]) assert.ok(routes.includes(`base+"${action}"`), `POST …${action}`);
	const contract = read("internal/api/sql_query.go") + read("internal/api/sql_query_wire.go");
	// Campos que omi-code manda y los que SqlResultSchema exige o lee.
	const fields = ["sql", "max_rows", "timeout_seconds", "columns", "rows", "row_count", "truncated", "truncated_by", "rows_affected", "command", "duration_ms", "limits", "max_response_bytes"];
	for (const field of fields) assert.ok(new RegExp(`json:"${field}[",]`).test(contract), `campo ${field}`);
	for (const field of ["sqlstate", "detail", "hint", "position"]) assert.ok(routes.includes(`"${field}"`), `campo de error ${field}`);
	const codes = ["sql_error", "sql_timeout", "sql_connection_failed", "sql_agent_unavailable", "sql_outcome_unknown", "invalid_sql", "invalid_sql_limits"];
	for (const code of codes) assert.ok(contract.includes(`"${code}"`), `código ${code}`);
	// Los defaults que la ayuda y el README de omi-code le prometen al usuario.
	assert.ok(contract.includes("MaxRows: 500, Timeout: 10 * time.Second, MaxResponseBytes: 1 << 20"), "topes por defecto");
	// Las respuestas literales que los tests de la API exigen tienen que pasar el esquema con el que omi-code las lee.
	const bodies = [...read("internal/api/sql_query_internal_test.go").matchAll(/wantBody := ((?:`[^`]*`[ \t]*\+?\s*)+)/g)].map((match) =>
		[...(match[1] ?? "").matchAll(/`([^`]*)`/g)].map((segment) => segment[1] ?? "").join(""),
	);
	assert.equal(bodies.length, 2, "respuestas de lectura y de escritura en los tests de la API");
	for (const body of bodies) assert.ok(Value.Check(SqlResultSchema, JSON.parse(body)), `SqlResultSchema acepta ${body}`);
});
