// Preguntas en tanda, como AskUserQuestion de Claude Code: una recomendada, alternativas y respuesta libre.
// El modelo y sus límites, sin Pi ni terminal. Una respuesta es un dato de la persona, no una autorización.

export const FREE_TEXT_LABEL = "Escribir otra respuesta";
export const RECOMMENDED_TAG = "(Recomendada)";
export const MAX_QUESTIONS = 4;
export const MAX_HEADER = 12;

export interface QuestionOption { readonly label: string; readonly description: string }
export interface FreeTextInput {
	/** Varias líneas con Ctrl+J, por ejemplo un comando por línea. */
	readonly multiline: boolean;
	/** Validar lo escrito sin recortar ni plegar saltos de un pegado. */
	readonly verbatim?: boolean;
	/** El motivo por el que el texto no vale; sin motivo, vale. */
	readonly validate?: (text: string) => string | undefined;
}
export interface Question {
	readonly id: string;
	/** Etiqueta de la pestaña, hasta 12 caracteres. */
	readonly header: string;
	readonly question: string;
	/** Texto largo debajo de la pregunta, por ejemplo un resumen. Se desplaza con PgUp/PgDn si no entra. */
	readonly detail?: string;
	readonly options: readonly QuestionOption[];
	readonly multiSelect: boolean;
	/** La primera opción es la recomendada: se marca y recibe el cursor, pero nunca se elige sola. */
	readonly recommended: boolean;
	/** `false` sólo en preguntas internas de respuesta cerrada; las del agente siempre la tienen. */
	readonly freeText: FreeTextInput | false;
	/** Lo que la persona ya había respondido, al volver a una tanda. Nunca una recomendación. */
	readonly initial?: { readonly options: readonly string[]; readonly text: string | null };
}
export interface QuestionBatch { readonly title: string; readonly questions: readonly Question[] }
/** Por pregunta: las opciones elegidas y el texto escrito, por separado. `options: []` con texto es una respuesta libre. */
export interface QuestionAnswer { id: string; question: string; options: string[]; text: string | null }
export type AskResult = { status: "answered"; answers: QuestionAnswer[] } | { status: "cancelled" };

function questionProblem(question: Question): string | undefined {
	const header = question.header.trim();
	if (!header || [...question.header].length > MAX_HEADER) return `el encabezado de «${question.id}» tiene que tener entre 1 y ${MAX_HEADER} caracteres`;
	if (!question.question.trim()) return `la pregunta «${question.id}» está vacía`;
	const labels = question.options.map((option) => option.label);
	if (labels.some((label) => !label.trim())) return `«${question.id}» tiene una opción sin texto`;
	if (new Set(labels).size !== labels.length) return `«${question.id}» tiene opciones repetidas`;
	if (labels.includes(FREE_TEXT_LABEL)) return `«${FREE_TEXT_LABEL}» está reservada: OMI la agrega sola`;
	if (question.recommended && !labels.length) return `«${question.id}» marca una recomendada sin opciones`;
	const rows = labels.length + (question.freeText ? 1 : 0);
	if (rows < (question.multiSelect ? 1 : 2)) return `«${question.id}» necesita al menos dos respuestas posibles`;
	const unknown = question.initial?.options.find((label) => !labels.includes(label));
	if (unknown !== undefined) return `«${unknown}» no es una opción de «${question.id}»`;
	if (question.initial?.text && !question.freeText) return `«${question.id}» no admite respuesta libre`;
	return undefined;
}

/** El motivo por el que la tanda no se puede mostrar, o `undefined`. */
export function batchProblem(batch: QuestionBatch): string | undefined {
	if (batch.questions.length < 1 || batch.questions.length > MAX_QUESTIONS) return `una tanda tiene entre 1 y ${MAX_QUESTIONS} preguntas`;
	const ids = batch.questions.map((question) => question.id);
	if (new Set(ids).size !== ids.length) return "hay preguntas con el id repetido";
	for (const question of batch.questions) { const problem = questionProblem(question); if (problem) return problem; }
	return undefined;
}

/** Una respuesta en una línea: «npm test, npm ci · ✎ «texto»», o «ninguna». */
export function describeAnswer(answer: Pick<QuestionAnswer, "options" | "text">): string {
	const parts = [...(answer.options.length ? [answer.options.join(", ")] : []), ...(answer.text ? [`✎ «${answer.text.replace(/\n/g, " ⏎ ")}»`] : [])];
	return parts.join(" · ") || "ninguna";
}
