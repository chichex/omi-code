// El creador de Foundations por preguntas, con una UI falsa que responde cada tanda. Sin KB ni terminal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_WARNINGS, checkBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { composeFoundations, confirmFoundationsRetry, confirmFoundationsSave, RETRY_CHOICES, SAVE_CHOICES, type Ask } from "../src/tui/development-foundations-wizard.ts";
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "../src/tui/questions/batch.ts";
import { batchProblem } from "../src/tui/questions/batch.ts";

const REPO = "Test/Repo";
const detected = [{ command: "npm ci", source: "Instala las dependencias según package-lock.json" }, { command: "npm test", source: "Script «test» de package.json" }, { command: "npm run typecheck", source: "Script «typecheck» de package.json" }];
const POINTS = ["arranque", "receta", "fuera_de_catalogo", "push_pr"] as const;
type Reply = (batch: QuestionBatch) => AskResult;
/** Responde cada tanda con la función que toca y guarda lo que se mostró. */
function fakeUi(...replies: Reply[]) {
	const batches: QuestionBatch[] = [];
	const ask: Ask = async (batch) => { assert.equal(batchProblem(batch), undefined, "cada tanda es válida"); batches.push(batch); const reply = replies.shift(); return reply ? reply(batch) : { status: "cancelled" }; };
	return { ask, batches };
}
const answered = (answers: QuestionAnswer[]): AskResult => ({ status: "answered", answers });
const reply = (q: Question, options: string[], text: string | null = null): QuestionAnswer => ({ id: q.id, question: q.question, options, text });
const commands = (options: string[], text: string | null = null): Reply => (batch) => answered([reply(batch.questions[0]!, options, text)]);
const policies = (modes: Partial<Record<(typeof POINTS)[number], "ask" | "auto">> = {}): Reply => (batch) =>
	answered(batch.questions.map((q) => reply(q, [q.options[modes[q.id as (typeof POINTS)[number]] === "auto" ? 1 : 0]!.label])));

test("foundations_wizard: los comandos detectados son opciones a marcar, sin marcar, con su origen; la respuesta libre suma otros, uno por línea", async () => {
	const ui = fakeUi(commands(["npm test"], "npm run e2e\n\nmake check"), policies());
	const block = await composeFoundations(ui.ask, { repo: REPO, detected });
	assert.deepEqual(block, { version: 1, repo: "test/repo", comandos: ["npm test", "npm run e2e", "make check"], politica: { ...STRICT_POLICY } });
	const question = ui.batches[0]!.questions[0]!;
	assert.equal(ui.batches[0]!.questions.length, 1);
	assert.match(ui.batches[0]!.title, /Foundations · test\/repo/);
	assert.equal(question.question, "¿Qué comandos corren sin preguntar?");
	assert.equal(question.multiSelect, true); assert.equal(question.recommended, false); assert.equal(question.initial, undefined, "nada marcado de entrada");
	assert.deepEqual(question.options, detected.map((d) => ({ label: d.command, description: d.source })));
	assert.ok(question.freeText && question.freeText.multiline, "la respuesta libre admite un comando por línea");
	assert.match(question.detail ?? "", /exactos/);
});

test("foundations_wizard: el texto libre se valida con las reglas de comandos de Foundations", async () => {
	const ui = fakeUi(); await composeFoundations(ui.ask, { repo: REPO, detected });
	const free = ui.batches[0]!.questions[0]!.freeText; assert.ok(free && free.validate);
	assert.equal(free.validate("npm run e2e\n\nmake check"), undefined, "las líneas vacías no cuentan");
	assert.match(free.validate("npm run e2e\nnpm test ") ?? "", /Línea 2: .*espacios al borde/);
	assert.match(free.validate("ok\nma​ke") ?? "", /Línea 2: .*invisibles/);
	assert.match(free.validate("x".repeat(2001)) ?? "", /Línea 1: .*2000/);
	assert.ok("reason" in checkBlock({ version: 1, repo: "test/repo", comandos: ["npm test "], politica: STRICT_POLICY }), "la misma regla que el bloque");
});

test("foundations_wizard: una pregunta por política, ask recomendada y el aviso de cada auto en su descripción", async () => {
	const ui = fakeUi(commands([]), policies({ fuera_de_catalogo: "auto", push_pr: "auto" }));
	const block = await composeFoundations(ui.ask, { repo: REPO, detected: [] });
	assert.deepEqual(block?.politica, { arranque: "ask", receta: "ask", fuera_de_catalogo: "auto", push_pr: "auto" });
	assert.deepEqual(block?.comandos, []);
	const batch = ui.batches[1]!;
	assert.deepEqual(batch.questions.map((q) => q.id), [...POINTS]);
	for (const q of batch.questions) {
		assert.equal(q.recommended, true); assert.equal(q.multiSelect, false); assert.equal(q.freeText, false, "sólo ask o auto");
		assert.match(q.options[0]!.label, /\(ask\)/); assert.match(q.options[1]!.label, /\(auto\)/);
		assert.ok(q.options[1]!.description.includes(AUTO_WARNINGS[q.id as (typeof POINTS)[number]]), q.id);
		assert.ok([...q.header].length <= 12);
	}
	assert.match(batch.questions.find((q) => q.id === "fuera_de_catalogo")!.options[1]!.description, /shell sin permiso/);
});

test("foundations_wizard: cancelar en cualquier tanda no arma nada", async () => {
	assert.equal(await composeFoundations(fakeUi().ask, { repo: REPO, detected }), undefined);
	const second = fakeUi(commands(["npm test"]));
	assert.equal(await composeFoundations(second.ask, { repo: REPO, detected }), undefined);
	assert.equal(second.batches.length, 2);
});

test("foundations_wizard: cambiar respuestas vuelve con lo que la persona eligió, nunca con una recomendación", async () => {
	const previous: FoundationsBlock = { version: 1, repo: "test/repo", comandos: ["npm test", "make check"], politica: { ...STRICT_POLICY, receta: "auto" } };
	const ui = fakeUi(commands(["npm ci"]), policies());
	const block = await composeFoundations(ui.ask, { repo: REPO, detected, previous });
	assert.deepEqual(ui.batches[0]!.questions[0]!.initial, { options: ["npm test"], text: "make check" });
	assert.deepEqual(ui.batches[1]!.questions.map((q) => q.initial?.options), [["Preguntar (ask)"], ["Sin preguntar (auto)"], ["Preguntar (ask)"], ["Preguntar (ask)"]]);
	assert.deepEqual(block?.comandos, ["npm ci"]);
});

test("foundations_wizard: más comandos de los que admite Foundations vuelve a preguntar con el motivo", async () => {
	const many = Array.from({ length: 101 }, (_, i) => `make t${i}`).join("\n");
	const ui = fakeUi(commands([], many), commands(["npm test"]), policies());
	const block = await composeFoundations(ui.ask, { repo: REPO, detected });
	assert.match(ui.batches[1]!.questions[0]!.detail ?? "", /hasta 100/);
	assert.deepEqual(block?.comandos, ["npm test"]);
	assert.ok(block && "block" in checkBlock(block));
});

test("foundations_wizard: el resumen es legible, sin JSON, sin elegir nada por defecto, y sólo «Guardar en la KB» guarda", async () => {
	const block: FoundationsBlock = { version: 1, repo: "test/repo", comandos: ["npm test"], politica: { ...STRICT_POLICY, fuera_de_catalogo: "auto" } };
	const where = "Se guarda en la KB, producto repo, como una revisión nueva de las perillas.";
	const choose = (label: string | undefined): Reply => (batch) => label === undefined ? { status: "cancelled" } : answered([reply(batch.questions[0]!, [label])]);
	for (const [label, expected] of [[SAVE_CHOICES[0], "save"], [SAVE_CHOICES[1], "change"], [SAVE_CHOICES[2], "cancel"], [undefined, "cancel"]] as const) {
		const ui = fakeUi(choose(label));
		assert.equal(await confirmFoundationsSave(ui.ask, block, { product: "repo", kbUrl: "https://kb.example.test/mcp", where }), expected, String(label));
		const question = ui.batches[0]!.questions[0]!;
		assert.deepEqual(question.options.map((o) => o.label), [...SAVE_CHOICES]);
		assert.equal(question.recommended, false, "un sí sensible no tiene recomendada"); assert.equal(question.freeText, false); assert.equal(question.initial, undefined);
		const detail = question.detail ?? "";
		assert.match(detail, /Comandos que corren sin preguntar:\n.*npm test/); assert.match(detail, /fuera del catálogo: auto\s+⚠ corre cualquier comando/);
		assert.match(detail, /Antes: sin Foundations \(por defecto: todo auto\)/); assert.match(detail, /arranque: auto → ask/, "lo que pasa a preguntar se ve contra el default");
		assert.ok(detail.includes(where)); assert.match(detail, /kb\.example\.test/);
		assert.doesNotMatch(detail, /[{}]|"politica"|"comandos"/, "no es JSON");
	}
});

test("foundations_wizard: al editar, el resumen compara contra lo vigente: lo que sale, lo que entra y cada política cambiada", async () => {
	const previous: FoundationsBlock = { version: 1, repo: "test/repo", comandos: ["npm test", "make check"], politica: { ...STRICT_POLICY, push_pr: "ask" } };
	const next: FoundationsBlock = { ...previous, comandos: ["npm test", "npm ci"], politica: { ...previous.politica, push_pr: "auto" } };
	const ui = fakeUi((batch) => answered([reply(batch.questions[0]!, [SAVE_CHOICES[0]])]));
	assert.equal(await confirmFoundationsSave(ui.ask, next, { product: "repo", kbUrl: "https://kb.example.test/mcp", where: "Destino.", previous }), "save");
	const detail = ui.batches[0]!.questions[0]!.detail ?? "";
	assert.match(detail, /Antes: última revisión aceptada [0-9a-f]{8}/);
	assert.match(detail, /^ {2}- make check$/m); assert.match(detail, /^ {2}\+ npm ci$/m); assert.match(detail, /^ {4}npm test$/m);
	assert.match(detail, /push \+ PR draft: ask → auto/);
});

test("foundations_wizard: un aviso del que llama encabeza la tanda de comandos", async () => {
	const ui = fakeUi();
	await composeFoundations(ui.ask, { repo: REPO, detected, notice: "Foundations: KB · revisión 1234abcd" });
	assert.match(ui.batches[0]!.questions[0]!.detail ?? "", /^Foundations: KB · revisión 1234abcd\n\n/);
});

test("foundations_wizard: reintentar es una pregunta cerrada, sin recomendada, con el estado real; Esc es dejarlo así", async () => {
	for (const [label, expected] of [[RETRY_CHOICES[0], true], [RETRY_CHOICES[1], false], [undefined, false]] as const) {
		const ui = fakeUi((batch) => label === undefined ? { status: "cancelled" } : answered([reply(batch.questions[0]!, [label])]));
		assert.equal(await confirmFoundationsRetry(ui.ask, "test/repo", "Foundations se guardó en la KB, pero no se aceptó."), expected, String(label));
		const question = ui.batches[0]!.questions[0]!;
		assert.deepEqual(question.options.map((o) => o.label), [...RETRY_CHOICES]);
		assert.equal(question.recommended, false); assert.equal(question.freeText, false);
		assert.match(question.detail ?? "", /Sigue valiendo la política anterior/); assert.match(question.detail ?? "", /se guardó en la KB, pero no se aceptó/);
	}
});
