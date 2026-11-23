// Una parte de un lente: una llamada aislada al modelo con plazo propio y reintento acotado sólo cuando no hubo
// resultado por algo transitorio. Un veredicto válido nunca se re-tira, tampoco un unknown del modelo.
// Reintentar no repite efectos: el lente no tiene tools.
import { retryDelayMs, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { pauseUnlessAborted, providerErrorCause, type ProviderErrorCause } from "./provider-retry.ts";
import { addUsage, emptyUsage } from "./subagent-runner.ts";

/** timeoutMs: plazo de cada intento. baseDelayMs: backoff entre intentos (2 s y 4 s). graceMs: espera tras un abort a un proveedor que no responde. */
export interface LensCallPolicy { timeoutMs: number; baseDelayMs: number; graceMs: number }
export const LENS_CALL_POLICY: LensCallPolicy = { timeoutMs: 5 * 60_000, baseDelayMs: 2000, graceMs: 10_000 };
const ATTEMPTS = 3;

/** Por qué una parte quedó sin resultado. Es lo único que se guarda: el mensaje crudo del proveedor va al issue y al PR si se guarda. */
export type LensMissCause = ProviderErrorCause | "timeout" | "length" | "format";
const CAUSES: Record<LensMissCause, string> = {
	connection: "conexión", provider: "proveedor no disponible", timeout: "tiempo agotado", length: "respuesta cortada por longitud",
	format: "formato inválido", quota: "cuota o facturación del proveedor", auth: "autenticación del proveedor", error: "error del proveedor",
};
export const missingFinding = (cause: LensMissCause, attempts: number): string => `Sin resultado del lente: ${CAUSES[cause]} (${attempts} ${attempts === 1 ? "intento" : "intentos"})`;

export type LensCallOutcome<T> =
	| { kind: "answered"; value: T; attempts: number; usage: Usage }
	| { kind: "missing"; cause: LensMissCause; attempts: number; usage: Usage }
	| { kind: "canceled"; attempts: number; usage: Usage };

/** El clasificador compartido con los subagentes (provider-retry.ts). */
export const lensErrorCause = providerErrorCause;

// Un intento: resultado, cancelación de la persona, transitorio (se reintenta), formato (una sola vez) o definitivo.
type Attempt<T> = { kind: "answered"; value: T } | { kind: "canceled" } | { kind: "transient" | "reformat" | "final"; cause: LensMissCause };
function judge<T>(response: AssistantMessage | undefined, accept: (text: string) => T, signal: AbortSignal, deadline: AbortSignal): Attempt<T> {
	if (response?.stopReason === "stop") {
		try { return { kind: "answered", value: accept(response.content.flatMap((p) => p.type === "text" ? [p.text] : []).join("\n")) }; } catch { return { kind: "reformat", cause: "format" }; }
	}
	if (signal.aborted) return { kind: "canceled" };
	if (deadline.aborted || !response) return { kind: "transient", cause: "timeout" };
	switch (response.stopReason) {
		case "length": return { kind: "reformat", cause: "length" };
		case "error": { const { cause, retry } = lensErrorCause(response); return { kind: retry ? "transient" : "final", cause }; }
		case "aborted": return { kind: "final", cause: "error" };
		case "pending": case "toolUse": case "deferred": return { kind: "reformat", cause: "format" };
		default: { const unexpected: never = response.stopReason; throw new Error(`stopReason sin decidir: ${String(unexpected)}`); }
	}
}

// La respuesta, o undefined si tras un abort el proveedor no contesta dentro de la gracia: un cuelgue no frena la sesión.
function answer(pending: Promise<AssistantMessage>, signal: AbortSignal, graceMs: number): Promise<AssistantMessage | undefined> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const giveUp = () => { timer = setTimeout(() => resolve(undefined), graceMs); };
		const settle = () => { clearTimeout(timer); signal.removeEventListener("abort", giveUp); };
		if (signal.aborted) giveUp(); else signal.addEventListener("abort", giveUp, { once: true });
		pending.then((value) => { settle(); resolve(value); }, (error: unknown) => { settle(); reject(error); });
	});
}

/** Hasta 3 intentos, cada uno con su plazo, y backoff cortado por `signal` (el abort de la persona). Suma el uso de todos. */
export async function callLensPart<T>(produce: (signal: AbortSignal) => Promise<AssistantMessage>, accept: (text: string) => T, signal: AbortSignal, policy: LensCallPolicy): Promise<LensCallOutcome<T>> {
	const usage = emptyUsage(); let reformatted = false;
	for (let attempt = 1; ; attempt++) {
		if (signal.aborted) return { kind: "canceled", attempts: attempt - 1, usage };
		// Un timer con ref, no AbortSignal.timeout: el de Node no mantiene vivo el proceso, y en Node 22 un proveedor
		// colgado sin otro I/O deja el event loop vacío antes del plazo.
		const expiry = new AbortController(), deadline = expiry.signal;
		const timer = setTimeout(() => expiry.abort(new DOMException("Plazo del intento agotado", "TimeoutError")), policy.timeoutMs);
		const bounded = AbortSignal.any([signal, deadline]);
		const response = await answer(produce(bounded), bounded, policy.graceMs).finally(() => clearTimeout(timer));
		if (response) addUsage(usage, response.usage);
		const result = judge(response, accept, signal, deadline);
		if (result.kind === "answered") return { kind: "answered", value: result.value, attempts: attempt, usage };
		if (result.kind === "canceled") return { kind: "canceled", attempts: attempt, usage };
		const again = attempt < ATTEMPTS && (result.kind === "transient" || (result.kind === "reformat" && !reformatted));
		if (!again) return { kind: "missing", cause: result.cause, attempts: attempt, usage };
		if (result.kind === "reformat") reformatted = true;
		await pauseUnlessAborted(retryDelayMs({ baseDelayMs: policy.baseDelayMs }, attempt), signal);
	}
}
