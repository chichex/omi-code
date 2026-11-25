// Mostrar una tanda en la TUI y esperar a la persona. Sin TUI interactiva no hay a quién preguntar.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { batchProblem, type AskResult, type QuestionBatch } from "./batch.ts";
import { QuestionBatchPrompt } from "./prompt.ts";

export const NO_INTERACTIVE_UI = "Preguntar necesita la TUI interactiva de OMI: en modo print, RPC o sin UI no hay a quién preguntar.";
/** RPC tiene UI pero no componentes propios: devolvería sin preguntar. */
export const canAsk = (ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean => ctx.hasUI && ctx.mode === "tui";

/** Las respuestas de la persona, o `cancelled` si cerró la tanda, otra UI la reemplazó o se abortó.
 * `onShow`: la TUI montó la tanda sin abortar. Si no se llamó, la persona no la vio. */
export async function askQuestions(ctx: ExtensionContext, batch: QuestionBatch, options: { signal?: AbortSignal | undefined; onShow?: () => void } = {}): Promise<AskResult> {
	if (!canAsk(ctx)) throw new Error(NO_INTERACTIVE_UI);
	const problem = batchProblem(batch);
	if (problem) throw new Error(`Preguntas inválidas: ${problem}`);
	const { signal } = options;
	if (signal?.aborted) return { status: "cancelled" };
	let prompt: QuestionBatchPrompt | undefined;
	const cancel = () => prompt?.dispose();
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		const result = await ctx.ui.custom<AskResult | undefined>((tui, theme, _keys, done) => {
			prompt = new QuestionBatchPrompt({ batch, tui, theme: () => ctx.ui.theme ?? theme, rows: () => tui.terminal.rows, done });
			if (signal?.aborted) prompt.dispose();
			else options.onShow?.();
			return prompt;
		}, { blocked: { kind: "question", message: batch.title } });
		return result ?? { status: "cancelled" };
	} finally { signal?.removeEventListener("abort", cancel); }
}
