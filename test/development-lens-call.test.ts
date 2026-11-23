// Una parte de un lente: plazo propio, reintento acotado sólo ante lo transitorio y causa por categoría.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { callLensPart, LENS_CALL_POLICY, lensErrorCause, missingFinding, type LensCallPolicy } from "../src/tui/development-lens-call.ts";

const FAST: LensCallPolicy = { timeoutMs: 1000, baseDelayMs: 1, graceMs: 20 };
const usage = (tokens: number) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function message(stopReason: StopReason, text?: string, errorMessage?: string): AssistantMessage {
	return { role: "assistant", content: text === undefined ? [] : [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "m", usage: usage(3), stopReason, timestamp: 0, ...(errorMessage === undefined ? {} : { errorMessage }) };
}
const PASS = '{"verdict":"pass"}';
const accept = (text: string): string => { if (text !== PASS && text !== '{"verdict":"unknown"}') throw new Error("formato"); return text; };
// Un proveedor con guion: cada llamada toma la próxima respuesta; "hang" espera el abort de su llamada.
function provider(script: (AssistantMessage | "hang" | "deaf")[]) {
	const signals: AbortSignal[] = [];
	const produce = (signal: AbortSignal): Promise<AssistantMessage> => {
		signals.push(signal); const turn = script.shift();
		if (!turn) throw new Error("llamada de más");
		if (turn === "deaf") return new Promise<never>(() => {});
		if (turn !== "hang") return Promise.resolve(turn);
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...message("aborted"), usage: usage(0) }), { once: true }));
	};
	return { produce, calls: () => signals.length };
}
const run = (script: (AssistantMessage | "hang" | "deaf")[], signal = new AbortController().signal, policy = FAST) => {
	const p = provider(script); return callLensPart(p.produce, accept, signal, policy).then((outcome) => ({ outcome, calls: p.calls() }));
};

test("development_lens_call clasifica el error del proveedor: lo transitorio se reintenta; cuota, facturación y autenticación nunca", () => {
	const cause = (errorMessage: string) => lensErrorCause(message("error", undefined, errorMessage));
	assert.deepEqual(cause("Unable to connect. Is the computer able to access the url?"), { cause: "connection", retry: true }, "el error de conexión de Bun, que Pi no clasifica");
	assert.deepEqual(cause("OAuth refresh failed for openai: Unable to connect"), { cause: "connection", retry: true });
	for (const text of ["read ECONNRESET", "connect ECONNREFUSED 127.0.0.1:443", "fetch failed"]) assert.deepEqual(cause(text), { cause: "connection", retry: true }, text);
	for (const text of ["Our servers are currently overloaded", "529 Overloaded", "HTTP 529", "503 Service Unavailable", "429 Too Many Requests: rate limit"]) assert.deepEqual(cause(text), { cause: "provider", retry: true }, text);
	for (const text of ["429 insufficient_quota: You exceeded your current quota", "Your credit balance is too low; check billing", "Monthly usage limit reached"]) assert.deepEqual(cause(text), { cause: "quota", retry: false }, text);
	for (const text of ["401 Unauthorized", "authentication_error: invalid x-api-key", "403 Forbidden", "Provider is not configured: openai", 'No API key found for "openai"']) assert.deepEqual(cause(text), { cause: "auth", retry: false }, text);
	assert.deepEqual(cause("400 invalid_request_error: messages: text content blocks must be non-empty"), { cause: "error", retry: false }, "un error determinista del pedido");
	assert.deepEqual(lensErrorCause(message("error")), { cause: "error", retry: false }, "sin mensaje no hay evidencia de transitorio");
});

test("development_lens_call un transitorio y después un resultado: vale el resultado y se suma el uso de los dos intentos", async () => {
	const { outcome, calls } = await run([message("error", undefined, "Unable to connect"), message("stop", PASS)]);
	assert.equal(calls, 2);
	assert.equal(outcome.kind, "answered"); assert.equal(outcome.kind === "answered" && outcome.value, PASS);
	assert.equal(outcome.attempts, 2); assert.equal(outcome.usage.totalTokens, 6);
});

test("development_lens_call tres transitorios agotan los intentos con backoff de 2 s y 4 s", async () => {
	assert.deepEqual({ timeoutMs: LENS_CALL_POLICY.timeoutMs, baseDelayMs: LENS_CALL_POLICY.baseDelayMs }, { timeoutMs: 5 * 60_000, baseDelayMs: 2000 }, "5 min por intento; 2 s y 4 s entre intentos");
	const { outcome, calls } = await run(Array.from({ length: 3 }, () => message("error", undefined, "overloaded")));
	assert.equal(calls, 3); assert.deepEqual({ kind: outcome.kind, attempts: outcome.attempts, tokens: outcome.usage.totalTokens }, { kind: "missing", attempts: 3, tokens: 9 });
	assert.equal(outcome.kind === "missing" && outcome.cause, "provider");
	// Backoff real (2 s y 4 s): el segundo intento no sale antes de 2 s.
	const started = Date.now(); const real = provider([message("error", undefined, "Unable to connect"), message("stop", PASS)]);
	const slow = await callLensPart(real.produce, accept, new AbortController().signal, { timeoutMs: 1000, baseDelayMs: 2000, graceMs: 20 });
	assert.equal(slow.kind, "answered"); assert.ok(Date.now() - started >= 1990, `${Date.now() - started} ms`);
});

test("development_lens_call nunca reintenta un veredicto válido, ni un unknown del modelo, ni cuota o autenticación", async () => {
	const judged = await run([message("stop", '{"verdict":"unknown"}')]);
	assert.equal(judged.calls, 1); assert.equal(judged.outcome.kind, "answered");
	for (const [text, cause] of [["429 insufficient_quota", "quota"], ["401 Unauthorized", "auth"]] as const) {
		const { outcome, calls } = await run([message("error", undefined, text)]);
		assert.equal(calls, 1, text); assert.deepEqual(outcome.kind === "missing" && [outcome.cause, outcome.attempts], [cause, 1]);
	}
});

test("development_lens_call un corte por longitud o un JSON inválido se reintenta una sola vez", async () => {
	const fixed = await run([message("length", '{"verdict":'), message("stop", PASS)]);
	assert.equal(fixed.calls, 2); assert.equal(fixed.outcome.kind, "answered");
	const twice = await run([message("stop", "no es JSON"), message("length", '{"verdict":'), message("stop", PASS)]);
	assert.equal(twice.calls, 2, "el segundo problema de formato no se reintenta");
	assert.deepEqual(twice.outcome.kind === "missing" && [twice.outcome.cause, twice.outcome.attempts], ["length", 2]);
	const mixed = await run([message("error", undefined, "Unable to connect"), message("stop", "no es JSON"), message("stop", PASS)]);
	assert.equal(mixed.calls, 3, "un transitorio no gasta el reintento de formato"); assert.equal(mixed.outcome.kind, "answered");
});

test("development_lens_call cada intento tiene su plazo: un cuelgue se corta y se reintenta, aunque el proveedor ignore el abort", async () => {
	const policy = { timeoutMs: 30, baseDelayMs: 1, graceMs: 20 };
	const hung = await run(["hang", message("stop", PASS)], undefined, policy);
	assert.equal(hung.calls, 2); assert.equal(hung.outcome.kind, "answered"); assert.equal(hung.outcome.usage.totalTokens, 3);
	const deaf = await run(["deaf", message("stop", PASS)], undefined, policy);
	assert.equal(deaf.calls, 2, "pasada la gracia, se deja de esperar al que no responde"); assert.equal(deaf.outcome.kind, "answered");
	const exhausted = await run(["hang", "deaf", "hang"], undefined, policy);
	assert.deepEqual(exhausted.outcome.kind === "missing" && [exhausted.outcome.cause, exhausted.outcome.attempts], ["timeout", 3]);
});

test("development_lens_call un abort de la persona no reintenta: ni durante la llamada ni durante el backoff", async () => {
	const during = new AbortController();
	const p = provider(["hang", message("stop", PASS)]); setTimeout(() => during.abort(), 10);
	const canceled = await callLensPart(p.produce, accept, during.signal, { timeoutMs: 60_000, baseDelayMs: 1, graceMs: 20 });
	assert.equal(p.calls(), 1); assert.equal(canceled.kind, "canceled");
	const backoff = new AbortController(); const started = Date.now();
	const q = provider([message("error", undefined, "Unable to connect"), message("stop", PASS)]); setTimeout(() => backoff.abort(), 20);
	const stopped = await callLensPart(q.produce, accept, backoff.signal, { timeoutMs: 60_000, baseDelayMs: 60_000, graceMs: 20 });
	assert.equal(q.calls(), 1); assert.equal(stopped.kind, "canceled"); assert.equal(stopped.usage.totalTokens, 3, "conserva el uso consumido");
	assert.ok(Date.now() - started < 5000, "el backoff se corta con el abort");
	const before = new AbortController(); before.abort();
	const r = provider([message("stop", PASS)]);
	assert.equal((await callLensPart(r.produce, accept, before.signal, FAST)).kind, "canceled"); assert.equal(r.calls(), 0, "ya cancelado, no llama al proveedor");
});

test("development_lens_call la causa visible es una categoría, nunca el mensaje crudo del proveedor", () => {
	assert.equal(missingFinding("connection", 3), "Sin resultado del lente: conexión (3 intentos)");
	assert.equal(missingFinding("quota", 1), "Sin resultado del lente: cuota o facturación del proveedor (1 intento)");
	for (const cause of ["connection", "provider", "timeout", "length", "format", "quota", "auth", "error"] as const) assert.match(missingFinding(cause, 2), /^Sin resultado del lente: [^()]+ \(2 intentos\)$/);
});
