// Vuelta extra: con 0 retry, una persona suma una vuelta sin perder receta, aprobación, pasos ni evidencia.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { adoptPostPrWorkflow } from "../src/harness/lifecycle-corrections.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import { sourceHash, WorkflowV2Schema, type Evidence, type Exploration, type Plan, type Workflow, type WorkflowV2 } from "../src/harness/model.ts";

const at = "2026-01-01T00:00:00Z";
const source = { number: 42, title: "Change", body: "Details", url: "https://github.com/acme/app/issues/42", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "a".repeat(40) };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
const REASON = "Falta cerrar el destino del proveedor";
let ids = 0;
function evidence(kind: Evidence["kind"], fingerprint: string, changes: Partial<Evidence> = {}): Evidence {
	const failed = kind === "red";
	return { id: `${kind}-${ids++}`, kind, command: "npm test", stepId: null, caseId: "D1", exitCode: failed ? 1 : 0, outcome: failed ? "failed" : "passed", output: "out", fingerprint, head: fingerprint, startedAt: at, finishedAt: at, ...changes };
}
function implement(s: Workflow, id: string, fingerprint: string): Workflow {
	s = send(s, { type: "step_started", id });
	s = send(s, { type: "evidence", evidence: evidence("red", fingerprint, { stepId: id }) });
	s = send(s, { type: "evidence", evidence: evidence("green", fingerprint, { stepId: id }) });
	return send(s, { type: "step_completed", id, commit: `commit-${id}`, fingerprint });
}
function approved(): Workflow {
	const s = send(createWorkflow(source, checkout, "workflow", at), { type: "explored", exploration });
	return send(send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan }), { type: "approved" });
}
const failedD = (s: Workflow, fingerprint: string) => send(s, { type: "evidence", evidence: evidence("verification", fingerprint, { exitCode: 1, outcome: "failed" }) });
/** Vuelta 3 de 3 en Verificar con D1 rojo: el retry siguiente agota las vueltas. */
const lastRound = () => failedD(implement({ ...approved(), round: 3 }, "C1", "tree"), "tree");
const EXHAUSTED = /agotaron las vueltas/;
const add = (s: Workflow, reason = REASON) => send(s, { type: "round_added", reason });

test("harness_extra_round con 0 retry una persona suma una vuelta: el retry que agotó vuelve a abrir vuelta", () => {
	const exhausted = send(lastRound(), { type: "retry", reason: "Falló D1" });
	assert.equal(exhausted.status, "waiting"); assert.match(exhausted.blockedReason, EXHAUSTED);
	const added = add(exhausted);
	assert.equal(added.maxRounds, 4); assert.equal(added.round, 3); assert.equal(added.status, "active"); assert.equal(added.blockedReason, "");
	assert.equal(added.activity, `round_added: ${REASON}`);
	assert.deepEqual(added.steps, exhausted.steps); assert.deepEqual(added.evidence, exhausted.evidence); assert.deepEqual(added.approval, exhausted.approval);
	const retried = send(added, { type: "retry", reason: "Falló D1" });
	assert.equal(retried.round, 4); assert.equal(retried.phase, "implement");
	const again = send(failedD(implement(retried, "C2", "tree2"), "tree2"), { type: "retry", reason: "Falló D1 otra vez" });
	assert.equal(again.status, "waiting"); assert.match(again.blockedReason, EXHAUSTED); assert.equal(again.round, 4);
});

test("harness_extra_round se rechaza con retry disponibles, sin motivo, en el tope de 10, con el PR adoptado o fuera de Implementar, Verificar y PR draft", () => {
	assert.throws(() => add(failedD(implement(approved(), "C1", "tree"), "tree")), /todavía quedan 3 retry: no hace falta otra vuelta/);
	assert.throws(() => add(lastRound(), "   "), /falta el motivo de la vuelta extra/);
	assert.throws(() => add({ ...lastRound(), round: 10, maxRounds: 10 }), /el tope es de 10 vueltas; para seguir, \/omi-work refresh/);
	assert.throws(() => add({ ...createWorkflow(source, checkout, "workflow", at), round: 3 }), /evento inválido en fase explore/);
	assert.throws(() => add({ ...adopted(), round: 3 }), /post-PR usa corrección propia; no suma vueltas/);
});

test("harness_extra_round pausado (como #99) o agotado: suma la vuelta y limpia el bloqueo de vueltas agotadas sin reanudar; el estado sigue válido para el esquema anterior", () => {
	// Como #99: vuelta 3 de 3 en Implementar, con el paso de corrección pendiente y el trabajo pausado.
	const retried = send({ ...failedD(implement(approved(), "C1", "tree"), "tree"), round: 2 }, { type: "retry", reason: "Falló D1" });
	const paused = send(retried, { type: "pause", reason: "Pausado por la persona" });
	assert.equal(paused.round, 3); assert.equal(paused.maxRounds, 3); assert.equal(paused.phase, "implement");
	const added = add(paused);
	assert.equal(added.maxRounds, 4); assert.equal(added.status, "paused"); assert.equal(added.phase, "implement");
	assert.deepEqual(Object.keys(added).sort(), Object.keys(paused).sort(), "no agrega campos");
	assert.equal(Value.Check(WorkflowV2Schema, added), true);
	const resumed = send(added, { type: "resume" }); assert.equal(resumed.status, "active");
	assert.equal(send(resumed, { type: "step_started", id: "C2" }).steps.at(-1)?.status, "active");
	// Agotado y pausado: limpia el bloqueo, sigue pausado y resume retoma.
	const stopped = send(send(lastRound(), { type: "retry", reason: "Falló D1" }), { type: "pause", reason: "Lo decide una persona" });
	assert.match(stopped.blockedReason, EXHAUSTED);
	const unblocked = add(stopped);
	assert.equal(unblocked.status, "paused"); assert.equal(unblocked.blockedReason, ""); assert.equal(unblocked.maxRounds, 4);
	assert.equal(send(unblocked, { type: "resume" }).status, "active");
});

/** Un PR draft publicado y adoptado por el lifecycle: corrige por su cuenta, no con vueltas. */
function adopted(): WorkflowV2 {
	const head = "b".repeat(40), fingerprint = "c".repeat(64);
	let s = implement(approved(), "C1", fingerprint); s = send(s, { type: "evidence", evidence: evidence("verification", fingerprint, { head }) }); s = send(s, { type: "verified", fingerprint });
	s = send(send(s, { type: "publishing", head, bodyHash: "body" }), { type: "published", head, url: "https://github.com/acme/app/pull/42", number: 42 });
	const block = defaultLifecycleConfig("acme/app", "main");
	const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
	const subject = { id: "subject", repo: "acme/app", number: 42, branch: "work", base: "main", headSha: head, baseSha: "a".repeat(40), contentHash: fingerprint, mergedSha: null };
	return adoptPostPrWorkflow(s, pin, subject, { id: "adopt", source: "person", at });
}
