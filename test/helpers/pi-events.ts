// Reproduce cómo el runner de Pi combina los resultados de varios handlers de un evento.
// En `tool_call` (ExtensionRunner.emitToolCall) el primer `block` corta la cadena: un handler
// posterior, como el observador de ejecución, nunca puede anular un bloqueo del harness.
type Handler<C> = (event: unknown, ctx: C) => unknown;
const blocks = (value: unknown): boolean => !!value && typeof value === "object" && "block" in value && !!value.block;

export async function emitLikePi<C>(handlers: readonly Handler<C>[], name: string, event: unknown, ctx: C): Promise<unknown> {
	let result: unknown;
	for (const handler of handlers) {
		const value = await handler(event, ctx);
		if (name !== "tool_call") { result = value; continue; }
		if (!value) continue;
		result = value;
		if (blocks(value)) return value;
	}
	return result;
}
