// Modelo falso de los lentes: una respuesta por defecto o un guion por llamada, con errores, cortes y cuelgues.
// Nunca red ni cuota. Cada respuesta informa 3 tokens de uso; un cuelgue, ninguno.

/** Un turno del guion. hang: espera el abort de la llamada y responde aborted. deaf: nunca responde, ni ante un abort. */
export type ModelTurn = { stopReason: "stop" | "length" | "error" | "aborted"; text?: string; errorMessage?: string } | "hang" | "deaf";
export interface ModelOptions { signal?: AbortSignal; maxTokens?: number }

const usage = (tokens: number) => ({ input: tokens ? 1 : 0, output: tokens ? 2 : 0, totalTokens: tokens, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const hung = (signal: AbortSignal | undefined) => new Promise((resolve) => {
	const done = () => resolve({ stopReason: "aborted", content: [], usage: usage(0) });
	if (signal?.aborted) done(); else signal?.addEventListener("abort", done, { once: true });
});

/** `calls` recibe el contexto de cada llamada. `control.script` se consume de a un turno; vacío, vale stopReason/reply. */
export function fakeLensModel(calls: unknown[]) {
	const control = { stopReason: "stop", onResult: () => {}, reply: (_input: unknown): string => '{"verdict":"pass","findings":[]}', script: [] as ModelTurn[], options: [] as ModelOptions[] };
	const streamSimple = (_model: unknown, input: unknown, options: ModelOptions = {}) => {
		calls.push(input); control.options.push(options);
		const turn = control.script.shift();
		return { result: async () => {
			if (turn === "deaf") return new Promise<never>(() => {});
			if (turn === "hang") return hung(options.signal);
			control.onResult();
			if (!turn) return { stopReason: control.stopReason, content: [{ type: "text", text: control.reply(input) }], usage: usage(3) };
			const text = turn.text ?? (turn.stopReason === "stop" || turn.stopReason === "length" ? control.reply(input) : undefined);
			return { stopReason: turn.stopReason, content: text === undefined ? [] : [{ type: "text", text }], ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }), usage: usage(3) };
		} };
	};
	return { control, streamSimple };
}
