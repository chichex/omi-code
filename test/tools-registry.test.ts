import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import type { Guard, GuardedAction } from "../src/guardrails/policy.ts";
import { hostView } from "./helpers/mock-platform.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

const ORG = "/api/v1/organizations/org_acme";

test("omi_registry_manage status_sin registry lo informa sin fallar", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_registry_manage", { action: "status" });
	assert.match(result.text, /acme todavía no tiene registry/);
	assert.deepEqual(result.data, { organization: "acme", registry: null });
	assert.notEqual(result.failed, true);
	assert.deepEqual(linked.omi.requests.at(-1), { ...linked.omi.requests.at(-1), method: "GET", path: `${ORG}/registry` });
});

test("omi_registry_manage status_muestra estado, host, hostname y ruta pública", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.registry = {
		state: "disponible",
		host_id: "hst_cp",
		host_name: "cp",
		hostname: "registry-acme.ohmyinfra.test",
		push_username: "ci-push",
		public_route: "error",
		route_error: "Cloudflare respondió 403",
		images: [],
	};
	const result = await linked.call("omi_registry_manage", { action: "status" });
	assert.match(result.text, /registry-acme\.ohmyinfra\.test/);
	assert.match(result.text, /disponible/);
	assert.match(result.text, /cp/);
	assert.match(result.text, /ruta pública: error \(Cloudflare respondió 403\)/);
	assert.equal((result.data as { registry: { state: string } }).registry.state, "disponible");
});

test("omi_registry_manage status_propaga el error de la API con su código", async (t) => {
	const linked = await linkedProject(t);
	linked.omi.sessions.set("prs_test", "expired");
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "status" }),
		(error: OmiError) => error.code === "session_expired" && error.hint === "corré `omi login`",
	);
});

test("omi_registry_manage hosts_lista los hosts y cuáles pueden alojar el registry", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.hosts.push(hostView("hst_worker", { is_control_plane: false, registry_eligible: false }));
	const result = await linked.call("omi_registry_manage", { action: "hosts" });
	assert.match(result.text, /hst_cp cp: disponible · puede alojar el registry/);
	assert.match(result.text, /hst_worker worker: disponible · no puede alojar el registry/);
	const { hosts } = result.data as { hosts: { id: string; registry_eligible: boolean }[] };
	assert.deepEqual(hosts.map((host) => [host.id, host.registry_eligible]), [["hst_cp", true], ["hst_worker", false]]);
	assert.equal(linked.omi.requests.at(-1)?.path, `${ORG}/hosts`);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_registry_manage_fuera de un repo vinculado usa la organización de la sesión", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_registry_manage", { action: "status" }, { io: linked.io({ cwd: linked.home }) });
	assert.deepEqual(result.data, { organization: "acme", registry: null });
});

test("omi_registry_manage_una organización ajena se rechaza antes de consultar el registry", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "status", organizationSlug: "otra" }),
		(error: OmiError) => error.code === "organization_not_member",
	);
	assert.ok(!linked.omi.requests.some((request) => request.path.endsWith("/registry")));
});

const PASSWORD = "push-clave-de-un-solo-uso";

function passwordFile(linked: Linked): string {
	return join(linked.home, ".omi", "registry", "acme.push-password");
}

function asking(answer: boolean, seen: GuardedAction[]): Guard {
	return { ...humanless(true), canAsk: true, ask: async (action) => { seen.push(action); return answer; } };
}

test("omi_registry_manage create_aloja el registry en el host pedido y guarda la credencial sin mostrarla", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" });
	assert.deepEqual(linked.mutations(), [`POST ${ORG}/registry`]);
	assert.deepEqual(linked.omi.requests.at(-1)?.body, { host_id: "hst_cp" });
	const data = result.data as { organization: string; registry: { hostname: string; state: string }; push_password_file: string };
	assert.equal(data.registry.hostname, "registry-acme.ohmyinfra.test");
	assert.equal(data.push_password_file, passwordFile(linked));
	assert.equal(await readFile(passwordFile(linked), "utf8"), PASSWORD);
	assert.equal((await stat(passwordFile(linked))).mode & 0o777, 0o600);
	assert.doesNotMatch(JSON.stringify(result), new RegExp(PASSWORD));
	assert.match(result.text, /OMI_REGISTRY_PASSWORD/);
	assert.ok(result.text.includes(passwordFile(linked)));
});

test("omi_registry_manage create_sin hostId usa el único host que puede alojarlo", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.hosts.push(hostView("hst_worker", { is_control_plane: false, registry_eligible: false }));
	await linked.call("omi_registry_manage", { action: "create" });
	assert.deepEqual(linked.omi.requests.at(-1)?.body, { host_id: "hst_cp" });
});

test("omi_registry_manage create_con varios hosts posibles exige elegir uno", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.hosts.push(hostView("hst_otro"));
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "create" }),
		(error: OmiError) => error.code === "usage_error" && /hst_cp, hst_otro/.test(`${error.message} ${error.hint}`),
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_registry_manage create_rechaza un host inexistente o que no puede alojarlo sin llamar al alta", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.hosts.push(hostView("hst_worker", { is_control_plane: false, registry_eligible: false }));
	await assert.rejects(linked.call("omi_registry_manage", { action: "create", hostId: "hst_nada" }), (error: OmiError) => error.code === "host_not_found");
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "create", hostId: "hst_worker" }),
		(error: OmiError) => error.code === "host_not_registry_eligible",
	);
	assert.deepEqual(linked.mutations(), []);
});

test("omi_registry_manage create_sin humano no manda nada a la API, aun con stage autorizado", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.omi.requests, []);
});

test("omi_registry_manage create_muestra host y destino de la credencial al confirmar y respeta un no", async (t) => {
	const linked = await linkedProject(t);
	const seen: GuardedAction[] = [];
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "create" }, { guard: asking(false, seen) }),
		(error: OmiError) => error.code === "guardrail_declined",
	);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.operation, "registry");
	assert.match(seen[0]?.summary ?? "", /Crear el registry de acme/);
	assert.match(seen[0]?.diff ?? "", /hst_cp/);
	assert.ok(seen[0]?.diff.includes(passwordFile(linked)));
	assert.deepEqual(linked.mutations(), []);
	await assert.rejects(stat(passwordFile(linked)), { code: "ENOENT" });
});

test("omi_registry_manage create_un rechazo de la API sale con su código y no deja archivos", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" });
	linked.platform.pushPassword = "otra-clave";
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" }),
		(error: OmiError) => error.code === "registry_exists" && error.exitCode === 1,
	);
	assert.deepEqual(await readdir(join(linked.home, ".omi", "registry")), ["acme.push-password"]);
	assert.equal(await readFile(passwordFile(linked), "utf8"), PASSWORD);
});

test("omi_registry_manage_hostId sólo vale con create", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(linked.call("omi_registry_manage", { action: "status", hostId: "hst_cp" }), (error: OmiError) => error.code === "usage_error");
	assert.deepEqual(linked.omi.requests, []);
});

test("omi_registry_manage retry_route_reintenta la ruta pública con confirmación humana", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.routeOutcome = "error";
	await linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" });
	linked.platform.routeOutcome = "publicada";
	const seen: GuardedAction[] = [];
	const result = await linked.call("omi_registry_manage", { action: "retry_route" }, { guard: asking(true, seen) });
	assert.deepEqual(linked.mutations().at(-1), `POST ${ORG}/registry/route`);
	assert.deepEqual(linked.omi.requests.at(-1)?.body, {});
	assert.match(seen[0]?.diff ?? "", /registry-acme\.ohmyinfra\.test/);
	assert.match(seen[0]?.diff ?? "", /Cloudflare respondió 403/);
	assert.equal((result.data as { registry: { public_route: string } }).registry.public_route, "publicada");
	assert.match(result.text, /ruta pública: publicada/);
});

test("omi_registry_manage retry_route_si Cloudflare vuelve a rechazar sale con hostname_publication_failed", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.routeOutcome = "error";
	await linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" });
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "retry_route" }),
		(error: OmiError) => error.code === "hostname_publication_failed" && /Cloudflare respondió 403/.test(error.message),
	);
});

test("omi_registry_manage retry_route_sin registry ni humano no muta nada", async (t) => {
	const linked = await linkedProject(t);
	await assert.rejects(linked.call("omi_registry_manage", { action: "retry_route" }), (error: OmiError) => error.code === "registry_not_found");
	await assert.rejects(
		linked.call("omi_registry_manage", { action: "retry_route" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.mutations(), []);
});
