// Preparar la base conserva fases/evidencia y respeta v2, sintaxis y grants exactos.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { renderFoundationsBlock } from "../src/harness/foundations.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
const AUTHORIZE = "Autorizar comando del proyecto";
const INSTALL = "node test.cjs";
const WRITES_CODE = "node -e \"require('node:fs').writeFileSync('value.cjs', 'module.exports = 3;\\n')\"";
type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
const asked = (f: Fixture) => f.prompts.filter((title) => title === AUTHORIZE).length;
const exploration = (missingFoundation: string[]) => ({ references: [{ path: "value.cjs", line: 1, detail: "Valor actual" }], findings: ["Devuelve 1"], approach: "Corregir", missingFoundation, dependencies: [], disposition: "continue", reason: "Existe" });
async function withFoundations(t: TestContext) {
	const kb = memoryKb({ products: ["repo"] });
	kb.perillas("repo", renderFoundationsBlock({ version: 2, repo: "test/repo", confirmar: [], politica: { arranque: "ask", receta: "ask", push_pr: "ask" } }));
	return developmentFixture(t, { kb });
}
test("development_setup: sin v2 aceptada setup pide sí aun siendo simple y antes de aprobar receta", async (t) => {
	const f = await developmentFixture(t); await f.start(); const result = await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL });
	assert.equal(result.isError, false); assert.equal(asked(f), 1); assert.equal((await f.state()).evidence.length, 0);
});
test("development_setup: simple no coincidente con v2 aceptada corre en Explorar sin preguntar", async (t) => {
	const f = await withFoundations(t); await f.start(); const result = await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL });
	assert.equal(result.isError, false); assert.equal(asked(f), 0);
});
test("development_setup: base preparada permite reproducir y volver a explorar sin refresh", async (t) => {
	const f = await withFoundations(t); await f.start(); await f.readReference(); await f.action({ action: "explored", exploration: exploration(["Dependencias sin instalar"]) });
	assert.equal((await f.state()).phase, "decide"); assert.equal((await f.state()).status, "waiting");
	await f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL }); const reproduction = await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" });
	assert.equal(reproduction.isError, false); await f.action({ action: "explored", exploration: exploration([]) }); const state = await f.state();
	assert.equal(state.status, "active"); assert.equal(state.blockedReason, ""); assert.equal(state.evidence.filter((e) => e.kind === "reproduction").length, 1); assert.equal(asked(f), 0);
});
test("development_setup: sintaxis compleja requiere sí y cambiar código fuera de Implementar falla claramente", async (t) => {
	const f = await withFoundations(t); await f.start();
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "setup", command: WRITES_CODE }), /setup cambió el checkout fuera de Implementar/); assert.equal(asked(f), 1);
});
test("development_setup: en Implementar un setup autorizado puede cambiar el checkout sin acreditar prueba", async (t) => {
	const f = await withFoundations(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	const before = (await f.state()).evidence.length; const result = await f.invoke("omi_workflow_check", { kind: "setup", command: WRITES_CODE });
	assert.equal(result.isError, false); assert.equal(asked(f), 1); assert.equal((await f.state()).evidence.length, before);
});
test("development_setup: un trabajo pausado no corre setup", async (t) => {
	const f = await withFoundations(t); await f.start(); await f.command("pause");
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "setup", command: INSTALL }), /no está activo/);
});
test("development_setup: instrucciones asignan preparar la base al agente sin presentarlo como fundación faltante", async (t) => {
	const f = await developmentFixture(t); await f.start(); const text = developmentInstructions(await f.state(), []);
	assert.match(text, /kind setup/); assert.match(text, /no es fundación faltante/); assert.match(text, /v2/);
});
test("development_setup: la reproducción sigue rechazada en Implementar", async (t) => {
	const f = await withFoundations(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" }), /La reproducción corresponde a Explorar, Resolver inferencias o Diagnóstico/);
});
