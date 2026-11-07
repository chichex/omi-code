import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

function stage(linked: Linked): { variables: { name: string; secret: boolean; value: string | null }[]; current_version?: string } {
	const view = linked.project.services.get("api")?.view.environments.find((environment) => environment.name === "stage");
	return view as never;
}

function seedVariables(linked: Linked): void {
	stage(linked).variables = [
		{ name: "LOG_LEVEL", secret: false, value: "info" },
		{ name: "TOKEN", secret: true, value: null },
	];
}

const PUT_PATH = "PUT /api/v1/organizations/org_acme/projects/tienda/services/api/environments/stage/variables";

test("omi_project_status_consolida services, ambientes, versiones y último deploy", async (t) => {
	const linked = await linkedProject(t);
	const view = linked.project.services.get("api")?.view;
	assert.ok(view);
	view.versions = [{ tag: "1.0.0", digest: "sha256:aaa", revision: "abc", created: "2026-09-21", prerelease: false, rewritten: false, first_seen_at: "2026-09-21T12:00:00Z" }];
	view.version_scan = { state: "completo", last_attempt_at: "2026-09-21T12:00:00Z", last_complete_at: "2026-09-21T12:00:00Z", failed_services: 0, interval_seconds: 60 };
	const environment = stage(linked) as unknown as Record<string, unknown>;
	environment.state = "corriendo";
	environment.current_version = "1.0.0";
	environment.access = { state: "listo", url: "https://api-stage-acme.ohmyinfra.test" };
	environment.last_deployment = { id: "dep_1", service: "api", environment: "stage", to_version: "1.0.0", strategy: "rolling", status: "exitoso", requested_by: "Ada", automatic: false, steps: [], target_instances: 1, created_at: "2026-09-21T12:00:00Z" };

	const result = await linked.call("omi_project_status", {});

	const data = result.data as { project: string; services: { name: string; versions: string[]; version_scan: { state: string }; environments: { name: string; current_version?: string; access: { state: string }; last_deployment?: { status: string } }[] }[] };
	assert.equal(data.project, "tienda");
	const [service] = data.services;
	assert.equal(service?.name, "api");
	assert.deepEqual(service?.versions, ["1.0.0"]);
	assert.equal(service?.version_scan.state, "completo");
	const reported = service?.environments.find((candidate) => candidate.name === "stage");
	assert.equal(reported?.current_version, "1.0.0");
	assert.equal(reported?.access.state, "listo");
	assert.equal(reported?.last_deployment?.status, "exitoso");
	assert.match(result.text, /api/);
	assert.match(result.text, /stage/);
});

test("omi_env_list_muestra valores normales y sólo el nombre de los secretos", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	const result = await linked.call("omi_env_list", { service: "api", environment: "stage" });
	const data = result.data as { variables: { name: string; secret: boolean; value: string | null }[] };
	assert.deepEqual(data.variables, [
		{ name: "LOG_LEVEL", secret: false, value: "info" },
		{ name: "TOKEN", secret: true, value: null },
	]);
	assert.match(result.text, /TOKEN \(secreto\)/);
});

test("omi_env_set_reemplaza la lista completa y preserva los secretos con value null", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	await linked.call("omi_env_set", { service: "api", environment: "stage", set: [{ name: "FEATURE", value: "on" }] });
	const put = linked.omi.requests.find((request) => request.method === "PUT");
	assert.deepEqual(put?.body, {
		variables: [
			{ name: "FEATURE", secret: false, value: "on" },
			{ name: "LOG_LEVEL", secret: false, value: "info" },
			{ name: "TOKEN", secret: true, value: null },
		],
	});
	assert.equal(put?.idempotencyKey === undefined, false);
});

test("omi_env_set_quita una variable sin tocar las demás", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	await linked.call("omi_env_set", { service: "api", environment: "stage", unset: ["LOG_LEVEL"] });
	assert.deepEqual(stage(linked).variables, [{ name: "TOKEN", secret: true, value: null }]);
});

for (const name of ["PORT", "OMI_ENVIRONMENT", "OMI_LOQUESEA", "POSTGRES_URL_MEDICINE", "minuscula"]) {
	test(`omi_env_set_rechaza ${name} en el cliente sin llamar a la API`, async (t) => {
		const linked = await linkedProject(t);
		await assert.rejects(
			linked.call("omi_env_set", { service: "api", environment: "stage", set: [{ name, value: "x" }] }),
			(error: OmiError) => error.exitCode === 2 && error.message.includes(name),
		);
		assert.deepEqual(linked.mutations(), []);
	});
}

test("omi_env_set_toma un secreto de una variable local y nunca lo devuelve", async (t) => {
	const linked = await linkedProject(t);
	const progress: string[] = [];
	const result = await linked.call(
		"omi_env_set",
		{ service: "api", environment: "stage", secrets: [{ name: "API_KEY", fromEnv: "MI_CLAVE" }] },
		{ io: linked.io({ env: { MI_CLAVE: "valor-ultrasecreto" } }), progress: (text) => progress.push(text) },
	);
	assert.equal(linked.workloads.secrets.get("stage/API_KEY"), "valor-ultrasecreto");
	const seen = JSON.stringify(result) + progress.join("\n");
	assert.doesNotMatch(seen, /valor-ultrasecreto/);
	assert.match(result.text, /API_KEY/);
});

test("omi_env_set_pide el secreto por el canal oculto del humano", async (t) => {
	const linked = await linkedProject(t);
	const asked: string[] = [];
	await linked.call(
		"omi_env_set",
		{ service: "api", environment: "stage", secrets: [{ name: "API_KEY" }] },
		{
			readSecret: async (name) => {
				asked.push(name);
				return "tipeado";
			},
		},
	);
	assert.deepEqual(asked, ["API_KEY"]);
	assert.equal(linked.workloads.secrets.get("stage/API_KEY"), "tipeado");
});

test("omi_env_set_sin canal para el secreto falla con una salida accionable", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_env_set", { service: "api", environment: "stage", secrets: [{ name: "API_KEY" }] }),
		(error: OmiError) => error.code === "secret_input_unavailable" && /fromEnv/.test(error.hint ?? ""),
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_env_set_no acepta el valor de un secreto existente como texto del modelo", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	await assert.rejects(
		linked.call("omi_env_set", { service: "api", environment: "stage", set: [{ name: "TOKEN", value: "filtrado" }] }),
		(error: OmiError) => error.code === "secret_requires_input",
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_env_set_el parámetro no tiene campo de valor para secretos", async (t) => {
	const { CATALOG } = await import("../src/tools/catalog.ts");
	const tool = CATALOG.find((candidate) => candidate.name === "omi_env_set");
	const schema = JSON.stringify(tool?.parameters);
	assert.match(schema, /fromEnv/);
	assert.equal(/"secrets":\{[^}]*"value"/.test(schema), false);
	await linkedProject(t);
});

for (const [name, params, overrides] of [
	["un secreto nuevo en stage", { service: "api", environment: "stage", secrets: [{ name: "API_KEY", fromEnv: "HOME" }] }, humanless(true)],
	["borrar un secreto", { service: "api", environment: "stage", unset: ["TOKEN"] }, humanless(true)],
	["una variable en prod", { service: "api", environment: "prod", set: [{ name: "FEATURE", value: "on" }] }, humanless(true)],
	["una variable en stage sin sesión autorizada", { service: "api", environment: "stage", set: [{ name: "FEATURE", value: "on" }] }, humanless(false)],
] as const) {
	test(`omi_env_set_sin humano bloquea ${name} antes de mutar`, async (t) => {
		const linked = await linkedProject(t);
		seedVariables(linked);
		await assert.rejects(
			linked.call("omi_env_set", params, { guard: overrides, io: linked.io({ env: { HOME: "/x" } }) }),
			(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
		);
		assert.deepEqual(linked.mutations(), []);
	});
}

test("omi_env_set_en stage autorizado corre sin preguntar", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_env_set", { service: "api", environment: "stage", set: [{ name: "FEATURE", value: "on" }] }, { guard: humanless(true) });
	assert.deepEqual(linked.mutations(), [PUT_PATH]);
});

test("omi_env_set_muestra al humano el diff exacto sin valores de secretos", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	const seen: string[] = [];
	await linked.call(
		"omi_env_set",
		{ service: "api", environment: "stage", set: [{ name: "LOG_LEVEL", value: "debug" }], unset: ["TOKEN"], secrets: [{ name: "NUEVO", fromEnv: "CLAVE" }] },
		{
			io: linked.io({ env: { CLAVE: "no-mostrar" } }),
			guard: {
				surface: "tui",
				canAsk: true,
				preApproved: false,
				stageAuthorized: false,
				grantStage() {},
				ask: async (action) => {
					seen.push(action.diff);
					return true;
				},
			},
		},
	);
	assert.equal(seen.length, 1);
	assert.match(seen[0] ?? "", /~ LOG_LEVEL: info → debug/);
	assert.match(seen[0] ?? "", /- TOKEN \(secreto\)/);
	assert.match(seen[0] ?? "", /\+ NUEVO \(secreto\).*\$CLAVE/);
	assert.doesNotMatch(seen[0] ?? "", /no-mostrar/);
});

test("omi_env_set preserva cambios ajenos hechos durante la confirmación", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	await linked.call("omi_env_set", { environment: "stage", set: [{ name: "LOG_LEVEL", value: "debug" }] }, {
		guard: { ...humanless(), canAsk: true, ask: async () => {
			stage(linked).variables.push({ name: "FEATURE_X", secret: false, value: "on" });
			return true;
		} },
	});
	assert.ok(stage(linked).variables.some((v) => v.name === "FEATURE_X" && v.value === "on"));
	assert.ok(stage(linked).variables.some((v) => v.name === "LOG_LEVEL" && v.value === "debug"));
});

test("omi_env_set rechaza sobrescribir un target que cambió mientras se aprobaba el diff", async (t) => {
	const linked = await linkedProject(t);
	seedVariables(linked);
	await assert.rejects(linked.call("omi_env_set", { environment: "stage", unset: ["LOG_LEVEL"] }, {
		guard: { ...humanless(), canAsk: true, ask: async () => {
			stage(linked).variables[0] = { name: "LOG_LEVEL", secret: true, value: null };
			return true;
		} },
	}), (error: OmiError) => error.code === "variables_changed");
	assert.deepEqual(linked.mutations(), []);
});

test("omi_env_set_rechaza un ambiente que el service no tiene", async (t) => {
	const linked = await linkedProject(t);
	linked.project.services.get("api")?.view.environments.pop();
	await assert.rejects(
		linked.call("omi_env_set", { service: "api", environment: "prod", set: [{ name: "A", value: "b" }] }),
		(error: OmiError) => error.code === "environment_not_found",
	);
});
