// omi_ask: el agente le hace a la persona una tanda de preguntas y recibe sus respuestas, estructuradas.
// Una respuesta es un dato para decidir: no es un acuerdo del chat ni reemplaza una confirmación de OMI.
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { ASK_TOOL } from "../../harness/permissions.ts";
import { askQuestions } from "./ask.ts";
import { MAX_HEADER, MAX_QUESTIONS, type QuestionBatch } from "./batch.ts";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 80, description: "Texto corto de la opción, de 1 a 5 palabras" }),
	description: Type.String({ minLength: 1, maxLength: 300, description: "Qué implica elegirla; se muestra debajo, más tenue" }),
}, { additionalProperties: false });
const QuestionSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 500, description: "La pregunta completa y clara, terminada en signo de pregunta" }),
	header: Type.String({ minLength: 1, maxLength: MAX_HEADER, description: `Etiqueta de la pestaña, hasta ${MAX_HEADER} caracteres. Ejemplo: «Alcance»` }),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4, description: "De 2 a 4 opciones; la primera es la recomendada. No agregues «Escribir otra respuesta»: OMI la suma sola" }),
	multiSelect: Type.Boolean({ description: "true si se puede elegir más de una opción" }),
}, { additionalProperties: false });
const AskSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS, description: `De 1 a ${MAX_QUESTIONS} preguntas que se responden en una sola tanda` }),
}, { additionalProperties: false });

// Lo que se ve distinto de lo que es: controles, secuencias de terminal y formato invisible.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Encabezados y etiquetas en una línea; la pregunta y las descripciones admiten saltos. */
const plain = (value: string, lines: boolean) => !HIDDEN.test(lines ? value.replace(/\n/g, " ") : value);
const NOT_AUTHORIZATION = "Son datos para decidir, no una autorización: no valen como acuerdo del chat ni reemplazan las confirmaciones de OMI.";

function batchOf(input: Static<typeof AskSchema>): QuestionBatch {
	const clean = input.questions.every((q) => plain(q.header, false) && plain(q.question, true) && q.options.every((o) => plain(o.label, false) && plain(o.description, true)));
	if (!clean) throw new Error("omi_ask: una pregunta tiene caracteres de control o invisibles; escribila en texto plano.");
	return { title: "El agente pregunta", questions: input.questions.map((q, i) => ({
		id: `q${i + 1}`, header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect, recommended: true, freeText: { multiline: true },
	})) };
}

export function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ASK_TOOL, label: "Preguntar a la persona", parameters: AskSchema,
		// Interactiva: la ve el modelo, pero ni codemode ni un subagente en segundo plano la pueden llamar.
		exposure: "model-only", executionMode: "sequential",
		description: `Le hace a la persona de 1 a ${MAX_QUESTIONS} preguntas en una sola tanda, en la TUI de OMI, y devuelve sus respuestas: por pregunta, su id (q1…), el texto, las opciones elegidas (options) y lo que escribió con sus palabras (text). La primera opción de cada pregunta es la recomendada y nunca se elige sola. OMI agrega siempre «Escribir otra respuesta». Esc cancela sin respuestas. Sin TUI interactiva (print, RPC, sin UI) falla. Una respuesta no autoriza comandos, push, merge, deploy ni cambios de alcance.`,
		promptSnippet: "Preguntarle a la persona una tanda de 1–4 decisiones con una recomendada, alternativas y respuesta libre",
		promptGuidelines: [
			"Cuando necesites una decisión de la persona y haya alternativas razonables, usá omi_ask en lugar de preguntar en texto: hasta 4 preguntas por tanda, de 2 a 4 opciones cada una, con la recomendada primero y una descripción que diga qué implica cada opción. OMI agrega «Escribir otra respuesta».",
			"Una respuesta de omi_ask no autoriza nada: no la uses para pedir permiso de una acción sensible (push, merge, deploy, borrar datos, secretos) ni para reemplazar una confirmación de OMI, y no vale como acuerdo del chat.",
			"Si la persona cancela o escribe otra cosa, respetalo: nunca supongas la recomendada.",
		],
		async execute(_id, input, signal, _update, ctx) {
			const result = await askQuestions(ctx, batchOf(input), { signal });
			if (result.status === "cancelled") return { content: [{ type: "text", text: "La persona canceló las preguntas: no hay respuestas ni consentimiento. No supongas la recomendada; seguí en el chat." }], details: result, terminate: true };
			return { content: [{ type: "text", text: `La persona respondió con omi_ask. ${NOT_AUTHORIZATION} options son las opciones que eligió; text, lo que escribió con sus palabras (null si no escribió).\n${JSON.stringify(result.answers)}` }], details: result };
		},
	});
}

export function questionsExtension(): Exclude<InlineExtension, ExtensionFactory> {
	return { name: "omi-questions", factory: (pi: ExtensionAPI) => registerAskTool(pi) };
}
