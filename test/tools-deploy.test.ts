import assert from "node:assert/strict";
import { test } from "node:test";
import type { OmiError } from "../src/core/errors.ts";
import { GUARDRAIL_CONFIRMATION_REQUIRED } from "../src/core/errors.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

function withVersions(linked: Linked, ...tags: string[]): void {
	const view = linked.project.services.get("api")?.view;
	if (view !== undefined) view.versions = tags.map((tag) => ({ tag, prerelease: false }));
}

function environment(linked: Linked, name: string): Record<string, unknown> {
	const view = linked.project.services.get("api")?.view.environments.find((candidate) => candidate.name === name);
	assert.ok(view);
	return view;
}

const deploy = { service: "api", environment: "stage", version: "1.1.0" };
const deployments = "/api/v1/organizations/org_acme/projects/tienda/services/api/environments";

test("omi_deploy_lanza el deploy y sigue los pasos hasta exitoso", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const progress: string[] = [];

	const result = await linked.call("omi_deploy", deploy, { progress: (text) => progress.push(text) });

	const post = linked.omi.requests.find((request) => request.method === "POST");
	assert.equal(post?.path, `${deployments}/stage/deployments`);
	assert.deepEqual(post?.body, { version: "1.1.0" });
	assert.deepEqual(progress, ["inicio", "instancia_creada api-abc", "instancia_lista api-abc", "instancia_bajada api-old", "fin"]);
	const data = result.data as { status: string; to_version: string };
	assert.equal(data.status, "exitoso");
	assert.equal(data.to_version, "1.1.0");
	assert.equal(environment(linked, "stage").current_version, "1.1.0");
});

test("omi_deploy_un deploy en cola sigue el recibo antes de observar los pasos", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	linked.omi.queueNext(1);
	const result = await linked.call("omi_deploy", deploy);
	assert.equal((result.data as { status: string }).status, "exitoso");
	assert.ok(linked.omi.requests.some((request) => request.path.includes("/queued-mutations/")));
});

test("omi_deploy_un deploy fallido sale con error y apunta a los crash logs", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	linked.workloads.deployOutcome = { status: "fallido", error: "readiness vencida", instance_log_id: "ilog_1" };
	await assert.rejects(linked.call("omi_deploy", deploy), (error: OmiError) => {
		assert.equal(error.code, "deployment_failed");
		assert.match(error.message, /readiness vencida/);
		assert.match(error.hint ?? "", /ilog_1/);
		return true;
	});
});

test("omi_deploy_en stage autorizado corre sin humano", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	await linked.call("omi_deploy", deploy, { guard: humanless(true) });
	assert.equal(environment(linked, "stage").current_version, "1.1.0");
});

test("omi_deploy_a prod sin humano no llega a la API", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	await assert.rejects(
		linked.call("omi_deploy", { ...deploy, environment: "prod" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_deploy_muestra el salto de versión al confirmar", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	environment(linked, "prod").current_version = "1.0.0";
	const seen: string[] = [];
	await linked.call("omi_deploy", { ...deploy, environment: "prod" }, {
		guard: { surface: "tui", canAsk: true, preApproved: false, stageAuthorized: true, grantStage() {}, ask: async (action) => {
			seen.push(action.diff);
			return true;
		} },
	});
	assert.match(seen[0] ?? "", /1\.0\.0 → 1\.1\.0/);
});

test("omi_promote_promueve a prod la versión que corre en stage", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	environment(linked, "stage").current_version = "1.1.0";
	environment(linked, "prod").promotion = { version: "1.1.0" };
	const result = await linked.call("omi_promote", { service: "api" });
	const post = linked.omi.requests.find((request) => request.method === "POST");
	assert.equal(post?.path, `${deployments}/prod/deployments`);
	assert.deepEqual(post?.body, { version: "1.1.0" });
	assert.equal((result.data as { environment: string }).environment, "prod");
});

test("omi_promote_respeta blocked_reason, que la API no valida", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	environment(linked, "prod").promotion = { version: "1.1.0", blocked_reason: "same_version" };
	await assert.rejects(linked.call("omi_promote", { service: "api" }), (error: OmiError) => error.code === "promotion_blocked" && /same_version/.test(error.message));
	assert.deepEqual(linked.mutations(), []);
});

test("omi_promote_siempre exige un humano", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	environment(linked, "prod").promotion = { version: "1.1.0" };
	await assert.rejects(
		linked.call("omi_promote", { service: "api" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_promote_sin ambiente prod da un error claro", async (t) => {
	const linked = await linkedProject(t);
	linked.project.services.get("api")?.view.environments.pop();
	await assert.rejects(linked.call("omi_promote", { service: "api" }), (error: OmiError) => error.code === "environment_not_found");
});
