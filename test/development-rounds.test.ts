// La vuelta y los retry que quedan salen del estado: lo que anuncia la guía es lo que acepta el reducer.
// #98 pausó con un retry disponible y #99 frenó antes de terminar sus C porque la guía decía otra cuenta (2026-11-26).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { Value } from "typebox/value";
import { parseWorkflow, sourceHash, WorkflowV1Schema, type Workflow, type WorkflowV2, type Evidence, type Plan, type Exploration } from "../src/harness/model.ts";
import { roundBudget, roundBudgetLine } from "../src/harness/rounds.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";

// El mismo trabajo de test/harness-state.test.ts: un D, el lente quality y el reducer real.
const at = "2026-01-01T00:00:00Z";
const source = { number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: ["quality"], executor: { mode: "inline", writers: 1 } };
const fresh = () => createWorkflow(source, checkout, "workflow", at);
const send = (s: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(s, event, at);
function ready() { let s = send(fresh(), { type: "explored", exploration }); s = send(s, { type: "inferences", inferences: [] }); return send(s, { type: "planned", plan }); }
function evidence(kind: Evidence["kind"], changes: Partial<Evidence> = {}): Evidence { return { id: kind, kind, command: "npm test", stepId: kind === "red" || kind === "green" ? "C1" : null, caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "actual output", fingerprint: "tree", head: "head", startedAt: at, finishedAt: at, ...changes }; }
function verifying() { let s = send(ready(), { type: "approved" }); s = send(s, { type: "step_started", id: "C1" }); s = send(s, { type: "evidence", evidence: evidence("red") }); s = send(s, { type: "evidence", evidence: evidence("green") }); return send(s, { type: "step_completed", id: "C1", commit: "head", fingerprint: "tree" }); }
function pr() { let s = send(verifying(), { type: "evidence", evidence: evidence("verification") }); s = send(s, { type: "reviewed", review: { lens: "quality", fingerprint: "tree", verdict: "pass", findings: [], at } }); return send(s, { type: "verified", fingerprint: "tree" }); }
// Una vuelta agrega un paso de corrección: rojo, verde y commit nuevos.
function correct(s: WorkflowV2, round: number): WorkflowV2 {
 const id = `C${round + 1}`;
 s = send(s, { type: "step_started", id });
 s = send(s, { type: "evidence", evidence: evidence("red", { id: `red${round}`, stepId: id }) });
 s = send(s, { type: "evidence", evidence: evidence("green", { id: `green${round}`, stepId: id }) });
 return send(s, { type: "step_completed", id, commit: `fix${round}`, fingerprint: "tree" });
}

const BUDGET = /Presupuesto: vuelta (\d+) de (\d+) · quedan? (\d+) retry · amends (\d+) de 2/;
function announced(s: Workflow) {
 const match = BUDGET.exec(developmentInstructions(s)); assert.ok(match, "la guía dice el presupuesto");
 return { round: Number(match[1]), maxRounds: Number(match[2]), left: Number(match[3]), amends: Number(match[4]) };
}

test("development_rounds lo que anuncia la guía es lo que el reducer acepta: con N retry, N abren vuelta, el siguiente deja el trabajo esperando, y una vuelta sumada por una persona vuelve a coincidir", () => {
 let s = pr();
 const first = announced(s); assert.deepEqual(first, { round: 0, maxRounds: 3, left: 3, amends: 0 });
 for (let i = 1; i <= first.left; i++) {
  s = send(s, { type: "retry", reason: `vuelta ${i}` });
  assert.equal(s.phase, "implement"); assert.equal(s.status, "active"); assert.equal(s.round, i, `el retry ${i} abre la vuelta ${i}`);
  assert.equal(announced(s).left, first.left - i);
  s = correct(s, i);
 }
 assert.equal(announced(s).left, 0);
 s = send(s, { type: "retry", reason: "una más" });
 assert.equal(s.status, "waiting"); assert.equal(s.round, first.left, "el retry siguiente no abre vuelta: deja el trabajo esperando");
 assert.deepEqual(announced(s), { round: 3, maxRounds: 3, left: 0, amends: 0 });
 s = send(s, { type: "round_added", reason: "La persona suma una vuelta" });
 const added = announced(s); assert.deepEqual(added, { round: 3, maxRounds: 4, left: 1, amends: 0 });
 assert.equal(s.status, "active");
 for (let i = 1; i <= added.left; i++) { s = send(s, { type: "retry", reason: "vuelta sumada" }); assert.equal(s.phase, "implement"); assert.equal(s.round, 3 + i); s = correct(s, s.round); }
 s = send(s, { type: "retry", reason: "otra más" });
 assert.equal(s.status, "waiting"); assert.equal(s.round, 4, "con la vuelta sumada, el reducer acepta exactamente 1 retry más");
});

test("development_rounds la línea sale del estado guardado: Verificar en la vuelta 2 con 2 amends, Implementar en la vuelta 3 y v1 migrado sin amends; nada en Explorar ni con el PR adoptado", () => {
 let s = pr();
 for (const round of [1, 2]) s = correct(send(s, { type: "retry", reason: `vuelta ${round}` }), round);
 assert.equal(s.phase, "verify"); assert.equal(s.round, 2);
 const amended = parseWorkflow(JSON.stringify({ ...s, amends: [{ from: "a", reason: "aviso", at }, { from: "b", reason: "rojo", at }] }));
 assert.deepEqual(roundBudget(amended), { round: 2, maxRounds: 3, retriesLeft: 1, amends: 2, maxAmends: 2 });
 assert.equal(roundBudgetLine(amended), "vuelta 2 de 3 · queda 1 retry · amends 2 de 2");
 const implementing = parseWorkflow(JSON.stringify(send(s, { type: "retry", reason: "vuelta 3" })));
 assert.equal(implementing.phase, "implement");
 assert.equal(roundBudgetLine(implementing), "vuelta 3 de 3 · quedan 0 retry · amends 0 de 2");
 // Un estado del binario anterior: sin lifecycle, PR ni amends.
 const { lifecycle: _lifecycle, pullRequest: _pull, publicationFormat: _format, amends: _amends, acceptedRisks: _risks, continuityPause: _pause, ...rest } = amended;
 const v1: unknown = { ...rest, version: 1 };
 assert.ok(Value.Check(WorkflowV1Schema, v1), "vale como estado v1");
 assert.equal(roundBudgetLine(v1), "vuelta 2 de 3 · queda 1 retry · amends 0 de 2");
 assert.equal(roundBudgetLine(parseWorkflow(JSON.stringify(v1))), "vuelta 2 de 3 · queda 1 retry · amends 0 de 2", "migrado a v2, sigue sin amends");
 for (const quiet of [fresh(), send(fresh(), { type: "explored", exploration }), { ...pr(), pullRequest: { number: 9, url: "https://example.test/pull/9", head: "head", branch: "work", base: "main", ownership: "adopted" as const } }]) {
  assert.equal(roundBudget(quiet), undefined, quiet.phase); assert.equal(roundBudgetLine(quiet), "");
  assert.doesNotMatch(developmentInstructions(quiet), /Presupuesto:/, quiet.phase);
 }
});
