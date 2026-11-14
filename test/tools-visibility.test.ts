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

/** Un ambiente con versión desplegada y su acceso ya reconciliado. */
function deployed(linked: Linked, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return Object.assign(environment(linked, name), { current_version: "1.0.0", state: "activo", access: { state: "listo" }, ...overrides });
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
		access_ready: false,
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

test("omi_visibility_set_reaplica la misma visibilidad si el bundle anterior falló", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage", { visibility: "publico", visibility_apply: { state: "fallida", last_error: "el agente no pudo aplicar el bundle" } });
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { guard: asking(true, seen) });
	assert.match(result.text, /api en stage: publico reaplicada · acceso listo/);
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
	deployed(linked, "stage");
	const progress: string[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { progress: (line) => progress.push(line) });
	assert.equal((result.data as { visibility_apply: string }).visibility_apply, "aplicada");
	assert.deepEqual(progress, ["visibilidad aplicando", "acceso pendiente", "acceso aplicando"]);
});

test("omi_visibility_set_si el bundle falla sale con error y el motivo", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage");
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

type Data = { visibility: string; visibility_apply: string; access: string; access_ready: boolean; access_error?: string; access_retry_at?: string };

// --- Un cambio en curso nunca se responde como "sin cambios" ---

test("omi_visibility_set_con un cambio reservado en curso espera y decide sobre el estado real", async (t) => {
	const linked = await linkedProject(t);
	// privado → publico reservado: omi-api mantiene `privado` mientras aplica.
	deployed(linked, "stage", { visibility_apply: { state: "aplicando" } });
	linked.platform.reservedVisibility.set("api/stage", "publico");
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "privado" }, { guard: asking(true, seen) });
	assert.equal(seen.length, 1);
	assert.match(seen[0]?.diff ?? "", /stage: publico → privado/);
	assert.deepEqual(linked.mutations(), [`PUT ${SERVICE}/environments/stage/visibility`]);
	assert.equal(environment(linked, "stage").visibility, "privado");
	assert.doesNotMatch(result.text, /ya es privado/);
	assert.match(result.text, /publico → privado/);
});

test("omi_visibility_set_repetir el pedido con el bundle todavía aplicando espera el resultado en vez de darlo por hecho", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage", { visibility: "publico", visibility_apply: { state: "aplicando" }, access: { state: "pendiente" } });
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { guard: asking(true, seen) });
	const data = result.data as Data;
	assert.deepEqual([data.visibility_apply, data.access, data.access_ready], ["aplicada", "listo", true]);
	assert.match(result.text, /ya es publico/);
	assert.deepEqual(seen, []);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_visibility_set_si el cambio en curso no termina sale con visibility_timeout y un diagnóstico que existe", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage", { visibility: "publico", visibility_apply: { state: "aplicando" } });
	linked.platform.visibilityOutcome = { state: "aplicando" };
	t.mock.timers.enable({ apis: ["Date"] });
	await assert.rejects(
		linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { progress: () => t.mock.timers.tick(6 * 60_000) }),
		(error: OmiError) => error.code === "visibility_timeout" && /omi status/.test(error.hint ?? ""),
	);
	t.mock.timers.reset();
	const status = await linked.call("omi_project_status", {});
	assert.match(status.text, /stage: .*visibilidad publico \(aplicando\)/);
});

// --- Éxito significa acceso listo ---

test("omi_visibility_set_con versión desplegada espera a que el acceso quede listo", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage");
	const progress: string[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { progress: (line) => progress.push(line) });
	const data = result.data as Data;
	assert.deepEqual([data.visibility, data.visibility_apply, data.access, data.access_ready], ["publico", "aplicada", "listo", true]);
	assert.notEqual(result.failed, true);
	assert.match(result.text, /api en stage: privado → publico · acceso listo/);
	assert.deepEqual(progress, ["visibilidad aplicando", "acceso pendiente", "acceso aplicando"]);
});

test("omi_visibility_set_si el acceso falla el resultado sale fallido con el motivo y el próximo reintento", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage");
	linked.platform.accessOutcome = { state: "fallido", last_error: "Cloudflare respondió 403", retry_at: "2026-11-14T12:00:30Z" };
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" });
	assert.equal(result.failed, true);
	const data = result.data as Data;
	assert.deepEqual([data.visibility, data.access, data.access_ready], ["publico", "fallido", false]);
	assert.equal(data.access_error, "Cloudflare respondió 403");
	assert.equal(data.access_retry_at, "2026-11-14T12:00:30Z");
	assert.match(result.text, /privado → publico/);
	assert.match(result.text, /el acceso falló: Cloudflare respondió 403/);
	assert.match(result.text, /OMI lo reintenta solo/);
});

test("omi_visibility_set_si el acceso no queda listo a tiempo el resultado sale fallido y dice en qué quedó", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage");
	linked.platform.accessOutcome = { state: "pendiente" };
	t.mock.timers.enable({ apis: ["Date"] });
	const result = await linked.call(
		"omi_visibility_set",
		{ environment: "stage", visibility: "publico" },
		{ progress: (line) => { if (line.startsWith("acceso")) t.mock.timers.tick(6 * 60_000); } },
	);
	assert.equal(result.failed, true);
	const data = result.data as Data;
	assert.deepEqual([data.visibility, data.visibility_apply, data.access, data.access_ready], ["publico", "aplicada", "pendiente", false]);
	assert.match(result.text, /el acceso sigue pendiente/);
	assert.match(result.text, /omi status/);
});

test("omi_visibility_set_sin versión desplegada no espera un acceso que no va a llegar y lo dice", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" });
	assert.notEqual(result.failed, true);
	assert.equal((result.data as Data).access_ready, false);
	assert.match(result.text, /sin versión desplegada/);
	assert.match(result.text, /primer deploy/);
});

// --- Sólo se confirma y se manda el PUT cuando omi-api va a hacer algo ---

test("omi_visibility_set_un acceso fallido sin cambio pendiente no pide confirmación ni manda un PUT que no hace nada", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage", { visibility: "publico", access: { state: "fallido", last_error: "Cloudflare respondió 403", retry_at: "2026-11-14T12:00:30Z" } });
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" }, { guard: asking(true, seen) });
	assert.deepEqual(seen, []);
	assert.deepEqual(linked.mutations(), []);
	assert.equal(result.failed, true);
	assert.doesNotMatch(result.text, /reaplicada/);
	assert.match(result.text, /ya es publico/);
	assert.match(result.text, /el acceso falló: Cloudflare respondió 403/);
	assert.match(result.text, /2026-11-14T12:00:30Z/);
});

test("omi_visibility_set_reintenta la misma visibilidad si quedó un cambio deshecho para reintentar", async (t) => {
	const linked = await linkedProject(t);
	// rollbackVisibilityReservation: acceso fallido con VisibilityRetry, que la vista muestra sin retry_at.
	deployed(linked, "stage", { access: { state: "fallido", last_error: "Cloudflare rechazó borrar el CNAME" } });
	linked.platform.visibilityRetry.set("api/stage", "publico");
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "privado" }, { guard: asking(true, seen) });
	assert.match(seen[0]?.diff ?? "", /stage: privado \(reintento\)/);
	assert.deepEqual(linked.mutations(), [`PUT ${SERVICE}/environments/stage/visibility`]);
	assert.match(result.text, /api en stage: privado reaplicada · acceso listo/);
	assert.notEqual(result.failed, true);
});

test("omi_visibility_set_si omi-api no hizo nada con el reintento, no informa reaplicada", async (t) => {
	const linked = await linkedProject(t);
	// Una omi-api que no manda retry_at: el acceso fallido parece reintentable, pero el PUT no cambia nada.
	deployed(linked, "stage", { visibility: "publico", access: { state: "fallido", last_error: "Cloudflare respondió 403" } });
	const result = await linked.call("omi_visibility_set", { environment: "stage", visibility: "publico" });
	assert.equal(result.failed, true);
	assert.doesNotMatch(result.text, /reaplicada/);
	assert.match(result.text, /el acceso falló: Cloudflare respondió 403/);
});

// --- `omi status` muestra el cambio de visibilidad ---

test("omi_project_status_muestra la visibilidad y un bundle fallido con su motivo", async (t) => {
	const linked = await linkedProject(t);
	deployed(linked, "stage", { visibility: "publico", visibility_apply: { state: "fallida", last_error: "el agente no pudo aplicar el bundle" } });
	const status = await linked.call("omi_project_status", {});
	assert.match(status.text, /stage: .*visibilidad publico \(fallida: el agente no pudo aplicar el bundle\)/);
	assert.match(status.text, /prod: .*visibilidad privado/);
	const stage = (status.data as { services: { environments: { name: string; visibility_apply?: { state: string } }[] }[] }).services[0]?.environments[0];
	assert.equal(stage?.visibility_apply?.state, "fallida");
});
