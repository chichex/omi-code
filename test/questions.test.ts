// Preguntas en tanda como AskUserQuestion de Claude Code: render a texto y teclas reales, sin terminal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchProblem, FREE_TEXT_LABEL, RECOMMENDED_TAG, type AskResult, type Question, type QuestionBatch } from "../src/tui/questions/batch.ts";
import { KEYS, mountQuestions, typed } from "./helpers/questions.ts";

const scope: Question = { id: "q1", header: "Alcance", question: "¿Qué alcance tiene el cambio?", multiSelect: false, recommended: true, freeText: { multiline: false },
	options: [{ label: "Sólo el bug", description: "Arregla el cálculo sin tocar otras partes" }, { label: "Bug y refactor", description: "Aprovecha para ordenar el módulo" }] };
const risk: Question = { id: "q2", header: "Riesgo", question: "¿Qué riesgo asumimos?", multiSelect: false, recommended: true, freeText: { multiline: false },
	options: [{ label: "Bajo", description: "Sin migraciones ni contratos" }, { label: "Alto", description: "Toca el contrato público" }, { label: "No sé", description: "Hay que medirlo antes" }] };
const gates: Question = { id: "q3", header: "Gates", question: "¿Qué gates corremos?", multiSelect: true, recommended: false, freeText: { multiline: true },
	options: [{ label: "npm run typecheck", description: "Tipos" }, { label: "npm test", description: "Tests" }, { label: "npm run test:packaging", description: "Empaquetado" }] };
/** La respuesta de la primera pregunta, si la tanda se respondió. */
const firstAnswer = (result: AskResult | undefined) => result?.status === "answered" ? result.answers[0] : undefined;
const one = (question: Question): QuestionBatch => ({ title: "El agente pregunta", questions: [question] });
const pair: QuestionBatch = { title: "El agente pregunta", questions: [scope, risk] };

test("preguntas: una pregunta numera las opciones, marca la recomendada primero, describe cada una y termina en la respuesta libre", () => {
	const q = mountQuestions(one(scope)); const screen = q.screen();
	assert.match(screen, /El agente pregunta/);
	assert.match(screen, /¿Qué alcance tiene el cambio\?/);
	const rows = ["1. Sólo el bug (Recomendada)", "Arregla el cálculo sin tocar otras partes", "2. Bug y refactor", "Aprovecha para ordenar el módulo", `3. ${FREE_TEXT_LABEL}`];
	const positions = rows.map((row) => screen.indexOf(row));
	assert.ok(positions.every((p) => p >= 0), screen);
	assert.deepEqual([...positions].sort((a, b) => a - b), positions, "en ese orden");
	assert.equal(screen.split(RECOMMENDED_TAG).length - 1, 1, "sólo la primera lleva la marca");
	assert.doesNotMatch(screen, /Enviar/, "una sola pregunta no tiene pestañas ni paso final");
	assert.match(screen, /Esc cancelar/);
	assert.doesNotMatch(screen, /✓/, "nada elegido antes de una tecla");
	assert.equal(q.result(), undefined);
});

test("preguntas: ↑/↓ mueven el cursor y Enter elige; un dígito elige directo", () => {
	const q = mountQuestions(one(risk));
	q.press(KEYS.down, KEYS.down, KEYS.up, KEYS.enter);
	assert.deepEqual(q.result(), { status: "answered", answers: [{ id: "q2", question: "¿Qué riesgo asumimos?", options: ["Alto"], text: null }] });
	const digit = mountQuestions(one(risk)); digit.press("3");
	assert.deepEqual(digit.result(), { status: "answered", answers: [{ id: "q2", question: "¿Qué riesgo asumimos?", options: ["No sé"], text: null }] });
	const outside = mountQuestions(one(risk)); outside.press("9", "0");
	assert.equal(outside.result(), undefined, "un número sin opción no responde");
});

test("preguntas: sin recomendada no hay cursor de entrada: Enter solo no elige nada", () => {
	const save: Question = { id: "save", header: "Guardar", question: "¿Guardar en la KB?", multiSelect: false, recommended: false, freeText: false,
		options: [{ label: "Guardar en la KB", description: "Guarda" }, { label: "Cancelar", description: "No guarda nada" }] };
	const q = mountQuestions(one(save));
	assert.doesNotMatch(q.screen(), /›/, "ninguna fila resaltada");
	assert.doesNotMatch(q.screen(), new RegExp(FREE_TEXT_LABEL), "sin respuesta libre cuando la pregunta no la admite");
	q.press(KEYS.enter, KEYS.space);
	assert.equal(q.result(), undefined, "Enter sin elegir no guarda");
	q.press(KEYS.down, KEYS.down, KEYS.enter);
	assert.deepEqual(firstAnswer(q.result())?.options, ["Cancelar"]);
});

test("preguntas: en una tanda, la fila de pestañas muestra cada encabezado y Enviar; Tab/→ y ←/Shift+Tab se mueven", () => {
	const q = mountQuestions(pair);
	const chips = q.screen().split("\n").find((line) => line.includes("Alcance"))!;
	assert.match(chips, /□ Alcance.*□ Riesgo.*Enviar/);
	assert.match(q.screen(), /¿Qué alcance tiene el cambio\?/);
	q.press(KEYS.tab); assert.match(q.screen(), /¿Qué riesgo asumimos\?/);
	q.press(KEYS.right); assert.match(q.screen(), /Revisá las respuestas/);
	q.press(KEYS.left); assert.match(q.screen(), /¿Qué riesgo asumimos\?/);
	q.press(KEYS.shiftTab); assert.match(q.screen(), /¿Qué alcance tiene el cambio\?/);
	assert.equal(q.result(), undefined, "moverse no responde");
});

test("preguntas: Enviar repasa las respuestas antes de enviar; con faltantes, Enter vuelve a la primera sin responder", () => {
	const q = mountQuestions(pair);
	q.press("2");
	assert.match(q.screen(), /¿Qué riesgo asumimos\?/, "responder avanza a la siguiente");
	q.press(KEYS.tab);
	assert.match(q.screen(), /Falta responder: Riesgo/);
	q.press(KEYS.enter);
	assert.equal(q.result(), undefined, "no envía con faltantes");
	assert.match(q.screen(), /¿Qué riesgo asumimos\?/);
	q.press("1");
	const review = q.screen();
	assert.match(review, /Revisá las respuestas/);
	assert.match(review, /Alcance\s+Bug y refactor/); assert.match(review, /Riesgo\s+Bajo/);
	assert.match(review.split("\n").find((line) => line.includes("Alcance"))!, /■ Alcance.*■ Riesgo/);
	assert.equal(q.result(), undefined, "el repaso todavía no envía");
	q.press(KEYS.enter);
	assert.deepEqual(q.result(), { status: "answered", answers: [
		{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: ["Bug y refactor"], text: null },
		{ id: "q2", question: "¿Qué riesgo asumimos?", options: ["Bajo"], text: null },
	] });
});

test("preguntas: la respuesta libre abre un texto en línea y vuelve como escrita, no como opción", () => {
	const q = mountQuestions(pair);
	q.press("3");
	assert.match(q.screen(), /Enter listo · Esc volver/);
	q.press(...typed("Sólo el test que falla"), KEYS.enter);
	assert.match(q.screen(), /¿Qué riesgo asumimos\?/);
	q.press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter, ...typed("Lo decide el equipo"), KEYS.enter);
	assert.match(q.screen(), /Alcance\s+✎ «Sólo el test que falla»/);
	q.press(KEYS.enter);
	assert.deepEqual(q.result(), { status: "answered", answers: [
		{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: [], text: "Sólo el test que falla" },
		{ id: "q2", question: "¿Qué riesgo asumimos?", options: [], text: "Lo decide el equipo" },
	] });
});

test("preguntas: texto vacío no es una respuesta; volver a elegir una opción reemplaza el texto", () => {
	const q = mountQuestions(pair);
	q.press("3", KEYS.enter);
	assert.match(q.screen(), /¿Qué alcance tiene el cambio\?/, "vacío vuelve a las opciones sin responder");
	q.press("3", ...typed("libre"), KEYS.enter, KEYS.shiftTab, "1", KEYS.tab, KEYS.tab, KEYS.tab);
	q.press(KEYS.right);
	assert.doesNotMatch(q.screen(), /«libre»/);
});

test("preguntas: multi-selección con casillas: Espacio y dígitos marcan, Enter confirma y suma el texto libre", () => {
	const q = mountQuestions(one(gates));
	assert.match(q.screen(), /\[ \] npm run typecheck/);
	assert.doesNotMatch(q.screen(), /\[x\]/, "nada marcado de entrada");
	q.press(KEYS.space, KEYS.down, KEYS.down, KEYS.space, "1", "2");
	assert.match(q.screen(), /\[ \] npm run typecheck/); assert.match(q.screen(), /\[x\] npm test/); assert.match(q.screen(), /\[x\] npm run test:packaging/);
	q.press("4");
	assert.match(q.screen(), /Ctrl\+J otra línea/);
	q.press(...typed("npm run lint"), KEYS.newLine, ...typed("npm run e2e"), KEYS.enter);
	assert.match(q.screen(), /\[x\] Escribir otra respuesta/);
	assert.equal(q.result(), undefined, "escribir no confirma: se pueden seguir marcando");
	q.press(KEYS.enter);
	assert.deepEqual(q.result(), { status: "answered", answers: [{ id: "q3", question: "¿Qué gates corremos?", options: ["npm test", "npm run test:packaging"], text: "npm run lint\nnpm run e2e" }] });
});

test("preguntas: multi-selección con sólo la respuesta libre: Espacio la abre y Enter confirma, también sin escribir", () => {
	const only: Question = { ...gates, options: [] };
	const q = mountQuestions(one(only));
	q.press(KEYS.space); assert.match(q.screen(), /Enter listo/);
	q.press(KEYS.enter, KEYS.enter);
	assert.deepEqual(firstAnswer(q.result()), { id: "q3", question: "¿Qué gates corremos?", options: [], text: null });
});

test("preguntas: multi-selección sin marcar nada es una respuesta explícita: ninguna", () => {
	const q = mountQuestions({ title: "t", questions: [gates, scope] });
	q.press(KEYS.enter, "1");
	assert.match(q.screen(), /Gates\s+ninguna/, "responder todo lleva a Enviar");
	q.press(KEYS.enter);
	assert.deepEqual(firstAnswer(q.result()), { id: "q3", question: "¿Qué gates corremos?", options: [], text: null });
});

test("preguntas: Esc cancela sin respuestas parciales; en el texto libre Esc vuelve a las opciones", () => {
	const q = mountQuestions(pair);
	q.press("1", "4", ...typed("a medias"), KEYS.esc);
	assert.match(q.screen(), /¿Qué riesgo asumimos\?/); assert.equal(q.result(), undefined, "el primer Esc sólo deja el texto");
	q.press(KEYS.esc);
	assert.deepEqual(q.results, [{ status: "cancelled" }]);
	q.press(KEYS.enter, "1"); q.prompt.dispose();
	assert.equal(q.results.length, 1, "done una sola vez");
	for (const cancel of [KEYS.ctrlC, KEYS.esc]) {
		const other = mountQuestions(one(scope)); other.press(cancel);
		assert.deepEqual(other.result(), { status: "cancelled" });
	}
	const disposed = mountQuestions(one(scope)); disposed.prompt.dispose();
	assert.deepEqual(disposed.results, [{ status: "cancelled" }]);
});

test("preguntas: el texto libre se valida antes de aceptarlo y vuelve con lo escrito", () => {
	const checked: Question = { ...gates, freeText: { multiline: true, validate: (text) => text.includes("rm") ? "No se aceptan borrados" : undefined } };
	const q = mountQuestions(one(checked));
	q.press("4", ...typed("rm -rf x"), KEYS.enter);
	assert.match(q.screen(), /No se aceptan borrados/);
	assert.match(q.screen(), /rm -rf x/, "sigue en el texto con lo escrito");
	q.press(KEYS.enter); assert.equal(q.result(), undefined);
	for (let i = 0; i < 8; i++) q.press("\x7f");
	q.press(...typed("ls"), KEYS.enter, KEYS.enter);
	assert.deepEqual(firstAnswer(q.result())?.text, "ls");
});

test("preguntas: lo que la persona ya respondió vuelve marcado al cambiar respuestas", () => {
	const again: QuestionBatch = { title: "t", questions: [{ ...gates, initial: { options: ["npm test"], text: "npm run lint" } }, { ...scope, initial: { options: ["Bug y refactor"], text: null } }] };
	const q = mountQuestions(again);
	assert.match(q.screen(), /\[x\] npm test/); assert.match(q.screen(), /\[x\] Escribir otra respuesta/); assert.match(q.screen(), /npm run lint/);
	q.press(KEYS.tab, KEYS.tab);
	assert.match(q.screen(), /Gates\s+npm test · ✎ «npm run lint»/); assert.match(q.screen(), /Alcance\s+Bug y refactor/);
	q.press(KEYS.enter);
	assert.deepEqual(q.result(), { status: "answered", answers: [
		{ id: "q3", question: "¿Qué gates corremos?", options: ["npm test"], text: "npm run lint" },
		{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: ["Bug y refactor"], text: null },
	] });
});

test("preguntas: entra en 80×24 y en anchos chicos; con muchas opciones se desplaza y el cursor queda a la vista", () => {
	const four: QuestionBatch = { title: "El agente pregunta", questions: [scope, risk, gates, { ...risk, id: "q4", header: "Doce letras", question: "¿Cuarta pregunta, bastante más larga que las otras para que tenga que envolverse en más de una línea?" }] };
	for (const [columns, rows] of [[80, 24], [69, 24], [40, 16], [132, 40]] as const) {
		const q = mountQuestions(four, { columns, rows });
		for (const step of [[], [KEYS.tab], [KEYS.tab, KEYS.tab], [KEYS.shiftTab], [KEYS.shiftTab, KEYS.shiftTab]]) {
			q.press(...step);
			assert.ok(q.widths().every((w) => w === columns), `${columns}×${rows}: cada fila ocupa el ancho, sin pasarse`);
			assert.ok(q.lines().length <= rows - 8, `${columns}×${rows}: ${q.lines().length} filas deja lugar al workspace`);
			assert.match(q.screen(), /Esc cancelar/, "la ayuda nunca queda cortada");
		}
	}
	const many: Question = { ...gates, options: Array.from({ length: 30 }, (_, i) => ({ label: `npm run script-${i + 1}`, description: `Script ${i + 1}` })) };
	const q = mountQuestions(one(many));
	assert.ok(q.lines().length <= 16);
	for (let i = 0; i < 24; i++) q.press(KEYS.down);
	q.press(KEYS.space);
	assert.match(q.screen(), /› 25\. \[x\] npm run script-25/);
	assert.match(q.screen(), /↑ \d+ más/);
	assert.ok(q.lines().length <= 16);
	q.press(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down);
	assert.match(q.screen(), new RegExp(`› 31\\. \\[ \\] ${FREE_TEXT_LABEL}`));
});

test("preguntas: el detalle largo se desplaza con PgUp/PgDn sin perder las opciones", () => {
	const detail = Array.from({ length: 40 }, (_, i) => `línea ${i + 1} del resumen`).join("\n");
	const q = mountQuestions(one({ id: "s", header: "Guardar", question: "¿Guardar?", detail, multiSelect: false, recommended: false, freeText: false, options: [{ label: "Guardar en la KB", description: "Guarda" }, { label: "Cancelar", description: "Nada" }] }));
	assert.ok(q.lines().length <= 16);
	assert.match(q.screen(), /línea 1 del resumen/); assert.doesNotMatch(q.screen(), /línea 40 del resumen/);
	assert.match(q.screen(), /Guardar en la KB/); assert.match(q.screen(), /PgDn/);
	assert.equal(q.prompt.capturesViewportInput, true, "PgUp/PgDn mueven el detalle, no el chat");
	for (let i = 0; i < 20; i++) q.press(KEYS.pageDown);
	assert.match(q.screen(), /línea 40 del resumen/); assert.match(q.screen(), /Cancelar/);
	q.press(KEYS.pageUp); assert.doesNotMatch(q.screen(), /línea 40 del resumen/);
	assert.equal(mountQuestions(one(scope)).prompt.capturesViewportInput, false, "sin detalle largo, PgUp/PgDn siguen desplazando el chat");
});

test("preguntas: textos del agente o de un repo no llevan secuencias de terminal ni controles", () => {
	const hostile: Question = { ...scope, question: "¿Seguro?\x1b[2J\x07", options: [{ label: "Sí\x1b]8;;file:///etc/passwd\x07", description: "desc\x1b[31m roja" }, { label: "No", description: "‮atrás" }] };
	const q = mountQuestions(one(hostile));
	const raw = q.lines().join("\n");
	assert.doesNotMatch(raw, /\x1b\[2J|\x1b\]8;;file|\x07|\x1b\[31m roja|‮/);
});

test("preguntas: una tanda inválida se rechaza con el motivo", () => {
	assert.equal(batchProblem(pair), undefined);
	assert.match(batchProblem({ title: "t", questions: [] }) ?? "", /entre 1 y 4/);
	assert.match(batchProblem({ title: "t", questions: [scope, risk, gates, { ...scope, id: "q4" }, { ...scope, id: "q5" }] }) ?? "", /entre 1 y 4/);
	assert.match(batchProblem({ title: "t", questions: [scope, { ...risk, id: "q1" }] }) ?? "", /repet/);
	assert.match(batchProblem(one({ ...scope, header: "Trece letras!" })) ?? "", /12/);
	assert.match(batchProblem(one({ ...scope, header: " " })) ?? "", /12/);
	assert.match(batchProblem(one({ ...scope, options: [scope.options[0]!, scope.options[0]!] })) ?? "", /repet/);
	assert.match(batchProblem(one({ ...scope, options: [scope.options[0]!, { label: FREE_TEXT_LABEL, description: "x" }] })) ?? "", /reservad/);
	assert.match(batchProblem(one({ ...scope, options: [scope.options[0]!], freeText: false })) ?? "", /al menos dos/);
	assert.match(batchProblem(one({ ...scope, initial: { options: ["Otra"], text: null } })) ?? "", /no es una opción/);
	assert.match(batchProblem(one({ ...scope, recommended: true, options: [] })) ?? "", /recomendada/);
});
