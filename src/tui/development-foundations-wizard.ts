// El creador de Foundations por preguntas: la oferta, qué comandos corren sin preguntar, una pregunta por
// política y un resumen legible antes de guardar. Sin I/O: recibe lo detectado y quién pregunta; el bloque sale del validador
// de siempre, así que se guarda con el mismo formato que uno escrito a mano.
import { AUTO_WARNINGS, checkBlock, commandProblem, foundationsDiff, MAX_COMMANDS, type FoundationsBlock, type FoundationsMeta, type FoundationsPolicy, type PolicyPoint } from "../harness/foundations.ts";
import { proposeFoundations, type DetectedCommand } from "../harness/foundations-detect.ts";
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "./questions/batch.ts";

/** Muestra una tanda y devuelve lo que respondió la persona. */
export type Ask = (batch: QuestionBatch) => Promise<AskResult>;
export const FOUNDATIONS_OFFER = ["Armar Foundations", "Ahora no", "No ofrecer más para este repo"] as const;
export type OfferDecision = "build" | "later" | "never";
export const SAVE_CHOICES = ["Guardar en la KB", "Cambiar respuestas", "Cancelar"] as const;
export type SaveDecision = "save" | "change" | "cancel";
export const RETRY_CHOICES = ["Reintentar", "Dejar así"] as const;

const POINTS: readonly PolicyPoint[] = ["arranque", "receta", "fuera_de_catalogo", "push_pr"];
const MODES = { ask: "Preguntar (ask)", auto: "Sin preguntar (auto)" } as const;
const POLICY_QUESTIONS: Record<PolicyPoint, { header: string; question: string; ask: string }> = {
	arranque: { header: "Arranque", question: "¿Empezar un trabajo pide tu sí?", ask: "Pide tu sí antes de crear el issue, el worktree y la sesión" },
	receta: { header: "Receta", question: "¿La receta pasa por tu revisión antes de implementar?", ask: "Revisás y aprobás la receta antes de implementar" },
	fuera_de_catalogo: { header: "Fuera catál.", question: "¿Un comando fuera del catálogo pide tu sí?", ask: "Pide tu sí una vez por comando y por trabajo" },
	push_pr: { header: "Push + PR", question: "¿El push de la rama y el PR draft piden tu sí?", ask: "Pide tu sí antes del push de la rama y del PR draft" },
};
const COMMANDS_DETAIL = "Corren sin pedir tu sí, con cualquier etiqueta, y son exactos: «npm test» no autoriza «npm test -- --watch». Para sumar otros, «Escribir otra respuesta», uno por línea.";
const title = (repo: string) => `Foundations · ${repo.toLowerCase()}`;

const lines = (text: string | null): string[] => (text ?? "").split("\n").filter((line) => line.trim());
/** Cada línea con las reglas de los comandos del bloque. */
function linesProblem(text: string): string | undefined {
	for (const [index, line] of text.split("\n").entries()) {
		const problem = line.trim() ? commandProblem(line) : undefined;
		if (problem) return `Línea ${index + 1}: ${problem}`;
	}
	return undefined;
}

function commandsQuestion(detected: readonly DetectedCommand[], previous: readonly string[] | undefined, problem: string, notice: string): Question {
	const offered = new Set(detected.map((entry) => entry.command));
	return {
		id: "comandos", header: "Comandos", question: "¿Qué comandos corren sin preguntar?", detail: [notice, problem && `⚠ ${problem}`, COMMANDS_DETAIL].filter(Boolean).join("\n\n"),
		options: detected.map((entry) => ({ label: entry.command, description: entry.source })), multiSelect: true, recommended: false,
		freeText: { multiline: true, validate: linesProblem },
		...(previous ? { initial: { options: previous.filter((c) => offered.has(c)), text: previous.filter((c) => !offered.has(c)).join("\n") || null } } : {}),
	};
}

function policiesBatch(repo: string, previous: FoundationsPolicy | undefined): QuestionBatch {
	return { title: title(repo), questions: POINTS.map((point): Question => ({
		id: point, header: POLICY_QUESTIONS[point].header, question: POLICY_QUESTIONS[point].question, multiSelect: false, recommended: true, freeText: false,
		options: [{ label: MODES.ask, description: POLICY_QUESTIONS[point].ask }, { label: MODES.auto, description: `⚠ ${AUTO_WARNINGS[point]}` }],
		...(previous ? { initial: { options: [MODES[previous[point]]], text: null } } : {}),
	})) };
}

const answerOf = (result: AskResult & { status: "answered" }, id: string): QuestionAnswer | undefined => result.answers.find((answer) => answer.id === id);

/** La oferta: «Armar» es la recomendada pero nunca se elige sola. Esc es «Ahora no». */
export async function chooseFoundationsOffer(ask: Ask, target: { repo: string; product: string }): Promise<OfferDecision> {
	const result = await ask({ title: title(target.repo), questions: [{
		id: "oferta", header: "Foundations", question: `¿Armar Foundations para ${target.repo.toLowerCase()}?`,
		detail: `Foundations: comandos que corren sin preguntar y qué puntos piden un sí, en las perillas de ${target.product}.`,
		options: [
			{ label: FOUNDATIONS_OFFER[0], description: "Unas preguntas y un resumen; se guarda en la KB sólo con tu sí al final" },
			{ label: FOUNDATIONS_OFFER[1], description: "No se guarda nada; se vuelve a ofrecer en otra sesión" },
			{ label: FOUNDATIONS_OFFER[2], description: "Queda anotado en el registro local de este equipo y no se vuelve a ofrecer; la KB no cambia" },
		],
		multiSelect: false, recommended: true, freeText: false,
	}] });
	const choice = result.status === "answered" ? answerOf(result, "oferta")?.options[0] : undefined;
	return choice === FOUNDATIONS_OFFER[0] ? "build" : choice === FOUNDATIONS_OFFER[2] ? "never" : "later";
}

/** El bloque que armó la persona, o `undefined` si canceló. Con `previous`, vuelve con lo que ya había elegido. `notice` encabeza los comandos. */
export async function composeFoundations(ask: Ask, input: { repo: string; detected: readonly DetectedCommand[]; previous?: FoundationsBlock; notice?: string }): Promise<FoundationsBlock | undefined> {
	let previous = input.previous?.comandos; let problem = ""; let comandos: string[];
	for (;;) {
		const result = await ask({ title: title(input.repo), questions: [commandsQuestion(input.detected, previous, problem, input.notice ?? "")] });
		if (result.status !== "answered") return undefined;
		const answer = answerOf(result, "comandos");
		comandos = [...new Set([...(answer?.options ?? []), ...lines(answer?.text ?? null)])];
		if (comandos.length <= MAX_COMMANDS) break;
		previous = comandos; problem = `Foundations admite hasta ${MAX_COMMANDS} comandos y la lista tiene ${comandos.length}.`;
	}
	const result = await ask(policiesBatch(input.repo, input.previous?.politica));
	if (result.status !== "answered") return undefined;
	const block = proposeFoundations(input.repo, comandos);
	for (const point of POINTS) block.politica[point] = answerOf(result, point)?.options[0] === MODES.auto ? "auto" : "ask";
	const checked = checkBlock(block);
	if ("reason" in checked) throw new Error(`Foundations inválido: ${checked.reason}`);
	return checked.block;
}

/** El resumen en texto, el destino y un sí explícito: nada viene elegido. Cancelar es no guardar. Con `previous`, la diferencia es contra esa revisión. */
export async function confirmFoundationsSave(ask: Ask, block: FoundationsBlock, target: Pick<FoundationsMeta, "product" | "kbUrl"> & { where: string; previous?: FoundationsBlock | undefined }): Promise<SaveDecision> {
	const result = await ask({ title: title(block.repo), questions: [{
		id: "guardar", header: "Guardar", question: "¿Guardar Foundations en la KB?", detail: `${foundationsDiff(target.previous, block, { product: target.product, kbUrl: target.kbUrl })}\n\n${target.where}`,
		options: [
			{ label: SAVE_CHOICES[0], description: "Guarda esta revisión en las perillas y queda aceptada para este repo" },
			{ label: SAVE_CHOICES[1], description: "Volvés a las preguntas con lo que elegiste; todavía no se guarda nada" },
			{ label: SAVE_CHOICES[2], description: "No se guarda nada en la KB" },
		],
		multiSelect: false, recommended: false, freeText: false,
	}] });
	const choice = result.status === "answered" ? answerOf(result, "guardar")?.options[0] : undefined;
	return choice === SAVE_CHOICES[0] ? "save" : choice === SAVE_CHOICES[1] ? "change" : "cancel";
}

/** Tras un guardado a medias: el estado real y un reintento explícito. Esc o «Dejar así» no tocan nada. */
export async function confirmFoundationsRetry(ask: Ask, repo: string, status: string): Promise<boolean> {
	const result = await ask({ title: title(repo), questions: [{
		id: "reintentar", header: "Reintentar", question: "Foundations no quedó vigente. ¿Reintentar?",
		detail: `Sigue valiendo la política anterior en esta sesión.\n\n${status}\n\nReintentar vuelve a leer la KB: si ya tiene tu revisión, la acepta; si tiene otra, te muestra la más reciente para confirmar de nuevo.`,
		options: [
			{ label: RETRY_CHOICES[0], description: "Vuelve a leer la KB y completa lo que faltó" },
			{ label: RETRY_CHOICES[1], description: "No revierte la KB; sigue valiendo la política anterior" },
		],
		multiSelect: false, recommended: false, freeText: false,
	}] });
	return result.status === "answered" && answerOf(result, "reintentar")?.options[0] === RETRY_CHOICES[0];
}
