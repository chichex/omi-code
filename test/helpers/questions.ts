// Monta el componente de preguntas sin terminal: renderiza a texto y recibe teclas como las manda la TUI.
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { QuestionBatchPrompt } from "../../src/tui/questions/prompt.ts";
import type { AskResult, QuestionBatch } from "../../src/tui/questions/batch.ts";

export const KEYS = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", esc: "\x1b", space: " ", newLine: "\n", pageDown: "\x1b[6~", pageUp: "\x1b[5~", ctrlC: "\x03" } as const;
/** Cada caracter por separado, como llega al tipear. */
export const typed = (value: string): string[] => [...value];

export function fakeTui(size: { columns: number; rows: number }): TUI {
	return { terminal: size, requestRender() {} } as unknown as TUI;
}
export const darkTheme = (): Theme => getThemeByName("dark")!;

type Factory = (tui: TUI, theme: Theme, keys: unknown, done: (value: unknown) => void) => unknown;
const isPrompt = (value: unknown): value is QuestionBatchPrompt => value instanceof QuestionBatchPrompt;
/**
 * Lo que hace la TUI con `ctx.ui.custom` de una tanda: la monta, la dibuja y le pasa las teclas que
 * devuelve `keys` al ver la pantalla. Sin teclas, o si no alcanzan, cerrarla es cancelar.
 */
export async function answerCustom(factory: Factory, keys: (screen: string) => readonly string[] | undefined, size = { columns: 80, rows: 24 }): Promise<{ value: unknown; screens: string[] }> {
	let value: unknown; let settled = false; const screens: string[] = [];
	const component = await factory(fakeTui(size), darkTheme(), { matches: () => false }, (result) => { if (!settled) { settled = true; value = result; } });
	if (!isPrompt(component)) throw new Error("ctx.ui.custom no recibió una tanda de preguntas");
	const screen = () => component.render(size.columns).map(stripTerminalSequences).join("\n");
	screens.push(screen());
	for (const key of keys(screens[0]!) ?? []) { if (settled) break; component.handleInput(key); screens.push(screen()); }
	component.dispose();
	return { value, screens };
}

export function mountQuestions(batch: QuestionBatch, size: { columns?: number; rows?: number; theme?: "dark" | "light" } = {}) {
	const terminal = { columns: size.columns ?? 80, rows: size.rows ?? 24 };
	const results: AskResult[] = [];
	const theme = getThemeByName(size.theme ?? "dark")!;
	const prompt = new QuestionBatchPrompt({ batch, tui: fakeTui(terminal), theme: () => theme, rows: () => terminal.rows, done: (result) => results.push(result) });
	const lines = () => prompt.render(terminal.columns);
	return {
		prompt, terminal, results,
		lines,
		screen: () => lines().map(stripTerminalSequences).join("\n"),
		widths: () => lines().map(visibleWidth),
		press: (...keys: string[]) => { for (const key of keys) { prompt.handleInput(key); prompt.render(terminal.columns); } },
		result: () => results.at(-1),
	};
}
