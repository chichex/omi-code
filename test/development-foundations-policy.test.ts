// Integración v2 con Git temporal y KB/GitHub falsos. Las reglas no dispensan guardas sensibles.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { foundationsHash, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock, type FoundationsPolicy } from "../src/harness/foundations.ts";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { effectivePolicy, type FoundationsPin } from "../src/tui/development-foundations.ts";
import type { Workflow } from "../src/harness/model.ts";
const AUTHORIZE = "Autorizar comando del proyecto"; const ACCEPT = "Aceptar Foundations";
const OK = "node test.cjs"; const COMPLEX = 'node -e "process.exit(0)"';
const ASK = { ...STRICT_POLICY };
const block = (confirmar: string[] = [], politica: Partial<FoundationsPolicy> = {}): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...ASK, ...politica } });
async function fixture(t: TestContext, value = block()) {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", `# Perillas\n\n${renderFoundationsBlock(value)}\n`);
	const f = await developmentFixture(t, { kb }); return Object.assign(f, { kb, asked: () => f.prompts.filter((title) => title === AUTHORIZE).length });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const approve = async (f: Fixture) => { await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); };
type AutomaticOutcome = Pick<Workflow, "phase" | "approval" | "grants">;
function assertAutomaticReplanOutcome(next: AutomaticOutcome, expectedHash: string, body: string): void {
	assert.equal(next.phase, "implement");
	assert.equal(next.approval?.by, "foundations");
	assert.equal(next.approval?.foundations, expectedHash);
	assert.deepEqual(next.grants ?? [], []);
	assert.match(body, /<!-- omi:harness:start -->/);
	assert.match(body, /\*\*D2\*\* `node other-test\.cjs`/);
	assert.match(body, /\*\*Aprobación:\*\* aprobada por Foundations \(receta: auto\), sin revisión humana/);
	assert.match(body, /<!-- omi:harness:end -->/);
}
const oracleApproval: NonNullable<Workflow["approval"]> = { sourceHash: "source", recipeHash: "recipe", at: "now", by: "foundations", foundations: "accepted-hash" };
const oracleOutcome: AutomaticOutcome = { phase: "implement", approval: oracleApproval, grants: [] };
const oracleBody = "<!-- omi:harness:start -->\n**D2** `node other-test.cjs`\n**Aprobación:** aprobada por Foundations (receta: auto), sin revisión humana\n<!-- omi:harness:end -->";
const wrongOutcomes: { name: string; outcome: AutomaticOutcome; body: string }[] = [
	{ name: "fase de aprobación en vez de implementación", outcome: { ...oracleOutcome, phase: "approve" }, body: oracleBody },
	{ name: "autor humano en vez de Foundations", outcome: { ...oracleOutcome, approval: { ...oracleApproval, by: "person" } }, body: oracleBody },
	{ name: "D2 mencionado sin su comando exacto", outcome: oracleOutcome, body: oracleBody.replace("**D2** `node other-test.cjs`", "**D1** `node other-test.cjs`\n**D2** `node wrong-test.cjs`") },
];
for (const bad of wrongOutcomes) test(`foundations_policy: el oráculo de replan rechaza ${bad.name}`, () => {
	assert.throws(() => assertAutomaticReplanOutcome(bad.outcome, "accepted-hash", bad.body));
});

test("foundations_policy v2: simple no coincidente corre con cualquier etiqueta y sin copiarse a grants", async (t) => {
	const f = await fixture(t, block(["git push *"])); await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OK }); await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK }); await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
	await f.invoke("omi_workflow_check", { kind: "red", command: OK, stepId: "C1" });
	assert.equal(f.asked(), 0); assert.deepEqual((await f.state()).grants ?? [], []);
});
test("foundations_policy v2: match pregunta una vez por comando exacto y sobrevive reload/resume, no lo dispensa la receta humana", async (t) => {
	const f = await fixture(t, block([OK])); await f.start(); await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK }); await f.attach(); await f.command("resume");
	await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal(f.asked(), 1); assert.deepEqual((await f.state()).grants?.map((grant) => grant.command), [OK]);
});
test("foundations_policy v2: lista vacía no neutraliza sintaxis compuesta ni receta auto crea grants", async (t) => {
	const f = await fixture(t, block([], { receta: "auto" })); await f.start();
	assert.match(f.confirmationDetails[0]!, /todo comando SIMPLE.*sin confirmación por esta política/);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: COMPLEX }); await approve(f);
	await f.invoke("omi_workflow_check", { kind: "setup", command: COMPLEX });
	assert.equal(f.asked(), 1); assert.deepEqual((await f.state()).grants?.map((grant) => grant.command), [COMPLEX]);
});
test("foundations_policy v2: no cambia reglas de etapa ni qué acredita setup", async (t) => {
	const f = await fixture(t); await f.start();
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "red", command: OK, stepId: "C1" }), /aprobar la receta/);
	await approve(f); await assert.rejects(f.invoke("omi_workflow_check", { kind: "gate", command: OK }), /Verificar/);
	const before = (await f.state()).evidence.length; await f.invoke("omi_workflow_check", { kind: "setup", command: OK });
	assert.equal((await f.state()).evidence.length, before);
});
test("foundations_policy v2: el pin de otro repo o con hash inválido nunca aplica", async (t) => {
	const f = await fixture(t); await f.start(); const state = await f.state(); const value = block(); const hash = foundationsHash(value);
	const pin: FoundationsPin = { version: 2, origin: "kb", block: value, hash, docId: "doc", author: "", date: "", notice: "", reading: { kind: "valid", key: { kbUrl: f.kb.url, product: "repo", repo: "test/repo" }, block: value, hash, perillas: f.kb.documents[0]! } };
	assert.deepEqual(effectivePolicy(pin, state).command, { block: value, accepted: true });
	const foreign = { ...state, source: { ...state.source, url: "https://github.com/acme/repo/issues/42" } };
	assert.deepEqual(effectivePolicy(pin, foreign), { politica: ASK, command: { block: null, accepted: false }, hash: null });
	assert.equal(effectivePolicy({ ...pin, hash: "h" }, state).command.accepted, false);
});
for (const nested of [false, true]) test(`foundations_policy v2: el agente no guarda ni borra perillas, tampoco con llamada anidada ${nested}`, async (t) => {
	const f = await fixture(t);
	assert.equal(await f.emit("tool_call", { toolName: "mcp__harness_kb__guardar", input: {} }), undefined);
	await f.start(); await approve(f); await f.action({ action: "step", id: "C1" });
	for (const toolName of ["mcp__harness_kb__guardar", "mcp__harness_kb__borrar"]) {
		const result = await f.emit("tool_call", { toolName, input: { producto: "repo" }, ...(nested ? { parentToolCallId: "worker-1" } : {}) }) as { block?: boolean; reason?: string };
		assert.equal(result?.block, true);
		assert.equal(result?.reason, `Harness: ${toolName} no está habilitada en esta etapa. Usá omi_workflow y omi_workflow_check; no eludas la receta, evidencia ni permisos.`);
	}
});
test("foundations_policy v2: el agente recibe patrones de confirmación como datos, no catálogo permitido", async (t) => {
	const f = await fixture(t, block(["git push *"])); await f.start();
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } }; await f.emit("before_agent_start", event);
	const text = event.systemPromptOptions.sections.omi_development!;
	assert.match(text, /REQUIEREN confirmación/); assert.ok(text.includes(JSON.stringify(["git push *"]))); assert.doesNotMatch(text, /Catálogo de Foundations/);
});
const others = (prompts: string[]) => prompts.filter((title) => title !== ACCEPT);
test("foundations_policy v2: clasificación simple no acepta Foundations ni crea recursos aunque arranque sea auto", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", renderFoundationsBlock(block([], { arranque: "auto" })));
	const f = await beginFixture(t, { kb });
	f.remote.requestClassify = JSON.stringify({ triage: { type: "chore", summary: "Errata", rationale: "Texto", scope: [], acceptanceCriteria: [], questions: [] }, assessment: { scope: "localized", impact: "documentation", reversible: "yes", verification: "clear", risk: "low", riskAreas: [], rationale: "Sólo texto" } });
	await f.ask({ title: "Errata", body: "Cambiar holaa por hola", reason: "Texto" });
	assert.deepEqual(f.prompts, []); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.switches, []); assert.equal(f.continuations.length, 1);
	assert.ok(!kb.calls.some((call) => call.tool === "guardar"));
});
test("foundations_policy v2: arranque auto conserva guardas sin efectos y avisa cuando crea recursos", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", renderFoundationsBlock(block([], { arranque: "auto" })));
	const blocked = await beginFixture(t, { kb, noMain: true }); await blocked.ask({ title: "Arreglar", body: "Debe dar 2", reason: "Bug" });
	assert.deepEqual(blocked.prompts, []); assert.deepEqual(blocked.remote.created, []);
	const f = await beginFixture(t, { kb }); const origin = f.current(); await f.ask({ title: "Arreglar", body: "Debe dar 2", reason: "Bug" });
	assert.deepEqual(f.prompts.map((prompt) => prompt.title), [ACCEPT]); assert.equal(f.remote.created.length, 1);
	assert.ok(origin.notices.some((notice) => /Foundations · arranque auto: Crear issue y empezar el trabajo/.test(notice)));
	assert.ok(origin.notices.some((notice) => /arranque auto.*sin preguntar/s.test(notice)));
	assert.notEqual(f.current().manager.getSessionFile(), f.main.getSessionFile());
});
test("foundations_policy v2: receta auto queda registrada, no abre revisión y no dispensa el sí por match", async (t) => {
	const f = await fixture(t, block([OK], { receta: "auto" })); await f.start(); await approve(f); const state = await f.state();
	assert.equal(state.phase, "implement"); assert.equal(state.approval?.by, "foundations");
	assert.match(state.approval?.foundations ?? "", /^[0-9a-f]{64}$/); assert.equal(f.reviews(), 0);
	assert.deepEqual(others(f.prompts), ["Empezar el trabajo del issue #42"]); assert.equal(f.remote.comments.length, 0);
	assert.match(f.remote.body, /<!-- omi:harness:start -->/);
	assert.match(f.remote.body, /\*\*Aprobación:\*\* aprobada por Foundations \(receta: auto\), sin revisión humana/);
	await f.action({ action: "step", id: "C1" }); await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
	await f.invoke("omi_workflow_check", { kind: "red", command: OK, stepId: "C1" }); assert.equal(f.asked(), 1);
});
async function toPr(f: Fixture) {
	await f.action({ action: "step", id: "C1" }); await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
	await f.invoke("omi_workflow_check", { kind: "red", command: OK, stepId: "C1" }); await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: OK, stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: OK, caseId: "D1" }); await f.invoke("omi_workflow_lens", { lens: "quality" }); await f.action({ action: "verified" });
}
test("foundations_policy v2: push_pr auto conserva push normal y draft, nunca force/merge", async (t) => {
	const f = await fixture(t, block([], { push_pr: "auto" })); await f.start(); await approve(f); await toPr(f); await f.action({ action: "publish" });
	assert.equal((await f.state()).phase, "done"); assert.ok(!f.prompts.includes("Subir rama y abrir PR draft")); assert.ok(f.messages.some((message) => /push \+ PR draft auto/.test(message)));
	const remote = f.calls.filter((call) => call.command === "git" || call.command === "gh").map((call) => call.args); const pushes = remote.filter((args) => args.includes("push"));
	assert.ok(pushes.length > 0); assert.ok(!pushes.some((args) => args.some((arg) => /^(?:--force.*|-f|\+.*)$/.test(arg)))); assert.ok(!remote.some((args) => args.includes("merge")));
});
test("foundations_policy v2: otros tres puntos ask siguen preguntando aunque un comando simple no coincidente sea auto", async (t) => {
	const f = await fixture(t); await f.start(); await approve(f); await toPr(f); await f.action({ action: "publish" });
	assert.deepEqual(others(f.prompts), ["Empezar el trabajo del issue #42", "Aprobar receta y sincronizar issue", "Subir rama y abrir PR draft"]);
});
test("foundations_policy v2: receta auto tras replan conserva identidad de Foundations, no crea grants", async (t) => {
	const f = await fixture(t, block([], { receta: "auto" })); await f.start(); await approve(f); const before = (await f.state()).approval!;
	f.manager.appendMessage({ role: "user", content: "Sumá también que other.cjs devuelva 2", timestamp: Date.now() });
	await f.action({ action: "agreed", quote: "Sumá también que other.cjs devuelva 2", agreement: "Ampliar alcance a other.cjs", replan: true });
	assert.equal((await f.state()).phase, "recipe"); await f.action({ action: "planned", plan: { ...f.plan(), cases: [...f.plan().cases, { id: "D2", description: "Otro devuelve 2", command: "node other-test.cjs" }] } }); await f.action({ action: "approve" });
	assertAutomaticReplanOutcome(await f.state(), before.foundations ?? "", f.remote.body);
	assert.equal(f.reviews(), 0); assert.ok(!f.prompts.includes("Aprobar receta y sincronizar issue"));
});
