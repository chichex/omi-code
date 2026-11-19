// Autorizar un comando se separa de etiquetarlo, y el permiso vive en el estado del trabajo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../src/harness/model.ts";
import { developmentFixture } from "./helpers/development.ts";
import { approvalPreview } from "../src/tui/development-session.ts";
import { ASK_ALL } from "./helpers/foundations.ts";

const AUTHORIZE = "Autorizar comando del proyecto";
const OK = "node -e \"process.exit(0)\"";
const OTHER = "node -e \"process.exitCode = 0\"";
type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
const asked = (f: Fixture) => f.prompts.filter((title) => title === AUTHORIZE).length;
async function approved(f: Fixture) { await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); }

test("development_grants: un D de la receta aprobada corrido como setup no pide otro sí", async (t) => {
	const f = await developmentFixture(t); await approved(f);
	const before = asked(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: "node test.cjs" });
	assert.equal(asked(f) - before, 0);
});

test("development_grants: un setup autorizado no vuelve a preguntar después de recargar y /omi-work resume", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await approved(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(asked(f), 1);
	assert.deepEqual((await f.state()).grants?.map((g) => g.command), [OK], "el permiso queda en el estado del trabajo");
	await f.attach(); await f.command("resume");
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(asked(f), 1);
});

test("development_grants: un comando autorizado en Explorar no vuelve a preguntar al aprobar", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	assert.equal(asked(f), 1);
	await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(asked(f), 1);
});

test("development_grants: un comando nuevo pregunta", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await approved(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	await f.invoke("omi_workflow_check", { kind: "setup", command: OTHER });
	assert.equal(asked(f), 2);
});

test("development_grants: refresh descarta los permisos", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	await f.command("refresh");
	assert.deepEqual((await f.state()).grants ?? [], []);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	assert.equal(asked(f), 2);
});

test("development_grants: cambiar el pedido descarta los permisos", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	f.remote.body = "Otro pedido: el resultado esperado es 3.\n";
	await f.command("resume");
	assert.equal((await f.state()).source.body, f.remote.body);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	assert.equal(asked(f), 2);
});

test("development_grants: un no no guarda permiso y el mismo comando vuelve a preguntar", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await approved(f);
	f.remote.confirmations = false;
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "setup", command: OK }), /no autorizado/);
	assert.deepEqual((await f.state()).grants ?? [], []);
	f.remote.confirmations = true;
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(asked(f), 2);
});

test("development_grants: el diálogo dice que el permiso queda para este trabajo", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await approved(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.match(f.confirmationDetails.at(-1)!, /queda guardado para este trabajo/);
});

test("development_grants: un estado guardado sin permisos ni autor de la aprobación se sigue leyendo", async (t) => {
	const f = await developmentFixture(t); await approved(f);
	const saved = JSON.parse(JSON.stringify(await f.state())) as Record<string, unknown> & { approval: Record<string, unknown> };
	delete saved.grants; delete saved.approval.by; delete saved.approval.foundations;
	assert.doesNotThrow(() => parseWorkflow(JSON.stringify(saved)));
});

test("development_grants: la aprobación dice qué comandos siguen pidiendo permiso", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	const preview = approvalPreview(await f.state());
	assert.match(preview, /comandos exactos de los casos D sin volver a preguntar, con cualquier etiqueta/);
	assert.match(preview, /Otros comandos, también de setup, piden permiso una vez por trabajo sólo si Foundations dice fuera_de_catalogo: ask, salvo los del catálogo/);
});

// Un permiso es por comando y por pedido, no por receta: un replan por acuerdo del chat no cambia el pedido.
test("development_grants: un replan por acuerdo del chat conserva los permisos guardados", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await approved(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	f.manager.appendMessage({ role: "user", content: "Sumá también que other.cjs devuelva 2", timestamp: Date.now() });
	await f.action({ action: "agreed", quote: "Sumá también que other.cjs devuelva 2", agreement: "Ampliar el alcance a other.cjs", replan: true });
	assert.deepEqual((await f.state()).grants?.map((g) => g.command), [OK]);
	await f.action({ action: "planned", plan: { ...f.plan(), cases: [...f.plan().cases, { id: "D2", description: "Otro devuelve 2", command: "node other-test.cjs" }] } });
	await f.action({ action: "approve" });
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(asked(f), 1);
});
