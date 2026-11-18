// Qué corre y qué avanza sin preguntar con una revisión de Foundations aceptada.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { renderFoundationsBlock, type FoundationsBlock, type FoundationsPolicy } from "../src/harness/foundations.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { effectivePolicy } from "../src/tui/development-foundations.ts";

const AUTHORIZE = "Autorizar comando del proyecto";
const OK = "node -e \"process.exit(0)\"";
const OTHER = "node -e \"process.exitCode = 0\"";
const ASK: FoundationsPolicy = { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" };
const block = (comandos: string[], politica: Partial<FoundationsPolicy> = {}): FoundationsBlock => ({ version: 1, repo: "test/repo", comandos, politica: { ...ASK, ...politica } });
async function fixture(t: TestContext, value: FoundationsBlock) {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", `# Perillas\n\n${renderFoundationsBlock(value)}\n`);
	const f = await developmentFixture(t, { kb });
	return Object.assign(f, { kb, asked: () => f.prompts.filter((title) => title === AUTHORIZE).length });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const approve = async (f: Fixture) => { await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); };

test("foundations_policy: un comando del catálogo corre sin preguntar con cualquier etiqueta", async (t) => {
	const f = await fixture(t, block([OK, "node test.cjs"])); await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK });
	await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", "require(\"node:assert/strict\").equal(require(\"./value.cjs\"), 2);\n");
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	assert.equal(f.asked(), 0);
	assert.deepEqual((await f.state()).grants ?? [], [], "el catálogo no se copia como permiso del trabajo");
});

test("foundations_policy: fuera del catálogo con ask pregunta una vez y queda guardado", async (t) => {
	const f = await fixture(t, block([OK])); await f.start(); await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OTHER });
	await f.attach(); await f.command("resume");
	await f.invoke("omi_workflow_check", { kind: "setup", command: OTHER });
	assert.equal(f.asked(), 1);
});

test("foundations_policy: fuera del catálogo con auto no pregunta", async (t) => {
	const f = await fixture(t, block([], { fuera_de_catalogo: "auto" })); await f.start();
	assert.match(f.confirmationDetails.find((text) => text.includes("fuera del catálogo: ask → auto"))!, /corre cualquier comando sin preguntar/, "el diálogo de aceptación lo marca");
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OTHER });
	await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(f.asked(), 0);
	assert.deepEqual((await f.state()).grants ?? [], []);
});

test("foundations_policy: el catálogo no cambia las reglas de etapa ni de evidencia", async (t) => {
	const f = await fixture(t, block(["node test.cjs"])); await f.start();
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" }), /aprobar la receta/);
	await approve(f);
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "gate", command: "node test.cjs" }), /Verificar/);
	const before = (await f.state()).evidence.length;
	await f.invoke("omi_workflow_check", { kind: "setup", command: "node test.cjs" });
	assert.equal((await f.state()).evidence.length, before, "setup sigue sin acreditar pruebas");
});

test("foundations_policy: un issue de otro repo no usa el Foundations de este", async (t) => {
	const f = await fixture(t, block([OK], { receta: "auto" })); await f.start();
	const pin = { origin: "kb" as const, block: block([OK], { receta: "auto" }), hash: "h", docId: "d", author: "", date: "", notice: "", reading: { kind: "none" as const, reason: "" } };
	const state = await f.state();
	assert.deepEqual(effectivePolicy(pin, state).command.catalog, [OK]);
	const foreign = { ...state, source: { ...state.source, url: "https://github.com/acme/repo/issues/42" } };
	assert.deepEqual(effectivePolicy(pin, foreign), { politica: ASK, command: { catalog: [], outside: "ask" } });
});

for (const nested of [false, true]) test(`foundations_policy: con el harness activo el agente no guarda ni borra perillas${nested ? " (llamada anidada)" : ""}`, async (t) => {
	const f = await fixture(t, block([]));
	assert.equal(await f.emit("tool_call", { toolName: "mcp__harness_kb__guardar", toolCallId: "g0", input: {} }), undefined, "fuera del harness no se bloquea");
	await f.start();
	for (const toolName of ["mcp__harness_kb__guardar", "mcp__harness_kb__borrar"]) {
		const result = await f.emit("tool_call", { toolName, toolCallId: "g1", input: { producto: "repo", tipo: "perillas", titulo: "x", cuerpo: "x" }, ...(nested ? { parentToolCallId: "worker-1" } : {}) }) as { block?: boolean; reason?: string } | undefined;
		assert.equal(result?.block, true); assert.match(result?.reason ?? "", /perillas/);
	}
});

test("foundations_policy: el agente ve el catálogo como datos, con los comandos exactos", async (t) => {
	const f = await fixture(t, block([OK])); await f.start();
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await f.emit("before_agent_start", event);
	const section = event.systemPromptOptions.sections.omi_development!;
	assert.match(section, /Catálogo de Foundations/);
	assert.ok(section.includes(JSON.stringify([OK])));
	assert.doesNotMatch(section, /kind setup con permiso humano/);
});
