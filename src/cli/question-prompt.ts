// Tandas de preguntas en una terminal de la CLI, con el mismo contrato que la TUI (src/tui/questions).
// Enter vacío cancela como Esc: la recomendada nunca se elige sola. Sin modelo: las responde una persona.
import { batchProblem, RECOMMENDED_TAG, type AskResult, type Question, type QuestionAnswer, type QuestionBatch } from "../tui/questions/batch.ts";
import type { Io } from "./io.ts";

const MAX_TRIES = 3;
function show(io: Io, question: Question): void {
	io.out(`\n${question.header} · ${question.question}`);
	if (question.detail) io.out(question.detail);
	question.options.forEach((option, index) => io.out(`  ${index + 1}) ${option.label}${index === 0 && question.recommended ? ` ${RECOMMENDED_TAG}` : ""} · ${option.description}`));
	if (question.freeText) io.out("  o escribí otra respuesta");
}
async function answer(io: Io, question: Question): Promise<QuestionAnswer | null> {
	for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
		const raw = (await io.prompt("> ")).trim();
		if (!raw) return null;
		const index = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
		const option = question.options[index];
		if (option) return { id: question.id, question: question.question, options: [option.label], text: null };
		const problem = question.freeText ? question.freeText.validate?.(raw) : "elegí un número de la lista";
		if (question.freeText && !problem) return { id: question.id, question: question.question, options: [], text: raw };
		io.err(`respuesta inválida: ${problem ?? "elegí un número de la lista"}`);
	}
	return null;
}
/** Adaptador `ask` del wizard compartido para `omi init`. Cancelar no deja respuestas parciales. */
export function promptQuestions(io: Io): (batch: QuestionBatch) => Promise<AskResult> {
	return async (batch) => {
		const problem = batchProblem(batch);
		if (problem) throw new Error(`Preguntas inválidas: ${problem}`);
		io.out(batch.title);
		const answers: QuestionAnswer[] = [];
		for (const question of batch.questions) {
			show(io, question);
			const reply = await answer(io, question);
			if (!reply) return { status: "cancelled" };
			answers.push(reply);
		}
		return { status: "answered", answers };
	};
}
