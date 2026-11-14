import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/main.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

const ORG = "/api/v1/organizations/org_acme";
const PASSWORD = "push-clave-de-un-solo-uso";

function visibilityOf(linked: Linked, name: string): unknown {
	return linked.project.services.get("api")?.view.environments.find((candidate) => candidate.name === name)?.visibility;
}

test("omi registry status_imprime el estado y --json los datos", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["registry", "status"], io), 0, io.errors());
	assert.match(io.output(), /acme todavía no tiene registry/);
	const json = linked.io();
	assert.equal(await run(["registry", "status", "--json"], json), 0, json.errors());
	assert.deepEqual(JSON.parse(json.output()), { organization: "acme", registry: null });
});

test("omi registry hosts_lista los hosts de la organización pedida con --org", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["registry", "hosts", "--org", "acme"], io), 0, io.errors());
	assert.match(io.output(), /hst_cp cp: disponible · puede alojar el registry/);
});

test("omi registry create_sin terminal ni --yes sale con 2 y no crea nada", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["registry", "create", "--host", "hst_cp", "--json"], io), 2);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "guardrail_confirmation_required");
	assert.deepEqual(linked.mutations(), []);
});

test("omi registry create_con el sí del humano crea el registry y no imprime la credencial", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true, answers: ["s"] });
	assert.equal(await run(["registry", "create", "--host", "hst_cp"], io), 0, io.errors());
	assert.deepEqual(linked.mutations(), [`POST ${ORG}/registry`]);
	assert.doesNotMatch(io.output() + io.errors(), new RegExp(PASSWORD));
	assert.equal(await readFile(join(linked.home, ".omi", "registry", "acme.push-password"), "utf8"), PASSWORD);
});

test("omi registry create_interactivo muestra host y destino de la credencial y respeta un no", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true, answers: ["n"] });
	assert.equal(await run(["registry", "create"], io), 2);
	assert.match(io.errors(), /registry de acme en el host cp \(hst_cp\)/);
	assert.match(io.errors(), /acme\.push-password/);
	assert.deepEqual(linked.mutations(), []);
});

test("omi registry create --yes_no vale desde una sesión agéntica", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", OMI_AGENT_SESSION: "1" } });
	assert.equal(await run(["registry", "create", "--host", "hst_cp", "--yes"], io), 2);
	assert.deepEqual(linked.mutations(), []);
});

test("omi registry retry-route_con el sí del humano reintenta la ruta pública", async (t) => {
	const linked = await linkedProject(t);
	linked.platform.routeOutcome = "error";
	assert.equal(await run(["registry", "create"], linked.io({ interactive: true, answers: ["s"] })), 0);
	linked.platform.routeOutcome = "publicada";
	const io = linked.io({ interactive: true, answers: ["s"] });
	assert.equal(await run(["registry", "retry-route"], io), 0, io.errors());
	assert.equal(linked.mutations().at(-1), `POST ${ORG}/registry/route`);
	assert.match(io.output(), /ruta pública: publicada/);
});

test("omi registry_sin acción o con una acción desconocida es error de uso", async (t) => {
	const linked = await linkedProject(t);
	assert.equal(await run(["registry"], linked.io()), 2);
	const io = linked.io();
	assert.equal(await run(["registry", "delete", "--yes"], io), 2);
	assert.match(io.errors(), /omi registry <status\|hosts\|create\|retry-route>/);
	assert.deepEqual(linked.omi.requests, []);
});

test("omi registry_un error de la API sale con 1 y su código", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true });
	assert.equal(await run(["registry", "retry-route", "--json"], io), 1);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "registry_not_found");
});

test("omi visibility set_a prod sin terminal sale con 2 y guardrail_confirmation_required", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["visibility", "set", "publico", "--env", "prod", "--json"], io), 2);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "guardrail_confirmation_required");
	assert.deepEqual(linked.mutations(), []);
});

test("omi visibility set_interactivo muestra el cambio y respeta un no", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true, answers: ["n"] });
	assert.equal(await run(["visibility", "set", "publico", "--env", "stage"], io), 2);
	assert.match(io.errors(), /stage: privado → publico/);
	assert.match(io.errors(), /publica api-stage-acme\.ohmyinfra\.test en internet/);
	assert.equal(visibilityOf(linked, "stage"), "privado");
});

test("omi visibility set --yes_sin terminal no aprueba: sale con 2 y no cambia nada", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["visibility", "set", "publico", "--env", "prod", "--service", "api", "--yes", "--json"], io), 2);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "guardrail_confirmation_required");
	assert.equal(visibilityOf(linked, "prod"), "privado");
	assert.deepEqual(linked.mutations(), []);
});

test("omi visibility set_con el sí del humano cambia la visibilidad y --json devuelve el resultado", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true, answers: ["s"] });
	assert.equal(await run(["visibility", "set", "publico", "--env", "prod", "--service", "api", "--json"], io), 0, io.errors());
	assert.equal(visibilityOf(linked, "prod"), "publico");
	assert.equal((JSON.parse(io.output()) as { visibility: string; previous: string }).previous, "privado");
});

test("omi visibility set --yes_no vale desde una sesión agéntica", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", OMI_AGENT_SESSION: "1" } });
	assert.equal(await run(["visibility", "set", "publico", "--env", "stage", "--yes"], io), 2);
	assert.equal(visibilityOf(linked, "stage"), "privado");
});

test("omi visibility set_un valor o un ambiente inválidos son error de uso sin tocar la API", async (t) => {
	const linked = await linkedProject(t);
	for (const args of [["visibility", "set", "interno", "--env", "stage", "--yes"], ["visibility", "set", "publico", "--env", "dev", "--yes"], ["visibility", "set", "--env", "stage"], ["visibility", "publico"]]) {
		assert.equal(await run(args, linked.io()), 2, args.join(" "));
	}
	assert.deepEqual(linked.omi.requests, []);
});

test("omi visibility set_un rechazo de la API sale con 1", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["visibility", "set", "publico", "--env", "stage", "--service", "nada", "--yes"], io), 2);
	linked.omi.sessions.set("prs_test", "expired");
	const expired = linked.io();
	assert.equal(await run(["visibility", "set", "publico", "--env", "stage", "--yes"], expired), 1);
	assert.match(expired.errors(), /omi login/);
});

test("omi --help y el uso de cada subcomando nuevo", async (t) => {
	const linked = await linkedProject(t);
	const help = linked.io();
	assert.equal(await run(["--help"], help), 0);
	assert.match(help.output(), /^  registry\b.*registry de la organización/m);
	assert.match(help.output(), /^  visibility\b.*visibilidad de un ambiente/m);
	const registry = linked.io();
	assert.equal(await run(["registry", "--help"], registry), 0);
	assert.match(registry.output(), /omi registry <status\|hosts\|create\|retry-route> \[--host <id>\] \[--org <slug>\] \[--yes\]/);
	const visibility = linked.io();
	assert.equal(await run(["visibility", "--help"], visibility), 0);
	assert.match(visibility.output(), /omi visibility set <privado\|organizacion\|publico> --env <stage\|prod> \[--service <nombre>\] \[--yes\]/);
	assert.deepEqual(linked.omi.requests, []);
});
