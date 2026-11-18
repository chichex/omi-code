// Lentes de Verificar con Git real y modelo falso: qué material ven y qué decide su veredicto.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import type { Plan } from "../src/harness/model.ts";
import { LENS_PART_BUDGET } from "../src/harness/lenses.ts";
import { developmentFixture } from "./helpers/development.ts";

type LensCall = { systemPrompt: string; messages: { content: { text: string }[] }[] };
const material = (call: unknown) => JSON.parse((call as LensCall).messages[0]!.content[0]!.text);

async function verifying(t: TestContext, lenses: Plan["lenses"] = ["compliance"], extra: Record<string, string> = {}) {
	const f = await developmentFixture(t); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: { ...f.plan(), lenses } }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); for (const [path, body] of Object.entries(extra)) await f.write(path, body);
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs", ...Object.keys(extra)], message: "fix: devolver 2" });
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

test("development_lenses un unknown o fail de un lente asesor queda como aviso: no frena Verificar ni el PR draft, y se ve en el progreso y en el PR", async (t) => {
	const f = await verifying(t, ["compliance", "reliability"]);
	f.modelControl.reply = (input) => JSON.stringify((input as LensCall).systemPrompt.includes("tests de comportamiento") ? { verdict: "fail", findings: ["test.cjs:1 · falta el caso 0"] } : { verdict: "unknown", findings: ["No se puede saber si D1 cubre el pedido"] });
	const compliance = await f.invoke("omi_workflow_lens", { lens: "compliance" }); const reliability = await f.invoke("omi_workflow_lens", { lens: "reliability" });
	for (const result of [compliance, reliability]) { assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /aviso/i); }
	await f.action({ action: "verified" }); assert.equal((await f.state()).phase, "pr");
	const progress = (f.progress.at(-1) as { progress: { warnings: string[]; stages: { id: string; status: string }[] } }).progress;
	assert.equal(progress.stages.find((s) => s.id === "verify")?.status, "warning");
	assert.ok(progress.warnings.some((w) => /compliance/.test(w) && /unknown/.test(w) && /D1 cubre/.test(w)), JSON.stringify(progress.warnings));
	assert.ok(progress.warnings.some((w) => /reliability/.test(w) && /fail/.test(w) && /caso 0/.test(w)));
	await f.action({ action: "publish" });
	assert.equal((await f.state()).phase, "done");
	assert.match(f.remote.prBody, /Avisos de los lentes/); assert.match(f.remote.prBody, /compliance.*unknown/); assert.match(f.remote.prBody, /falta el caso 0/);
});

test("development_lenses un fail del lente de seguridad sí bloquea Verificar", async (t) => {
	const f = await verifying(t, ["security"]);
	f.modelControl.reply = () => JSON.stringify({ verdict: "fail", findings: ["value.cjs:1 · expone un secreto"] });
	const result = await f.invoke("omi_workflow_lens", { lens: "security" });
	assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /bloquea/);
	await assert.rejects(f.action({ action: "verified" }), /seguridad/);
	const progress = (f.progress.at(-1) as { progress: { stages: { id: string; status: string }[] } }).progress;
	assert.equal(progress.stages.find((s) => s.id === "verify")?.status, "failed");
});

test("development_lenses un diff más grande que una llamada se revisa completo por partes y se combina: el peor veredicto gana", async (t) => {
	const lines = Array.from({ length: 4000 }, (_, i) => `línea ${i} ${"d".repeat(60)}`).join("\n") + "\nFIN-DEL-ARCHIVO\n";
	const f = await verifying(t, ["quality"], { "data.txt": lines, "notes.md": "nota\n" });
	const full = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--color=never", f.checkout.baseCommit, "--"], { cwd: f.checkout.root, encoding: "utf8" });
	assert.ok(full.length > 200_000);
	const before = f.modelCalls.length;
	f.modelControl.reply = (input) => JSON.stringify(material(input).diff.includes("FIN-DEL-ARCHIVO") ? { verdict: "fail", findings: ["data.txt:4001 · cierre sin prueba"] } : { verdict: "pass", findings: [] });
	const result = await f.invoke("omi_workflow_lens", { lens: "quality" });
	const calls = f.modelCalls.slice(before); const sent = calls.map(material);
	assert.ok(calls.length >= 2, "más de una llamada");
	assert.deepEqual(sent.map((m) => m.part), sent.map((_, i) => ({ index: i + 1, total: calls.length })));
	for (const m of sent) { assert.ok(m.evidence.steps.length, "cada parte trae la evidencia"); assert.deepEqual(m.cases, sent[0].cases); }
	assert.equal(sent.map((m) => m.diff.replace(/^\[continúa [^\n]*\]\n/gm, "")).join(""), full, "ninguna parte trunca el diff");
	assert.equal(result.usage?.totalTokens, 3 * calls.length, "se suma el uso de todas las partes");
	const review = (await f.state()).reviews.at(-1)!;
	assert.equal(review.verdict, "fail"); assert.match(review.findings[0]!, new RegExp(`^parte ${calls.length}/${calls.length} · data\\.txt:4001`));
	// La consulta del agente usa el mismo reparto: nunca falla ni trunca por tamaño.
	const inspected = await f.invoke("omi_workflow_inspect", { diff: true }); const first = (inspected.details as { diff: { part: number; total: number; text: string } }).diff;
	assert.equal(first.part, 1); assert.ok(first.total >= 2);
	const rest = await Promise.all(Array.from({ length: first.total - 1 }, (_, i) => f.invoke("omi_workflow_inspect", { diff: true, diffPart: i + 2 })));
	const texts = [first.text, ...rest.map((r) => (r.details as { diff: { text: string } }).diff.text)];
	assert.equal(texts.map((d) => d.replace(/^\[continúa [^\n]*\]\n/gm, "")).join(""), full);
	await assert.rejects(f.invoke("omi_workflow_inspect", { diff: true, diffPart: first.total + 1 }), /parte/);
});

test("development_lenses la evidencia cuenta en el presupuesto: ninguna llamada lo pasa y, si no entra, se resume y lo dice", async (t) => {
	const lines = Array.from({ length: 4000 }, (_, i) => `linea "${i}" \\ ${"d".repeat(60)}`).join("\n") + "\nFIN-DEL-ARCHIVO\n";
	const f = await verifying(t, ["quality"], { "data.txt": lines });
	const gates = ["node -e \"process.stdout.write('g'.repeat(13000))\"", "node -e \"process.stdout.write('h'.repeat(13000))\""];
	for (let round = 0; round < 4; round++) for (const command of gates) await f.invoke("omi_workflow_check", { kind: "gate", command });
	const before = f.modelCalls.length;
	await f.invoke("omi_workflow_lens", { lens: "quality" });
	const calls = f.modelCalls.slice(before) as LensCall[]; const sent = calls.map(material);
	assert.ok(calls.length >= 2);
	for (const call of calls) assert.ok(call.messages[0]!.content[0]!.text.length <= LENS_PART_BUDGET, `${call.messages[0]!.content[0]!.text.length} > ${LENS_PART_BUDGET}`);
	for (const m of sent) {
		assert.deepEqual(m.evidence, sent[0].evidence, "la misma evidencia en cada parte");
		assert.deepEqual(m.evidence.gates.map((g: { command: string }) => g.command), gates, "la última corrida de cada gate");
		assert.equal(m.evidence.summarized.omittedRuns, 6, "cuenta lo que no vino");
	}
	assert.match(calls[0]!.systemPrompt, /summarized/);
	const full = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--color=never", f.checkout.baseCommit, "--"], { cwd: f.checkout.root, encoding: "utf8" });
	assert.equal(sent.map((m) => m.diff.replace(/^\[continúa [^\n]*\]\n/gm, "")).join(""), full, "ninguna parte trunca el diff");
});
