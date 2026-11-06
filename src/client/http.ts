// Cliente HTTP de omi-api. Toda respuesta se valida contra un esquema: la red es una frontera.

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ApiError, OmiError } from "../core/errors.ts";
import { API_PREFIX } from "../protocol/constants.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Plazo de corrida de una mutación en cola más su lease, según omi-api. */
const QUEUED_MUTATION_DEADLINE_MS = 5 * 60_000;

const LOGIN_HINT = "corré `omi login`";
const AUTH_CODES = ["authentication_required", "session_expired"];

const ProblemBody = Type.Object({
	error: Type.Object({ code: Type.String(), message: Type.String(), field: Type.Optional(Type.String()) }),
});

const QueuedReceipt = Type.Object({ mutation_id: Type.String(), state: Type.String() });

const QueuedMutation = Type.Object({
	mutation_id: Type.String(),
	state: Type.String(),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
});

export interface ClientOptions {
	apiUrl: string;
	token?: string;
	fetch?: typeof fetch;
	pollIntervalMs?: number;
}

export interface RequestOptions {
	body?: unknown;
	signal?: AbortSignal;
}

export function decode<S extends TSchema>(schema: S, value: unknown, context: string): Static<S> {
	if (Value.Check(schema, value)) return value;
	throw new OmiError("unexpected_response", `respuesta inesperada de OMI en ${context}`, {
		hint: "puede ser una versión de omi-api incompatible: corré `omi upgrade`",
	});
}

function problemFrom(status: number, payload: unknown, context: string): ApiError {
	if (Value.Check(ProblemBody, payload)) {
		const { code, message, field } = payload.error;
		const hint = AUTH_CODES.includes(code) ? LOGIN_HINT : undefined;
		return new ApiError(code, field === undefined ? message : `${message} (${field})`, status, hint);
	}
	return new ApiError("unexpected_response", `OMI respondió ${status} sin un error reconocible en ${context}`, status);
}

export class OmiClient {
	readonly apiUrl: string;
	readonly #token: string | undefined;
	readonly #fetch: typeof fetch;
	readonly #pollIntervalMs: number;

	constructor(options: ClientOptions) {
		this.apiUrl = options.apiUrl.replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	/** Pide un recurso y valida la respuesta. `path` es relativo a /api/v1. */
	async request<S extends TSchema>(method: string, path: string, schema: S, options: RequestOptions = {}): Promise<Static<S>> {
		const payload = await this.#json(method, path, options);
		return decode(schema, payload, `${method} ${path}`);
	}

	/** Para rutas que responden 204. */
	async requestEmpty(method: string, path: string, options: RequestOptions = {}): Promise<void> {
		await this.#send(method, path, options);
	}

	/**
	 * Para rutas en cola: si el ámbito está ocupado, omi-api responde 202 con un recibo en vez
	 * del resultado, así que se discrimina por `mutation_id` y no por el status.
	 */
	async mutate<S extends TSchema>(
		method: string,
		path: string,
		schema: S,
		options: RequestOptions & { projectPath: string; onQueued?: (state: string) => void },
	): Promise<Static<S>> {
		const idempotencyKey = randomUUID();
		const payload = await this.#json(method, path, { ...options, idempotencyKey });
		if (!Value.Check(QueuedReceipt, payload)) return decode(schema, payload, `${method} ${path}`);
		options.onQueued?.(payload.state);
		const result = await this.#awaitReceipt(payload.mutation_id, options.projectPath, options.signal);
		return decode(schema, result, `${method} ${path}`);
	}

	/** Abre una respuesta en streaming, como el SSE de logs. Los errores previos al stream son JSON. */
	async stream(path: string, signal: AbortSignal): Promise<Response> {
		return this.#send("GET", path, { signal, stream: true });
	}

	async #awaitReceipt(mutationID: string, projectPath: string, signal: AbortSignal | undefined): Promise<unknown> {
		const deadline = Date.now() + QUEUED_MUTATION_DEADLINE_MS;
		const path = `${projectPath}/queued-mutations/${encodeURIComponent(mutationID)}`;
		while (Date.now() < deadline) {
			const receipt = await this.request("GET", path, QueuedMutation, signal === undefined ? {} : { signal });
			if (receipt.state === "exitosa") return receipt.result;
			if (receipt.state === "fallida") {
				throw new ApiError(receipt.error?.code ?? "mutation_failed", receipt.error?.message ?? "la mutación falló", 409);
			}
			await sleep(this.#pollIntervalMs, undefined, signal === undefined ? undefined : { signal });
		}
		throw new OmiError("mutation_timeout", `la mutación ${mutationID} no terminó a tiempo`, {
			hint: "revisá su estado en OMI antes de reintentar",
		});
	}

	async #json(method: string, path: string, options: RequestOptions & { idempotencyKey?: string }): Promise<unknown> {
		const response = await this.#send(method, path, options);
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch {
			throw new OmiError("unexpected_response", `OMI respondió algo que no es JSON en ${method} ${path}`);
		}
	}

	async #send(
		method: string,
		path: string,
		options: RequestOptions & { idempotencyKey?: string; stream?: boolean },
	): Promise<Response> {
		const url = `${this.apiUrl}${API_PREFIX}${path}`;
		const headers: Record<string, string> = {};
		if (this.#token !== undefined) headers.Authorization = `Bearer ${this.#token}`;
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
		// Un stream no tiene plazo: lo corta el caller con su señal.
		const timeout = options.stream === true ? undefined : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
		const signals = [timeout, options.signal].filter((signal) => signal !== undefined);
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method,
				headers,
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
				...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
			});
		} catch (error) {
			if (options.signal?.aborted === true) throw error;
			throw new OmiError("api_unreachable", `no se pudo conectar con ${this.apiUrl}`, {
				hint: "revisá la URL con --api u OMI_API_URL",
				cause: error,
			});
		}
		if (response.ok) return response;
		const text = await response.text();
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = undefined;
		}
		throw problemFrom(response.status, payload, `${method} ${path}`);
	}
}
