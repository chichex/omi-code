// Qué corre y qué avanza sin preguntar con una revisión de Foundations aceptada.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { renderFoundationsBlock, type FoundationsBlock, type FoundationsPolicy } from "../src/harness/foundations.ts";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
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
	assert.deepEqual(effectivePolicy(pin, foreign), { politica: ASK, command: { catalog: [], outside: "ask" }, hash: null });
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

const ACCEPT = "Aceptar Foundations";
const others = (prompts: string[]) => prompts.filter((title) => title !== ACCEPT);
test("foundations_policy: arranque auto empieza sin el sí y las guardas sin efectos fallan antes", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", renderFoundationsBlock(block([], { arranque: "auto" })));
	const blocked = await beginFixture(t, { kb, noMain: true });
	await blocked.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(blocked.prompts, [], "sin main local falla antes de cualquier diálogo");
	assert.deepEqual(blocked.remote.created, []);
	const f = await beginFixture(t, { kb }); const origin = f.current();
	await f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(f.prompts.map((p) => p.title), [ACCEPT], "sólo la aceptación de la revisión nueva");
	assert.equal(f.remote.created.length, 1);
	assert.ok(origin.notices.some((n) => /Foundations · arranque auto: Crear issue y empezar el trabajo/.test(n)), "se avisa lo que se hizo sin preguntar");
	assert.notEqual(f.current().manager.getSessionFile(), f.main.getSessionFile());
});

test("foundations_policy: receta auto aprueba sola, lo registra y sus D fuera del catálogo preguntan", async (t) => {
	const f = await fixture(t, block([], { receta: "auto" })); await f.start();
	await approve(f);
	const state = await f.state();
	assert.equal(state.phase, "implement");
	assert.equal(state.approval?.by, "foundations"); assert.match(state.approval?.foundations ?? "", /^[0-9a-f]{64}$/);
	assert.deepEqual(others(f.prompts), ["Empezar el trabajo del issue #42"]);
	assert.equal(f.reviews(), 0, "no abre la revisión de la receta");
	assert.equal(f.remote.comments.length, 0);
	assert.match(f.remote.body, /<!-- omi:harness:start -->/, "la receta igual queda en la sección del issue");
	assert.match(f.remote.body, /\*\*Aprobación:\*\* aprobada por Foundations \(receta: auto\), sin revisión humana/);
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", "require(\"node:assert/strict\").equal(require(\"./value.cjs\"), 2);\n");
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	assert.equal(f.asked(), 1, "una receta que se aprobó sola no autoriza sus comandos");
});

async function toPr(f: Fixture) {
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", "require(\"node:assert/strict\").equal(require(\"./value.cjs\"), 2);\n");
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	await f.invoke("omi_workflow_lens", { lens: "quality" });
	await f.action({ action: "verified" });
}
test("foundations_policy: push y PR draft en auto publican sin preguntar, sin force ni merge", async (t) => {
	const f = await fixture(t, block(["node test.cjs"], { push_pr: "auto" })); await f.start(); await approve(f); await toPr(f);
	await f.action({ action: "publish" });
	assert.equal((await f.state()).phase, "done");
	assert.ok(!f.prompts.includes("Subir rama y abrir PR draft"));
	assert.ok(f.messages.some((m) => /Foundations · push \+ PR draft auto/.test(m)));
	const remote = f.calls.filter((c) => c.command === "git" || c.command === "gh").map((c) => c.args);
	const pushes = remote.filter((args) => args.includes("push"));
	assert.ok(pushes.length > 0);
	assert.ok(!pushes.some((args) => args.some((arg) => /^(?:--force.*|-f|\+.*)$/.test(arg))), "nunca fuerza el push");
	assert.ok(!remote.some((args) => args.includes("merge")), "nunca mergea");
});

test("foundations_policy: con todo en ask cada punto sigue preguntando", async (t) => {
	const f = await fixture(t, block(["node test.cjs"])); await f.start(); await approve(f); await toPr(f);
	await f.action({ action: "publish" });
	assert.deepEqual(others(f.prompts), ["Empezar el trabajo del issue #42", "Aprobar receta y sincronizar issue", "Subir rama y abrir PR draft"]);
});

test("foundations_policy: con receta auto, la receta rehecha tras un replan también se aprueba sola", async (t) => {
	const f = await fixture(t, block([], { receta: "auto" })); await f.start(); await approve(f);
	const first = (await f.state()).approval!;
	f.manager.appendMessage({ role: "user", content: "Sumá también que other.cjs devuelva 2", timestamp: Date.now() });
	await f.action({ action: "agreed", quote: "Sumá también que other.cjs devuelva 2", agreement: "Ampliar el alcance a other.cjs", replan: true });
	assert.equal((await f.state()).phase, "recipe");
	await f.action({ action: "planned", plan: { ...f.plan(), cases: [...f.plan().cases, { id: "D2", description: "Otro devuelve 2", command: "node other-test.cjs" }] } });
	await f.action({ action: "approve" });
	const again = await f.state();
	assert.equal(again.phase, "implement");
	assert.equal(again.approval?.by, "foundations"); assert.equal(again.approval?.foundations, first.foundations, "el mismo hash de Foundations de la sesión");
	assert.equal(f.reviews(), 0); assert.ok(!f.prompts.includes("Aprobar receta y sincronizar issue"));
	assert.match(f.remote.body, /\*\*D2\*\* `node other-test\.cjs`/, "la sección del issue muestra la receta nueva");
	assert.match(f.remote.body, /aprobada por Foundations \(receta: auto\)/);
});
