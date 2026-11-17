import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PlanSchema, ExplorationSchema, InferenceSchema, sourceHash, parseWorkflow, WorkflowSchema } from "../src/harness/model.ts";

export const plan = {
	classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true },
	objective: "Rechazar un OTP vencido", approach: "Corregir la comparación con el reloj inyectado",
	scope: ["Validación de OTP"], outOfScope: ["Login social"],
	cases: [{ id: "D1", description: "Un OTP vencido se rechaza", command: "npm test" }],
	lenses: ["reliability"], executor: { mode: "inline", writers: 0 },
};
export const exploration = { references: [{ path: "src/otp.ts", line: 2, detail: "Comparación actual" }], findings: ["Usa un reloj inyectado"], approach: "Comparar con vencimiento", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Problema reproducible" };

test("harness_model valida planes y exploración sin aceptar campos ni clasificaciones inventadas", () => {
	assert.equal(Value.Check(PlanSchema, plan), true);
	assert.equal(Value.Check(ExplorationSchema, exploration), true);
	assert.equal(Value.Check(ExplorationSchema, { ...exploration, fingerprint: "observed-content-digest" }), true);
	for (const invalid of [{ ...plan, extra: true }, { ...plan, classification: { ...plan.classification, size: "medium" } }, { ...plan, cases: [] }, { ...plan, executor: { mode: "subagents", writers: 5 } }]) assert.equal(Value.Check(PlanSchema, invalid), false);
	assert.equal(Value.Check(ExplorationSchema, { ...exploration, references: [{ path: "src/otp.ts", line: 0, detail: "No existe" }] }), false);
});

test("harness_model valida inferencias pendientes, asumidas y contestadas sin confundirlas", () => {
	const inference = { id: "I1", kind: "how", question: "¿Reloj inyectado?", recommended: "Sí", confidence: 95, irreversible: false, references: [] };
	for (const resolution of ["assumed", "answered"]) assert.equal(Value.Check(InferenceSchema, { ...inference, resolution, answer: "Sí" }), true);
	assert.equal(Value.Check(InferenceSchema, { ...inference, resolution: "pending", answer: null }), true);
	assert.equal(Value.Check(InferenceSchema, { ...inference, resolution: "answered", answer: null }), false);
});

test("harness_model el hash del pedido cambia con título o cuerpo y no acepta registros corruptos", () => {
	assert.equal(sourceHash("Título", "cuerpo"), sourceHash("Título", "cuerpo"));
	assert.notEqual(sourceHash("Otro", "cuerpo"), sourceHash("Título", "cuerpo"));
	assert.notEqual(sourceHash("Título", "editado"), sourceHash("Título", "cuerpo"));
	assert.throws(() => parseWorkflow("{}"), /inválido/i);
	assert.throws(() => parseWorkflow("no JSON"), /inválido/i);
	assert.equal(Value.Check(WorkflowSchema, { version: 2 }), false);
});
