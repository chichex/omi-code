import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli/main.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

function withVersions(linked: Linked, ...tags: string[]): void {
	const view = linked.project.services.get("api")?.view;
	if (view !== undefined) view.versions = tags.map((tag) => ({ tag, prerelease: false }));
}

function environment(linked: Linked, name: string): Record<string, unknown> {
	const view = linked.project.services.get("api")?.view.environments.find((candidate) => candidate.name === name);
	assert.ok(view);
	return view;
}

test("omi status_imprime el estado y --json los datos", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["status"], io), 0, io.errors());
	assert.match(io.output(), /acme\/tienda/);
	const json = linked.io();
	assert.equal(await run(["status", "--json"], json), 0, json.errors());
	assert.equal((JSON.parse(json.output()) as { project: string }).project, "tienda");
});

test("omi env_lista y cambia variables usando el único service del repo", async (t) => {
	const linked = await linkedProject(t);
	const set = linked.io();
	assert.equal(await run(["env", "set", "--env", "stage", "LOG_LEVEL=debug", "FEATURE=a=b"], set), 0, set.errors());
	const list = linked.io();
	assert.equal(await run(["env", "list", "--env", "stage"], list), 0, list.errors());
	assert.match(list.output(), /FEATURE=a=b/);
	assert.match(list.output(), /LOG_LEVEL=debug/);
});

test("omi env set_rechaza un nombre reservado con salida 2", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io();
	assert.equal(await run(["env", "set", "--env", "stage", "PORT=1"], io), 2);
	assert.deepEqual(linked.mutations(), []);
});

test("omi env set --secret_pide el valor oculto y no lo imprime", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ interactive: true, answers: ["s", "valor-tipeado"] });
	assert.equal(await run(["env", "set", "--env", "stage", "--secret", "API_KEY"], io), 0, io.errors());
	assert.equal(linked.workloads.secrets.get("stage/API_KEY"), "valor-tipeado");
	assert.doesNotMatch(io.output() + io.errors(), /valor-tipeado/);
});

test("omi env set --secret NOMBRE=VARIABLE_toma el valor de esa variable local", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", LOCAL: "de-entorno" } });
	assert.equal(await run(["env", "set", "--env", "stage", "--secret", "API_KEY=LOCAL", "--yes"], io), 0, io.errors());
	assert.equal(linked.workloads.secrets.get("stage/API_KEY"), "de-entorno");
});

test("omi deploy a prod_sin terminal sale con 2 y guardrail_confirmation_required", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const io = linked.io();
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0", "--json"], io), 2);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "guardrail_confirmation_required");
	assert.deepEqual(linked.mutations(), []);
});

test("omi deploy a prod_interactivo muestra el diff y respeta un no", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const io = linked.io({ interactive: true, answers: ["n"] });
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0"], io), 2);
	assert.match(io.errors(), /sin versión → 1\.1\.0/);
	assert.deepEqual(linked.mutations(), []);
});

test("omi deploy a prod --yes_aprueba sin terminal", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const io = linked.io();
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0", "--yes"], io), 0, io.errors());
	assert.equal(environment(linked, "prod").current_version, "1.1.0");
});

test("omi deploy --yes_no vale desde una sesión agéntica", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const io = linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", OMI_AGENT_SESSION: "1" } });
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0", "--yes"], io), 2);
	assert.deepEqual(linked.mutations(), []);
});

test("omi deploy a stage_corre y muestra los pasos por stderr", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	const io = linked.io();
	assert.equal(await run(["deploy", "--env", "stage", "--version", "1.1.0"], io), 0, io.errors());
	assert.match(io.errors(), /instancia_lista api-abc/);
	assert.match(io.output(), /desplegada en stage/);
});

test("omi deploy_un deploy fallido sale con 1", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	linked.workloads.deployOutcome = { status: "fallido", error: "boom" };
	const io = linked.io();
	assert.equal(await run(["deploy", "--env", "stage", "--version", "1.1.0"], io), 1);
	assert.match(io.errors(), /boom/);
});

test("omi deploy_sin --version es error de uso", async (t) => {
	const linked = await linkedProject(t);
	assert.equal(await run(["deploy", "--env", "stage"], linked.io()), 2);
});

test("omi deploy_con un ambiente inválido es error de uso", async (t) => {
	const linked = await linkedProject(t);
	assert.equal(await run(["deploy", "--env", "qa", "--version", "1.1.0"], linked.io()), 2);
});

test("omi promote --yes_promueve la versión de stage", async (t) => {
	const linked = await linkedProject(t);
	withVersions(linked, "1.1.0");
	environment(linked, "prod").promotion = { version: "1.1.0" };
	const io = linked.io();
	assert.equal(await run(["promote", "--yes"], io), 0, io.errors());
	assert.equal(environment(linked, "prod").current_version, "1.1.0");
});

test("omi logs_transmite las líneas por stdout", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n", "data: dos\n\n");
	const io = linked.io();
	assert.equal(await run(["logs", "--env", "stage", "--lines", "2"], io), 0, io.errors());
	assert.deepEqual(io.stdout, ["uno", "dos"]);
});

test("omi logs_un stream-error sale con 1", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("event: stream-error\ndata: se cortó\n\n");
	const io = linked.io();
	assert.equal(await run(["logs", "--env", "stage"], io), 1);
	assert.match(io.errors(), /se cortó/);
});

test("omi logs --crash_trae la captura", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.instanceLogs.push({ id: "ilog_1", lines: ["panic: boom"] });
	const io = linked.io();
	assert.equal(await run(["logs", "--env", "stage", "--crash"], io), 0, io.errors());
	assert.match(io.output(), /panic: boom/);
});

test("omi jobs_crea, lista y genera la plantilla", async (t) => {
	const linked = await linkedProject(t);
	const create = linked.io();
	assert.equal(await run(["jobs", "create", "facturar", "--path", "/jobs/f", "--schedule", "0 6 * * *", "--timeout", "120"], create), 0, create.errors());
	const list = linked.io();
	assert.equal(await run(["jobs", "list"], list), 0, list.errors());
	assert.match(list.output(), /facturar/);
	const template = linked.io();
	assert.equal(await run(["jobs", "template", "--language", "python"], template), 0, template.errors());
	assert.match(template.output(), /compare_digest/);
});

test("omi resources_lista y gestiona Postgres", async (t) => {
	const linked = await linkedProject(t);
	const create = linked.io();
	assert.equal(await run(["resources", "postgres", "create", "--env", "stage", "--slug", "app", "--mode", "local", "--yes"], create), 0, create.errors());
	const list = linked.io();
	assert.equal(await run(["resources", "list", "--env", "stage"], list), 0, list.errors());
	assert.match(list.output(), /POSTGRES_URL_APP/);
});

test("omi resources postgres_sin terminal ni --yes queda bloqueado", async (t) => {
	const linked = await linkedProject(t);
	assert.equal(await run(["resources", "postgres", "create", "--env", "stage", "--slug", "app", "--mode", "local"], linked.io()), 2);
	assert.deepEqual(linked.mutations(), []);
});

test("omi status_fuera de un repo vinculado indica correr omi init", async (t) => {
	const linked = await linkedProject(t);
	const io = linked.io({ cwd: linked.home });
	assert.equal(await run(["status"], io), 1);
	assert.match(io.errors(), /omi init/);
});
