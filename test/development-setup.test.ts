// Preparar el checkout (por ejemplo, instalar dependencias) nunca deja al trabajo esperando a una persona.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { renderFoundationsBlock } from "../src/harness/foundations.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";

const AUTHORIZE = "Autorizar comando del proyecto";
const INSTALL = "node -e \"process.exit(0)\"";
const WRITES_CODE = "node -e \"require('node:fs').writeFileSync('value.cjs', 'module.exports = 3;\\n')\"";
type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
const asked = (f: Fixture) => f.prompts.filter((title) => title === AUTHORIZE).length;
const exploration = (missingFoundation: string[]) => ({ references: [{ path: "value.cjs", line: 1, detail: "Valor actual" }], findings: ["Devuelve 1"], approach: "Corregir el valor", missingFoundation, dependencies: [], disposition: "continue", reason: "Existe" });
async function withCatalog(t: TestContext, comandos: string[]) {
	const kb = memoryKb({ products: ["repo"] });
	kb.perillas("repo", `# Perillas\n\n${renderFoundationsBlock({ version: 1, repo: "test/repo", comandos, politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" } })}\n`);
	return developmentFixture(t, { kb });
}

test("development_setup: setup corre en Explorar, antes de aprobar la receta, con la autorización de siempre", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const result = await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL });
	assert.equal(result.isError, false);
	assert.equal(asked(f), 1, "un comando fuera del catálogo pregunta una vez");
	assert.equal((await f.state()).evidence.length, 0, "setup no acredita nada");
});

test("development_setup: un setup del catálogo corre en Explorar sin preguntar", async (t) => {
	const f = await withCatalog(t, [INSTALL]); await f.start();
	const result = await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL });
	assert.equal(result.isError, false);
	assert.equal(asked(f), 0);
});

test("development_setup: con la base sin preparar, el agente la prepara, reproduce y vuelve a explorar sin refresh", async (t) => {
	const f = await withCatalog(t, [INSTALL, "node test.cjs"]); await f.start(); await f.readReference();
	await f.action({ action: "explored", exploration: exploration(["Dependencias sin instalar"]) });
	let state = await f.state();
	assert.equal(state.phase, "decide"); assert.equal(state.status, "waiting");
	await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL });
	const reproduction = await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" });
	assert.equal(reproduction.isError, false);
	await f.action({ action: "explored", exploration: exploration([]) });
	state = await f.state();
	assert.equal(state.status, "active"); assert.equal(state.blockedReason, "");
	assert.equal(state.evidence.filter((e) => e.kind === "reproduction").length, 1);
	assert.equal(asked(f), 0);
});

test("development_setup: fuera de Implementar, un setup que cambia el código falla con un error claro", async (t) => {
	const f = await withCatalog(t, [WRITES_CODE]); await f.start();
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "setup", command: WRITES_CODE }), /setup cambió el checkout fuera de Implementar/);
});

test("development_setup: en Implementar, setup puede cambiar el checkout como hasta ahora", async (t) => {
	const f = await withCatalog(t, [WRITES_CODE]); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	const result = await f.invoke("omi_workflow_check", { kind: "setup", command: WRITES_CODE });
	assert.equal(result.isError, false);
});

test("development_setup: un trabajo pausado no corre setup", async (t) => {
	const f = await withCatalog(t, [INSTALL]); await f.start(); await f.command("pause");
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL }), /no está activo/);
});

test("development_setup: las instrucciones de Explorar dicen que preparar la base es tarea del agente", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const text = developmentInstructions(await f.state(), []);
	assert.match(text, /kind setup/);
	assert.match(text, /no es fundación faltante/);
});
