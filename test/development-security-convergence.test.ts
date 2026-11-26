// Convergencia de security con Git real y modelo falso: qué recibe el lente de su revisión anterior y qué baja el host.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import { ReviewSchema } from "../src/harness/model.ts";
import { SECURITY_DOWNGRADED, SECURITY_PREVIOUS_NOTE } from "../src/harness/security-convergence.ts";
import { developmentFixture } from "./helpers/development.ts";

type LensCall = { systemPrompt: string; messages: { content: { text: string }[] }[] };
type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
const material = (call: unknown) => JSON.parse((call as LensCall).messages[0]!.content[0]!.text);
const answer = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text) as { notice?: string };
const FAST = { deps: { lensCall: { timeoutMs: 200, baseDelayMs: 1, graceMs: 50 } } };
// La primera revisión: un blocker de clase otro en value.cjs, que C1 cambió.
const FIRST = { severity: "blocker", clase: "otro", finding: "value.cjs:1 · el módulo queda con permiso de escritura para todos" };

async function verifying(t: TestContext): Promise<Fixture> {
	const f = await developmentFixture(t, FAST); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: { ...f.plan(), lenses: ["security"] } }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	return f;
}
// Un paso de corrección que sólo agrega `name`.test.cjs (rojo: falta el módulo) y `name`.cjs (verde); después, D1 otra vez.
async function correct(f: Fixture, id: string, name: string): Promise<void> {
	await f.action({ action: "step", id });
	await f.write(`${name}.test.cjs`, `require("node:assert/strict").equal(require("./${name}.cjs"), 0);\n`);
	await f.invoke("omi_workflow_check", { kind: "red", command: `node ${name}.test.cjs`, stepId: id });
	await f.write(`${name}.cjs`, "module.exports = 0;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: `node ${name}.test.cjs`, stepId: id });
	await f.invoke("omi_workflow_commit", { stepId: id, paths: [`${name}.test.cjs`, `${name}.cjs`], message: `fix: cubrir ${name}` });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
}
/** El modelo falso: `first` sin revisión anterior; `second` cuando el host le manda previous. */
function replies(f: Fixture, first: unknown[], second: unknown[]): void {
	f.modelControl.reply = (input) => JSON.stringify({ verdict: "fail", findings: material(input).previous ? second : first });
}
/** Security bloquea sobre C1, retry y C2 agrega extra.cjs: desde la revisión anterior cambiaron sólo extra.cjs y su test. */
async function afterRetry(f: Fixture) {
	const blocked = await f.invoke("omi_workflow_lens", { lens: "security" });
	assert.equal(blocked.isError, true);
	const base = (await f.state()).reviews.at(-1)!;
	await f.action({ action: "retry", reason: "Cerrar el permiso" });
	await correct(f, "C2", "extra");
	return base;
}

test("development_security_convergence tras retry, security recibe del host sus hallazgos anteriores y los archivos cambiados desde su revisión", async (t) => {
	const f = await verifying(t);
	f.modelControl.reply = (input) => JSON.stringify(material(input).previous ? { verdict: "pass", findings: [] } : { verdict: "fail", findings: [FIRST] });
	const base = await afterRetry(f);
	const first = f.modelCalls.find((call) => /seguridad/.test((call as LensCall).systemPrompt)) as LensCall;
	assert.equal(material(first).previous, undefined, "la primera revisión no tiene con qué comparar");
	assert.ok(!first.systemPrompt.includes(SECURITY_PREVIOUS_NOTE));
	await f.invoke("omi_workflow_lens", { lens: "security" });
	const call = f.modelCalls.at(-1) as LensCall;
	assert.ok(call.systemPrompt.includes(SECURITY_PREVIOUS_NOTE), "el prompt explica previous");
	assert.match(call.systemPrompt, /"clase":"secreto\|exfiltración\|otro"/);
	assert.deepEqual(material(call).previous, { fingerprint: base.fingerprint, verdict: "fail", findings: [{ blocker: true, text: FIRST.finding }], changedFiles: ["extra.cjs", "extra.test.cjs"] });
	const activities = f.progress.map((p) => (p as { progress?: { activity?: string } }).progress?.activity ?? "");
	assert.ok(activities.some((a) => a.includes("compara con la revisión anterior: 2 archivos cambiados")), JSON.stringify(activities.filter((a) => a.includes("Lente"))));
	await f.action({ action: "verified" }); assert.equal((await f.state()).phase, "pr");
});

test("development_security_convergence un blocker nuevo de clase otro en un archivo sin cambios baja a aviso, no frena verified y se ve en el PR", async (t) => {
	const f = await verifying(t);
	const fresh = { severity: "blocker", clase: "otro", finding: "other.cjs:1 · el módulo vecino exporta sin validar" };
	replies(f, [FIRST], [fresh]);
	await afterRetry(f);
	const result = await f.invoke("omi_workflow_lens", { lens: "security" });
	assert.equal(result.isError, false);
	assert.match(answer(result).notice ?? "", /no bloquea Verificar.* 1 blocker\(s\) bajados a aviso: archivo sin cambios desde la revisión anterior de security\.$/);
	const review = (await f.state()).reviews.at(-1)!;
	assert.deepEqual({ verdict: review.verdict, findings: review.findings, severities: review.severities }, { verdict: "fail", findings: [`${SECURITY_DOWNGRADED} · ${fresh.finding}`], severities: ["aviso"] });
	assert.equal("downgradable" in review, false, "la clase no se guarda");
	assert.equal(Value.Check(ReviewSchema, review), true);
	await f.action({ action: "verified" }); assert.equal((await f.state()).phase, "pr");
	await f.action({ action: "publish" });
	assert.match(f.remote.prBody, /^ {4}- aviso · bajado a aviso: archivo sin cambios desde la revisión anterior · other\.cjs:1 · el módulo vecino exporta sin validar$/m);
});

test("development_security_convergence tras amend, la base es la review de security de la misma vuelta", async (t) => {
	const f = await verifying(t);
	replies(f, [{ severity: "aviso", clase: "otro", finding: "value.cjs:1 · el log crece" }], [{ severity: "blocker", clase: "otro", finding: "value.cjs:1 · el log crece sin tope" }]);
	await f.invoke("omi_workflow_lens", { lens: "security" });
	const base = (await f.state()).reviews.at(-1)!;
	await f.action({ action: "amend", reason: "Acotar el log" });
	await correct(f, "C2", "log");
	const result = await f.invoke("omi_workflow_lens", { lens: "security" });
	const state = await f.state();
	assert.equal(state.round, 0, "amend no gasta vuelta");
	assert.deepEqual(material(f.modelCalls.at(-1)).previous, { fingerprint: base.fingerprint, verdict: "fail", findings: [{ blocker: false, text: "value.cjs:1 · el log crece" }], changedFiles: ["log.cjs", "log.test.cjs"] });
	assert.equal(result.isError, false, "un aviso anterior no cuenta para la regla (b) y value.cjs no cambió desde C1");
	assert.deepEqual(state.reviews.at(-1)!.severities, ["aviso"]);
	await f.action({ action: "verified" }); assert.equal((await f.state()).phase, "pr");
});

test("development_security_convergence sigue bloqueando un blocker en un archivo cambiado, el que repite el archivo de un blocker anterior, uno de clase secreto o exfiltración y uno sin clase", async (t) => {
	const f = await verifying(t);
	const kept = [
		{ severity: "blocker", clase: "otro", finding: "extra.cjs:1 · el módulo nuevo exporta sin validar" },
		{ severity: "blocker", clase: "otro", finding: "value.cjs:1 · el permiso sigue abierto" },
		{ severity: "blocker", clase: "secreto", finding: "other.cjs:1 · deja la configuración en el log" },
		{ severity: "blocker", clase: "exfiltración", finding: "other-test.cjs:1 · un valor de la KB elige a qué servidor se manda el diff" },
		{ severity: "blocker", finding: "other.cjs:1 · el módulo vecino exporta sin validar" },
	];
	// Control: el mismo archivo sin cambios con clase otro sí baja, así lo que se mantiene no es por falta de comparación.
	const control = { severity: "blocker", clase: "otro", finding: "other-test.cjs:1 · la prueba vecina corre con permisos de más" };
	replies(f, [FIRST], [...kept, control]);
	await afterRetry(f);
	const result = await f.invoke("omi_workflow_lens", { lens: "security" });
	assert.equal(result.isError, true);
	assert.match(answer(result).notice ?? "", /accept-risk.* 1 blocker\(s\) bajados a aviso/);
	const review = (await f.state()).reviews.at(-1)!;
	assert.deepEqual(review.findings, [...kept.map((k) => k.finding), `${SECURITY_DOWNGRADED} · ${control.finding}`]);
	assert.deepEqual(review.severities, [...kept.map(() => "blocker"), "aviso"]);
	await assert.rejects(f.action({ action: "verified" }), /seguridad/);
});
