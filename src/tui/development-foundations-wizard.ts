// El creador de Foundations por preguntas: qué comandos corren sin preguntar, una pregunta por política y un
// resumen legible antes de guardar. Sin I/O: recibe lo detectado y quién pregunta; el bloque sale del validador
// de siempre, así que se guarda con el mismo formato que uno escrito a mano.
import { AUTO_WARNINGS, checkBlock, commandProblem, foundationsDiff, MAX_COMMANDS, type FoundationsBlock, type FoundationsMeta, type FoundationsPolicy, type PolicyPoint } from "../harness/foundations.ts";
import { proposeFoundations, type DetectedCommand } from "../harness/foundations-detect.ts";
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "./questions/batch.ts";

/** Muestra una tanda y devuelve lo que respondió la persona. */
export type Ask = (batch: QuestionBatch) => Promise<AskResult>;
export const SAVE_CHOICES = ["Guardar en la KB", "Cambiar respuestas", "Cancelar"] as const;
export type SaveDecision = "save" | "change" | "cancel";

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

function commandsQuestion(detected: readonly DetectedCommand[], previous: readonly string[] | undefined, problem: string): Question {
	const offered = new Set(detected.map((entry) => entry.command));
	return {
		id: "comandos", header: "Comandos", question: "¿Qué comandos corren sin preguntar?", detail: problem ? `⚠ ${problem}\n\n${COMMANDS_DETAIL}` : COMMANDS_DETAIL,
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

/** El bloque que armó la persona, o `undefined` si canceló. Con `previous`, vuelve con lo que ya había elegido. */
export async function composeFoundations(ask: Ask, input: { repo: string; detected: readonly DetectedCommand[]; previous?: FoundationsBlock }): Promise<FoundationsBlock | undefined> {
	let previous = input.previous?.comandos; let problem = ""; let comandos: string[];
	for (;;) {
		const result = await ask({ title: title(input.repo), questions: [commandsQuestion(input.detected, previous, problem)] });
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

/** El resumen en texto, el destino y un sí explícito: nada viene elegido. Cancelar es no guardar. */
export async function confirmFoundationsSave(ask: Ask, block: FoundationsBlock, target: Pick<FoundationsMeta, "product" | "kbUrl"> & { where: string }): Promise<SaveDecision> {
	const result = await ask({ title: title(block.repo), questions: [{
		id: "guardar", header: "Guardar", question: "¿Guardar Foundations en la KB?", detail: `${foundationsDiff(undefined, block, { product: target.product, kbUrl: target.kbUrl })}\n\n${target.where}`,
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
