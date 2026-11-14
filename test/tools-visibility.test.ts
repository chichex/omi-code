import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import type { Guard, GuardedAction } from "../src/guardrails/policy.ts";
import { Problem } from "./helpers/mock-omi.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

const SERVICE = "/api/v1/organizations/org_acme/projects/tienda/services/api";

function environment(linked: Linked, name: string): Record<string, unknown> {
	const view = linked.project.services.get("api")?.view.environments.find((candidate) => candidate.name === name);
	assert.ok(view);
	return view;
}

function asking(answer: boolean, seen: GuardedAction[]): Guard {
	return { ...humanless(true), canAsk: true, ask: async (action) => { seen.push(action); return answer; } };
}

test("omi_visibility_set_hace público un ambiente con un PUT idempotente", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" });
	assert.deepEqual(linked.mutations(), [`PUT ${SERVICE}/environments/stage/visibility`]);
	const put = linked.omi.requests.find((request) => request.method === "PUT");
	assert.deepEqual(put?.body, { visibility: "publico" });
	assert.match(put?.idempotencyKey ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(environment(linked, "stage").visibility, "publico");
	assert.deepEqual(result.data, {
		service: "api",
		environment: "stage",
		visibility: "publico",
		previous: "privado",
		hostname: "api-stage-acme.ohmyinfra.test",
		visibility_apply: "aplicada",
		access: "pendiente",
	});
	assert.match(result.text, /api en stage: privado → publico/);
	assert.match(result.text, /acceso pendiente/);
});

test("omi_visibility_set_pide confirmación humana también en stage autorizado y muestra la exposición", async (t) => {
	const linked = await linkedProject(t);
	const seen: GuardedAction[] = [];
	await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { guard: asking(true, seen) });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.operation, "visibility");
	assert.equal(seen[0]?.environment, "stage");
	assert.match(seen[0]?.summary ?? "", /Visibilidad de api en stage/);
	assert.match(seen[0]?.diff ?? "", /stage: privado → publico/);
	assert.match(seen[0]?.diff ?? "", /publica api-stage-acme\.ohmyinfra\.test en internet/);
});

test("omi_visibility_set_un no del humano no cambia nada", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_visibility_set", { environment: "prod", visibility: "publico" }, { guard: asking(false, []) }),
		(error: OmiError) => error.code === "guardrail_declined",
	);
	assert.deepEqual(linked.mutations(), []);
	assert.equal(environment(linked, "prod").visibility, "privado");
});

test("omi_visibility_set_sin humano queda bloqueado en stage y en prod", async (t) => {
	const linked = await linkedProject(t);
	for (const name of ["stage", "prod"]) {
		await assert.rejects(
			linked.call("omi_visibility_set", { environment: name, visibility: "publico" }, { guard: humanless(true) }),
			(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED && /privado → publico/.test(error.hint ?? ""),
		);
	}
	assert.deepEqual(linked.mutations(), []);
});

test("omi_visibility_set_retirar un ambiente público avisa que sale de internet", async (t) => {
	const linked = await linkedProject(t);
	environment(linked, "prod").visibility = "publico";
	const seen: GuardedAction[] = [];
	await linked.call("omi_visibility_set", { environment: "prod", visibility: "organizacion" }, { guard: asking(true, seen) });
	assert.match(seen[0]?.diff ?? "", /prod: publico → organizacion/);
	assert.match(seen[0]?.diff ?? "", /retira api-prod-acme\.ohmyinfra\.test de internet/);
	assert.equal(environment(linked, "prod").visibility, "organizacion");
});

test("omi_visibility_set_sin cambios no pregunta ni muta", async (t) => {
	const linked = await linkedProject(t);
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "privado" }, { guard: asking(true, seen) });
	assert.match(result.text, /ya es privado/);
	assert.deepEqual(seen, []);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_visibility_set_reaplica la misma visibilidad si el intento anterior falló", async (t) => {
	const linked = await linkedProject(t);
	Object.assign(environment(linked, "stage"), { visibility: "publico", access: { state: "fallido", last_error: "Cloudflare respondió 403" } });
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { guard: asking(true, seen) });
	assert.match(result.text, /api en stage: publico reaplicada/);
	assert.match(seen[0]?.diff ?? "", /stage: publico \(reintento\)/);
	assert.deepEqual(linked.mutations(), [`PUT ${SERVICE}/environments/stage/visibility`]);
});

test("omi_visibility_set_un rechazo de la API sale con su código", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.visibilityProblem = new Problem(409, "visibility_in_progress", "la visibilidad ya se está aplicando");
	await assert.rejects(
		linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }),
		(error: OmiError) => error.code === "visibility_in_progress" && error.exitCode === 1 && /ya se está aplicando/.test(error.message),
	);
});

test("omi_visibility_set_con una versión desplegada espera a que el bundle se aplique", async (t) => {
	const linked = await linkedProject(t);
	environment(linked, "stage").current_version = "1.0.0";
	const progress: string[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { progress: (line) => progress.push(line) });
	assert.equal((result.data as { visibility_apply: string }).visibility_apply, "aplicada");
	assert.deepEqual(progress, ["visibilidad aplicando"]);
});

test("omi_visibility_set_si el bundle falla sale con error y el motivo", async (t) => {
	const linked = await linkedProject(t);
	environment(linked, "stage").current_version = "1.0.0";
	linked.platform.visibilityOutcome = { state: "fallida", last_error: "el agente no pudo aplicar el bundle" };
	await assert.rejects(
		linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }),
		(error: OmiError) => error.code === "visibility_apply_failed" && /el agente no pudo aplicar el bundle/.test(error.message),
	);
});

test("omi_visibility_set_sigue una mutación en cola hasta su resultado", async (t) => {
	const linked = await linkedProject(t);
	linked.omi.queueNext(1);
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" });
	assert.equal((result.data as { visibility: string }).visibility, "publico");
	assert.ok(linked.omi.requests.some((request) => request.path.includes("/queued-mutations/")));
});

test("omi_visibility_set_una omi-api sin visibility_apply falla antes de mutar y no rompe las demás tools", async (t) => {
	const linked = await linkedProject(t);
	delete environment(linked, "stage").visibility_apply;
	delete environment(linked, "prod").visibility_apply;
	await assert.rejects(
		linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }),
		(error: OmiError) => error.code === "unexpected_response" && /respuesta inesperada de OMI/.test(error.message),
	);
	assert.deepEqual(linked.mutations(), []);
	const status = await linked.call("omi_project_status", {});
	assert.match(status.text, /stage: sin_version/);
});
