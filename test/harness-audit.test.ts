import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition } from "../src/harness/state.ts";
import type { Evidence, Workflow } from "../src/harness/model.ts";

function failedVerification() {
	const at = "now"; let s = createWorkflow({ number: 1, title: "Cambio", body: "Pedido", url: "https://github.com/t/r/issues/1", hash: "x" }, { root: "/repo", commonDir: "/repo/.git", branch: "feat/work", baseCommit: "base" }, "id", at);
	const send = (event: Parameters<typeof transition>[1]) => { s = transition(s, event, at); };
	send({ type: "explored", exploration: { references: [{ path: "src/a", line: 1, detail: "Leído" }], findings: [], approach: "Cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } });
	send({ type: "inferences", inferences: [] });
	send({ type: "planned", plan: { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Cambiar", approach: "Modificar", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Funciona", command: "test" }], lenses: [], executor: { mode: "inline", writers: 0 } } });
	send({ type: "approved" }); send({ type: "step_started", id: "C1" });
	const e: Evidence = { id: "red", kind: "red", command: "test", stepId: "C1", caseId: "D1", exitCode: 1, outcome: "failed", output: "red", fingerprint: "tree", head: "head", startedAt: at, finishedAt: at };
	send({ type: "evidence", evidence: e }); send({ type: "evidence", evidence: { ...e, id: "green", kind: "green", exitCode: 0, outcome: "passed", output: "green" } });
	send({ type: "step_completed", id: "C1", commit: "commit", fingerprint: "tree" });
	send({ type: "evidence", evidence: { ...e, id: "verification", kind: "verification", stepId: null, output: "REAL_FAILURE_DETAILS" } });
	return s;
}
function archive(s: Workflow): unknown {
	return "attempts" in s ? s.attempts : undefined;
}
test("harness_audit retry conserva resultados completos pero no los deja acreditar la vuelta siguiente", () => {
	const failed = failedVerification(); const next = transition(failed, { type: "retry", reason: "Falló D1" }, "later");
	assert.match(JSON.stringify(archive(next)), /REAL_FAILURE_DETAILS/);
	assert.equal(next.evidence.length, 0); assert.equal(next.phase, "implement");
	assert.throws(() => transition(next, { type: "verified", fingerprint: "tree" }, "later"));
});
test("harness_audit cambiar el pedido no borra la evidencia de la revisión anterior", () => {
	const failed = failedVerification(); const next = transition(failed, { type: "source_changed", source: { ...failed.source, body: "Nuevo pedido" } }, "later");
	assert.match(JSON.stringify(archive(next)), /REAL_FAILURE_DETAILS/);
	assert.equal(next.phase, "explore"); assert.equal(next.approval, null); assert.equal(next.evidence.length, 0);
});
