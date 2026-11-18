// Lentes de Verificar con Git real y modelo falso: qué material ven y qué decide su veredicto.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Plan } from "../src/harness/model.ts";
import { developmentFixture } from "./helpers/development.ts";

type LensCall = { systemPrompt: string; messages: { content: { text: string }[] }[] };
const material = (call: unknown) => JSON.parse((call as LensCall).messages[0]!.content[0]!.text);

async function verifying(t: TestContext, lenses: Plan["lenses"] = ["compliance"]) {
	const f = await developmentFixture(t); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: { ...f.plan(), lenses } }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	return f;
}

test("development_lenses el lente recibe la evidencia que registró el harness: comando, etiqueta, exit, rojo→verde con HEAD/fingerprint y salida", async (t) => {
	const f = await verifying(t);
	await f.invoke("omi_workflow_lens", { lens: "compliance" });
	const call = f.modelCalls.at(-1) as LensCall; const sent = material(call); const state = await f.state();
	assert.match(call.systemPrompt, /registr[óo] el harness/i);
	assert.match(call.systemPrompt, /no (lo escribió|la escribió) el modelo/i);
	const step = sent.evidence.steps.find((s: { id: string }) => s.id === "C1");
	assert.equal(step.commit, state.steps[0]?.commit);
	assert.deepEqual(step.history.map((e: { kind: string; exitCode: number; command: string }) => [e.kind, e.exitCode, e.command]), [["red", 1, "node test.cjs"], ["green", 0, "node test.cjs"]]);
	const [red, green] = step.history;
	assert.match(red.output, /AssertionError/); assert.notEqual(red.fingerprint, green.fingerprint); assert.ok(red.head && green.head);
	const verification = state.evidence.findLast((e) => e.kind === "verification")!;
	const d1 = sent.evidence.cases.find((c: { id: string }) => c.id === "D1");
	assert.equal(d1.command, "node test.cjs");
	assert.deepEqual({ kind: d1.verification.kind, exitCode: d1.verification.exitCode, head: d1.verification.head, fingerprint: d1.verification.fingerprint }, { kind: "verification", exitCode: 0, head: verification.head, fingerprint: verification.fingerprint });
	assert.equal(sent.content.fingerprint, verification.fingerprint);
});

test("development_lenses tras una vuelta, el paso anterior conserva su rojo y verde acreditados como evidencia archivada", async (t) => {
	const f = await verifying(t);
	await f.action({ action: "retry", reason: "Cubrir el valor 3" }); await f.action({ action: "step", id: "C2" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C2" });
	await f.write("value.cjs", "module.exports = 3;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C2" });
	await f.invoke("omi_workflow_commit", { stepId: "C2", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 3" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	await f.invoke("omi_workflow_lens", { lens: "compliance" });
	const steps = material(f.modelCalls.at(-1)).evidence.steps;
	assert.deepEqual(steps.find((s: { id: string }) => s.id === "C1").history.map((e: { kind: string; archived?: boolean }) => [e.kind, e.archived]), [["red", true], ["green", true]]);
	assert.deepEqual(steps.find((s: { id: string }) => s.id === "C2").history.map((e: { kind: string; archived?: boolean }) => [e.kind, e.archived]), [["red", undefined], ["green", undefined]]);
});
