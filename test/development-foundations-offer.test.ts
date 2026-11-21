import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseFoundationsOffer, FOUNDATIONS_OFFER, type Ask } from "../src/tui/development-foundations-offer.ts";
import { batchProblem, type AskResult, type QuestionBatch } from "../src/tui/questions/batch.ts";

test("foundations_offer: una oferta cerrada abre el panel sin conceder permisos ni recomendar reglas", async () => {
	const batches: QuestionBatch[] = [];
	const ask: Ask = async (batch) => { batches.push(batch); assert.equal(batchProblem(batch), undefined); return { status: "cancelled" }; };
	assert.equal(await chooseFoundationsOffer(ask, { repo: "test/repo", product: "repo" }), "later");
	assert.equal(batches.length, 1); const question = batches[0]!.questions[0]!;
	assert.equal(question.recommended, true); assert.equal(question.freeText, false); assert.equal(question.initial, undefined);
	assert.deepEqual(question.options.map((option) => option.label), [...FOUNDATIONS_OFFER]);
	assert.match(question.detail ?? "", /requieren confirmación/); assert.doesNotMatch(question.detail ?? "", /catálogo|sin preguntar/);
	assert.match(question.options[0]!.description, /panel vertical/); assert.match(question.options[0]!.description, /sólo Guardar/);
});
for (const [choice, expected] of [[FOUNDATIONS_OFFER[0], "build"], [FOUNDATIONS_OFFER[1], "later"], [FOUNDATIONS_OFFER[2], "never"], ["desconocida", "later"]] as const) test(`foundations_offer: ${choice} devuelve ${expected} sin efectos`, async () => {
	const ask: Ask = async (batch): Promise<AskResult> => ({ status: "answered", answers: [{ id: "oferta", question: batch.questions[0]!.question, options: [choice], text: null }] });
	assert.equal(await chooseFoundationsOffer(ask, { repo: "test/repo", product: "repo" }), expected);
});
