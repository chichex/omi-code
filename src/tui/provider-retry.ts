// Fallas transitorias del proveedor: qué vale reintentar y la espera entre intentos. Lo usan los lentes y los subagentes.
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/** Por qué falló un turno del proveedor, por categoría. */
export type ProviderErrorCause = "connection" | "provider" | "quota" | "auth" | "error";

// Cuota, facturación y autenticación no se arreglan esperando. La conexión de Bun ("Unable to connect") y el 529
// no los clasifica Pi; el resto de lo transitorio, sí (isRetryableAssistantError).
const QUOTA = /insufficient_quota|quota|billing|usage.?limit|out of budget|available balance|credit balance/i;
const AUTH = /(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthori[sz]ed|forbidden|authentication|invalid.?(?:api.?key|x-api-key)|no api key|not configured/i;
const CONNECTION = /unable to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|socket hang up|network.?error|connection.?(?:error|refused|lost|reset)/i;
const OVERLOADED = /overloaded|(?<![a-z0-9])529(?![a-z0-9])/i;
export function providerErrorCause(message: AssistantMessage): { cause: ProviderErrorCause; retry: boolean } {
	const text = message.errorMessage ?? "";
	if (QUOTA.test(text)) return { cause: "quota", retry: false };
	if (AUTH.test(text)) return { cause: "auth", retry: false };
	if (CONNECTION.test(text)) return { cause: "connection", retry: true };
	if (OVERLOADED.test(text) || isRetryableAssistantError(message)) return { cause: "provider", retry: true };
	return { cause: "error", retry: false };
}

/** Espera `ms` o hasta que `signal` aborte, lo que pase primero. No rechaza: quien llama mira el signal después. */
export const pauseUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
	if (signal.aborted) { resolve(); return; }
	const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
	const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
});
