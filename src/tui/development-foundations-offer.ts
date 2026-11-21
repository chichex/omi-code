// Una oferta cerrada antes de abrir el panel. No edita reglas, políticas ni datos.
import type { AskResult, QuestionBatch } from "./questions/batch.ts";
export type Ask = (batch: QuestionBatch) => Promise<AskResult>;
export const FOUNDATIONS_OFFER = ["Armar Foundations", "Ahora no", "No ofrecer más para este repo"] as const;
export async function chooseFoundationsOffer(ask: Ask, target: { repo: string; product: string }): Promise<"build" | "later" | "never"> {
	const result = await ask({ title: `Foundations · ${target.repo}`, questions: [{
		id: "oferta", header: "Foundations", question: `¿Armar Foundations para ${target.repo}?`,
		detail: `Reglas que requieren confirmación humana y políticas del harness, en las perillas de ${target.product}. El panel no guarda nada al abrir.`,
		options: [
			{ label: FOUNDATIONS_OFFER[0], description: "Abre un panel vertical; sólo Guardar explícitamente escribe en la KB y acepta v2" },
			{ label: FOUNDATIONS_OFFER[1], description: "No se guarda nada; se vuelve a ofrecer en otra sesión" },
			{ label: FOUNDATIONS_OFFER[2], description: "Guarda sólo el descarte local de la oferta; la KB no cambia" },
		], multiSelect: false, recommended: true, freeText: false,
	}] });
	const choice = result.status === "answered" ? result.answers.find((answer) => answer.id === "oferta")?.options[0] : undefined;
	return choice === FOUNDATIONS_OFFER[0] ? "build" : choice === FOUNDATIONS_OFFER[2] ? "never" : "later";
}
