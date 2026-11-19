// Permiso de comando: detalle navegable en TUI y selector nativo en RPC. No es la tool omi_ask.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { QuestionBatchPrompt } from "./questions/prompt.ts";

export interface CommandDialog { readonly title: string; readonly detail: string; readonly choices: readonly string[] }
/** Reutiliza el renderer de preguntas: decisiones fijas, detalle con PgUp/PgDn y ningún consentimiento preseleccionado. */
export class CommandPermissionPrompt extends QuestionBatchPrompt {
	readonly request: CommandDialog;
	constructor(request: CommandDialog, ui: { tui: TUI; theme: () => Theme; done: (choice: string | undefined) => void }) {
		super({ tui: ui.tui, theme: ui.theme, rows: () => ui.tui.terminal.rows,
			batch: { title: request.title, questions: [{ id: "permission", header: "Comando", question: "¿Autorizar este comando del proyecto?", detail: request.detail,
				options: request.choices.map((label) => ({ label, description: "" })), multiSelect: false, recommended: false, freeText: false }] },
			done: (result) => ui.done(result.status === "answered" ? result.answers[0]?.options[0] : undefined),
		});
		this.request = request;
	}
}

export async function showCommandChoices(ctx: ExtensionContext, title: string, choices: string[], signal: AbortSignal): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select(title, choices, { signal });
	const split = title.indexOf("\n");
	const request: CommandDialog = { title: split < 0 ? title : title.slice(0, split), detail: split < 0 ? "" : title.slice(split + 1), choices };
	let prompt: CommandPermissionPrompt | undefined;
	const cancel = () => prompt?.dispose();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		return await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
			prompt = new CommandPermissionPrompt(request, { tui, theme: () => ctx.ui.theme ?? theme, done });
			if (signal.aborted) prompt.dispose();
			return prompt;
		}, { blocked: { kind: "permission", message: request.title } });
	} finally { signal.removeEventListener("abort", cancel); }
}
