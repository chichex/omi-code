import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

const CONNECTION = "postgres://u:clave-real@db.example.com:5432/app?sslmode=require";

function connectionIo(linked: Linked) {
	return linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", MI_DB: CONNECTION } });
}

test("omi_resources_list_lista recursos sin conexión y filtra por ambiente", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" });
	const result = await linked.call("omi_resources_list", { environment: "stage" });
	const data = result.data as { resources: { slug: string; variable: string; mode: string }[] };
	assert.deepEqual(data.resources.map((resource) => [resource.slug, resource.variable, resource.mode]), [["app", "POSTGRES_URL_APP", "local"]]);
	assert.match(linked.omi.requests.at(-1)?.path ?? "", /resources\?environment=stage$/);
});

test("omi_postgres_manage_alta externa sigue vista previa, confirmación y operación", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call(
		"omi_postgres_manage",
		{ action: "create", environment: "stage", slug: "app", connectionFromEnv: "MI_DB" },
		{ io: connectionIo(linked) },
	);
	const paths = linked.mutations().map((line) => line.replace("/api/v1/organizations/org_acme/projects/tienda", ""));
	assert.deepEqual(paths, ["POST /resource-previews", "POST /resource-previews/rpv_1/confirm"]);
	assert.deepEqual(linked.omi.requests.find((request) => request.path.endsWith("/resource-previews"))?.body, {
		action: "create",
		environment: "stage",
		slug: "app",
		connection: CONNECTION,
	});
	assert.equal((result.data as { state: string }).state, "exitoso");
	assert.doesNotMatch(JSON.stringify(result), /clave-real/);
});

test("omi_postgres_manage_alta local manda mode, versión y tamaño y ninguna conexión", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local", version: "17", size: "S" });
	assert.deepEqual(linked.omi.requests.find((request) => request.path.endsWith("/resource-previews"))?.body, {
		action: "create",
		environment: "stage",
		slug: "app",
		mode: "local",
		version: "17",
		size: "S",
	});
});

test("omi_postgres_manage_baja confirma con el nombre del recurso", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" });
	await linked.call("omi_postgres_manage", { action: "delete", resourceId: "res_app" });
	const confirm = linked.omi.requests.filter((request) => request.path.endsWith("/confirm")).at(-1);
	assert.deepEqual(confirm?.body, { include_pending_configuration: false, confirmation_name: "app" });
	assert.equal(linked.workloads.resources.size, 0);
});

test("omi_postgres_manage_replace toma la conexión nueva de una variable local", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", connectionFromEnv: "MI_DB" }, { io: connectionIo(linked) });
	await linked.call("omi_postgres_manage", { action: "replace", resourceId: "res_app", connectionFromEnv: "MI_DB" }, { io: connectionIo(linked) });
	const previews = linked.omi.requests.filter((request) => request.path.endsWith("/resource-previews"));
	assert.deepEqual(previews.at(-1)?.body, { action: "replace", resource_id: "res_app", connection: CONNECTION });
});

test("omi_postgres_manage_incluye la configuración pendiente sólo si la vista previa la marca", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.pendingConfiguration = true;
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" });
	const confirm = linked.omi.requests.find((request) => request.path.endsWith("/confirm"));
	assert.deepEqual(confirm?.body, { include_pending_configuration: true, confirmation_name: "" });
});

test("omi_postgres_manage_sin humano no manda nada a la API, ni la vista previa", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_postgres_manage_muestra el impacto de la vista previa antes de confirmar", async (t) => {
	const linked = await linkedProject(t);
	const seen: string[] = [];
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" }, {
		guard: {
			surface: "tui",
			canAsk: true,
			preApproved: false,
			stageAuthorized: true,
			grantStage() {},
			ask: async (action) => {
				seen.push(action.diff);
				assert.ok(!linked.omi.requests.some((request) => request.path.endsWith("/confirm")));
				return true;
			},
		},
	});
	assert.match(seen[0] ?? "", /POSTGRES_URL_APP/);
	assert.match(seen[0] ?? "", /api/);
});

test("omi_postgres_manage_una operación fallida sale con error y su motivo", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.operationOutcome = "fallido";
	await assert.rejects(
		linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" }),
		(error: OmiError) => error.code === "resource_operation_failed" && /SELECT 1 falló/.test(error.message),
	);
});

test("omi_postgres_manage muestra el origen de la conexión sin exponer su valor", async (t) => {
	const linked = await linkedProject(t);
	const seen: string[] = [];
	await linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", connectionFromEnv: "MI_DB" }, {
		io: connectionIo(linked), guard: { ...humanless(), canAsk: true, ask: async (action) => { seen.push(action.diff); return true; } },
	});
	assert.match(seen.join("\n"), /\$MI_DB/);
	assert.doesNotMatch(seen.join("\n"), /clave-real/);
});

test("omi_postgres_manage sale con un diagnóstico accionable si la recuperación requiere otra conexión", async (t) => {
	const linked = await linkedProject(t);
	linked.omi.route("GET /api/v1/organizations/{organizationID}/projects/{projectSlug}/resource-operations/{operationID}", () => ({
		status: 200, body: { id: "rop_1", resource_id: "res_app", state: "reconciliando", error: "el baseline se restauró; aportá otra conexión para completar la recuperación" },
	}));
	await assert.rejects(linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app", mode: "local" }, {
		signal: AbortSignal.timeout(500),
	}), (error: OmiError) => error.code === "resource_recovery_required" && /otra conexión/.test(error.message));
});

test("omi_postgres_manage_una alta externa exige conexión por variable local", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_postgres_manage", { action: "create", environment: "stage", slug: "app" }),
		(error: OmiError) => error.code === "secret_input_unavailable",
	);
	assert.deepEqual(linked.mutations(), []);
});
