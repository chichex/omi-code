// La KB de Harness leída por el host, sin el modelo. OMI suministra el código de `builtin:mcp`: el mismo
// createMcpExtension de Pi, envuelto en un Proxy que se queda con las definiciones de `harness-kb/*`.
// Así reusa la conexión, el OAuth, el refresh y los locks de Pi. Cualquier duda cuenta como no disponible.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const KB_SERVER = "harness-kb";
const READ_TOOLS = ["mis_productos", "buscar", "leer"];
const WRITE_TOOLS = ["guardar", "borrar"];
const POLL_MS = 50;
const DocSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), producto: Type.String(), tipo: Type.String(), titulo: Type.String(), cuerpo: Type.String({ maxLength: 400_000 }), autor: Type.Optional(Type.String()), fecha: Type.Optional(Type.String()) });
export type KbDoc = Static<typeof DocSchema>;
const ProductsSchema = Type.Object({ productos: Type.Array(Type.String(), { maxItems: 1000 }) });
const SearchSchema = Type.Object({ resultados: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), tipo: Type.Optional(Type.String()) }), { maxItems: 50 }) });
const SavedSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });
// Lo que deja Pi en structuredContent de una tool MCP: el CallToolResult del servidor (tools.js convertMcpResult).
const EnvelopeSchema = Type.Object({ isError: Type.Optional(Type.Boolean()), content: Type.Optional(Type.Array(Type.Unknown())), structuredContent: Type.Optional(Type.Unknown()) });
const TextPartSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
type TextPart = Static<typeof TextPartSchema>;

export class KbUnavailableError extends Error {
	constructor(reason: string) { super(`KB no disponible: ${reason}`); this.name = "KbUnavailableError"; }
}
export type KbReady = { ready: true } | { ready: false; reason: string };
export interface KbClient {
	readonly url: string;
	/** Espera a que Pi conecte la KB, con tope. No llama tools. */
	ready(cwd: string, signal: AbortSignal): Promise<KbReady>;
	products(signal: AbortSignal): Promise<string[]>;
	/** Las perillas vigentes del producto: la más nueva de tipo perillas, o null. */
	currentPerillas(product: string, signal: AbortSignal): Promise<KbDoc | null>;
	read(id: string, signal: AbortSignal): Promise<KbDoc>;
	save(input: { product: string; titulo: string; cuerpo: string; clave: string }, signal: AbortSignal): Promise<{ id: string }>;
	/** Nombres reales de guardar y borrar en Pi, para bloquearlos al agente. */
	writeToolNames(): string[];
}
export type KbExtension = Extract<InlineExtension, { factory: unknown }>;
export interface KbHost extends KbClient { extension(): KbExtension }
export interface KbClientOptions { url: string; agentDir: string; enabled: boolean; readyTimeoutMs?: number; callTimeoutMs?: number }

// Pi ofrece `harness-kb` de mcp.json antes que el registrado por OMI: un repo podría apuntarlo a otro servidor.
async function redefinition(files: string[]): Promise<string> {
	for (const file of files) {
		let raw: string;
		try { raw = await readFile(file, "utf8"); }
		catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; return `no se pudo leer ${file}`; }
		try {
			const value: unknown = JSON.parse(raw.replace(/^﻿/, ""));
			const servers = value && typeof value === "object" && "mcpServers" in value ? value.mcpServers : undefined;
			if (servers && typeof servers === "object" && Object.keys(servers).some((name) => name.replace(/-/g, "_") === "harness_kb")) return `${KB_SERVER} está redefinido en ${file}`;
		} catch { return `${file} no es JSON válido`; }
	}
	return "";
}

export function createKbClient(options: KbClientOptions): KbHost {
	const readyTimeoutMs = options.readyTimeoutMs ?? 10_000; const callTimeoutMs = options.callTimeoutMs ?? 15_000;
	let generation = 0; let attached = false;
	const captured = new Map<string, ToolDefinition>();
	const usable = (tool: string) => { const definition = captured.get(tool); return definition && definition.exposure !== "hidden" ? definition : undefined; };
	async function call<S extends TSchema>(tool: string, args: Record<string, unknown>, schema: S, signal: AbortSignal): Promise<Static<S>> {
		const definition = usable(tool);
		if (!definition) throw new KbUnavailableError(`${KB_SERVER}/${tool} no está conectada`);
		let result: unknown;
		try {
			// Pi declara un contexto obligatorio, pero el execute de una tool MCP no lo recibe (tools.js
			// createMcpToolDefinition: execute(_toolCallId, params, signal, onUpdate)) y Pi mismo llama así a una
			// definición sin fábrica de contexto (wrapToolDefinition). Se llama sin inventar un contexto: la
			// respuesta es unknown y se valida abajo.
			result = await Reflect.apply(definition.execute, definition, [`omi-foundations-${randomUUID()}`, args, AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]), undefined, undefined]);
		} catch (error) { throw new KbUnavailableError(error instanceof Error ? error.message : "falló la llamada"); }
		const structured = result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : undefined;
		if (!Value.Check(EnvelopeSchema, structured) || structured.isError) throw new KbUnavailableError(`${tool} respondió un error`);
		let value: unknown = structured.structuredContent;
		if (!value || typeof value !== "object") {
			const text = structured.content?.find((part): part is TextPart => Value.Check(TextPartSchema, part));
			try { value = JSON.parse(text?.text ?? ""); } catch { throw new KbUnavailableError(`${tool} no devolvió JSON`); }
		}
		if (!Value.Check(schema, value)) throw new KbUnavailableError(`${tool} devolvió un formato inesperado`);
		return value;
	}
	const read = async (id: string, signal: AbortSignal): Promise<KbDoc> => {
		const doc = await call("leer", { id }, DocSchema, signal);
		if (doc.id !== id) throw new KbUnavailableError("leer devolvió otro documento");
		return doc;
	};
	return {
		url: options.url,
		extension: () => ({ name: "mcp", builtin: true, replaceable: true, async factory(pi: ExtensionAPI) {
			const { createMcpExtension } = await import("@earendil-works/pi-coding-agent");
			const mine = ++generation; captured.clear(); attached = true;
			// Las definiciones de una instancia anterior (antes de /reload o de cambiar de sesión) ya no valen.
			const proxy = new Proxy(pi, { get(target, key) {
				if (key !== "registerTool") return Reflect.get(target, key);
				return (definition: ToolDefinition) => {
					const prefix = `${KB_SERVER}/`;
					if (mine === generation && definition.label?.startsWith(prefix)) captured.set(definition.label.slice(prefix.length), definition);
					return target.registerTool(definition);
				};
			} });
			await createMcpExtension()(proxy);
		} }),
		async ready(cwd, signal) {
			if (!options.enabled) return { ready: false, reason: "sin red (--offline o PI_OFFLINE) o MCP desactivado (--no-mcp)" };
			if (!attached) return { ready: false, reason: "el MCP de OMI no está cargado (-builtin:mcp o --no-extensions)" };
			if (!isAbsolute(options.agentDir)) return { ready: false, reason: "falta el directorio de configuración del agente" };
			const redefined = await redefinition([join(options.agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]);
			if (redefined) return { ready: false, reason: redefined };
			const deadline = Date.now() + readyTimeoutMs;
			while (!READ_TOOLS.every(usable)) {
				if (signal.aborted || Date.now() >= deadline) return { ready: false, reason: "la KB no conectó a tiempo (sin login en /mcp, sin red o lenta)" };
				await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			}
			return { ready: true };
		},
		products: async (signal) => (await call("mis_productos", {}, ProductsSchema, signal)).productos,
		async currentPerillas(product, signal) {
			const found = await call("buscar", { producto: product, tipo: "perillas", consulta: "", limite: 1 }, SearchSchema, signal);
			const first = found.resultados[0];
			if (!first) return null;
			if (first.tipo !== undefined && first.tipo !== "perillas") throw new KbUnavailableError("buscar devolvió otro tipo de documento");
			const doc = await read(first.id, signal);
			if (doc.producto !== product || doc.tipo !== "perillas") throw new KbUnavailableError("las perillas leídas son de otro producto o tipo");
			return doc;
		},
		read,
		save: async (input, signal) => call("guardar", { producto: input.product, tipo: "perillas", titulo: input.titulo, cuerpo: input.cuerpo, clave: input.clave }, SavedSchema, signal),
		writeToolNames() {
			const names = new Set(WRITE_TOOLS.map((tool) => `mcp__${KB_SERVER.replace(/-/g, "_")}__${tool}`));
			for (const tool of WRITE_TOOLS) { const name = captured.get(tool)?.name; if (name) names.add(name); }
			return [...names];
		},
	};
}
