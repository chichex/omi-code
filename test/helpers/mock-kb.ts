// KB de Harness falsa: MCP por HTTP (streamable, sin sesión) con documentos en memoria. Nunca la KB real.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { KbUnavailableError, type KbClient } from "../../src/tui/kb-client.ts";

export interface KbDocument { id: string; producto: string; tipo: string; titulo: string; cuerpo: string; autor: string; fecha: string; clave?: string }
export interface KbStore {
	/** Productos a los que la persona tiene acceso (mis_productos). */
	access: string[]; documents: KbDocument[]; calls: { tool: string; args: Record<string, unknown> }[];
	/** Antes de responder una tool: "error" la responde con isError; "drop" la procesa y pierde la respuesta. */
	hook: (tool: string, args: Record<string, unknown>) => "error" | "drop" | "invalid" | void;
	perillas: (producto: string, cuerpo: string, autor?: string) => KbDocument;
	tool: (name: string, args: Record<string, unknown>) => unknown;
}
export interface MockKb extends KbStore { url: string; methods: string[]; unauthorized: boolean }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOLS = [
	{ name: "mis_productos", inputSchema: schema({}) },
	{ name: "buscar", inputSchema: schema({ producto: { type: "string" }, consulta: { type: "string" }, tipo: { type: "string" }, limite: { type: "integer" } }, ["producto"]) },
	{ name: "leer", inputSchema: schema({ id: { type: "string" } }, ["id"]) },
	{ name: "guardar", inputSchema: schema({ producto: { type: "string" }, tipo: { type: "string" }, titulo: { type: "string" }, cuerpo: { type: "string" }, clave: { type: "string" } }, ["producto", "tipo", "titulo", "cuerpo"]) },
	{ name: "borrar", inputSchema: schema({ id: { type: "string" }, producto: { type: "string" } }, ["id", "producto"]) },
];

// Documentos y reglas de la KB (guardar nunca pisa; la clave recupera el original), sin transporte.
export function kbStore(options: { products?: string[] } = {}): KbStore {
	let clock = Date.parse("2026-11-18T00:00:00Z");
	const next = () => new Date(clock += 1000).toISOString();
	const kb: KbStore = {
		access: options.products ?? ["omi-code"], documents: [], calls: [], hook: () => {}, tool: () => undefined,
		perillas(producto, cuerpo, autor = "ana@example.test") { const doc = { id: randomUUID(), producto, tipo: "perillas", titulo: `Perillas de ${producto}`, cuerpo, autor, fecha: next() }; kb.documents.push(doc); return doc; },
	};
	kb.tool = (name: string, args: Record<string, unknown>): unknown => {
		switch (name) {
			case "mis_productos": return { email: "ana@example.test", es_admin: false, productos: kb.access };
			case "buscar": {
				const found = kb.documents.filter((d) => d.producto === args.producto && (args.tipo === undefined || d.tipo === args.tipo)).sort((a, b) => b.fecha.localeCompare(a.fecha));
				return { resultados: found.slice(0, typeof args.limite === "number" ? args.limite : 10).map(({ autor, cuerpo, fecha, id, tipo, titulo }) => ({ autor, extracto: cuerpo.slice(0, 80), fecha, id, tipo, titulo })) };
			}
			case "leer": {
				const doc = kb.documents.find((d) => d.id === args.id);
				if (!doc) throw new Error("no existe");
				const { clave: _clave, ...visible } = doc; return visible;
			}
			case "guardar": {
				const input = { producto: String(args.producto), tipo: String(args.tipo), titulo: String(args.titulo), cuerpo: String(args.cuerpo) };
				if (!kb.access.includes(input.producto)) throw new Error("sin acceso al producto");
				const clave = typeof args.clave === "string" ? args.clave : undefined;
				const previous = clave === undefined ? undefined : kb.documents.find((d) => d.producto === input.producto && d.clave === clave);
				if (previous) {
					if (previous.tipo !== input.tipo || previous.titulo !== input.titulo || previous.cuerpo !== input.cuerpo) throw new Error("conflicto de clave");
					return { id: previous.id, producto_nuevo: false };
				}
				const doc = { id: randomUUID(), ...input, autor: "ana@example.test", fecha: next(), ...(clave ? { clave } : {}) };
				kb.documents.push(doc); return { id: doc.id, producto_nuevo: false };
			}
			case "borrar": kb.documents = kb.documents.filter((d) => d.id !== args.id); return { ok: true };
			default: throw new Error(`tool desconocida: ${name}`);
		}
	};
	return kb;
}

export async function mockKb(t: TestContext, options: { products?: string[] } = {}): Promise<MockKb> {
	const kb = Object.assign(kbStore(options), { url: "", methods: [] as string[], unauthorized: false }) as MockKb;
	const server = createServer((request, response) => {
		let body = ""; request.on("data", (chunk: Buffer) => { body += chunk; });
		request.on("end", () => {
			if (kb.unauthorized) { kb.methods.push("401"); response.writeHead(401, { "www-authenticate": "Bearer realm=\"kb\"" }); response.end(); return; }
			if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
			const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
			kb.methods.push(message.method);
			if (message.id === undefined) { response.writeHead(202); response.end(); return; }
			const reply = (result: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
			if (message.method === "initialize") { reply({ protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-kb", version: "0" } }); return; }
			if (message.method === "tools/list") { reply({ tools: TOOLS }); return; }
			if (message.method !== "tools/call") { reply({}); return; }
			const name = message.params?.name ?? ""; const args = message.params?.arguments ?? {};
			kb.calls.push({ tool: name, args });
			const decision = kb.hook(name, args);
			if (decision === "error") { reply({ content: [{ type: "text", text: "error de la KB" }], isError: true }); return; }
			if (decision === "invalid") { reply({ content: [{ type: "text", text: "no es json" }] }); return; }
			try {
				const result = kb.tool(name, args);
				if (decision === "drop") { response.writeHead(500); response.end(); return; }
				reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
			} catch (error) { reply({ content: [{ type: "text", text: error instanceof Error ? error.message : "error" }], isError: true }); }
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
	kb.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	return kb;
}

/** Doble en memoria de KbClient para los tests del harness: mismas reglas, sin HTTP ni Pi. */
export interface MemoryKb extends KbStore, KbClient { available: true | string }
export function memoryKb(options: { products?: string[] } = {}): MemoryKb {
	const store = kbStore(options);
	const kb = Object.assign(store, { url: "https://kb.example.test/mcp", available: true as true | string }) as MemoryKb;
	const call = async (tool: string, args: Record<string, unknown>) => {
		if (kb.available !== true) throw new KbUnavailableError(kb.available);
		kb.calls.push({ tool, args });
		const decision = kb.hook(tool, args);
		if (decision === "error" || decision === "invalid") throw new KbUnavailableError(`${tool} respondió un error`);
		const result = kb.tool(tool, args);
		if (decision === "drop") throw new KbUnavailableError("se perdió la respuesta");
		return result as Record<string, unknown>;
	};
	kb.ready = async () => kb.available === true ? { ready: true } : { ready: false, reason: kb.available };
	kb.products = async () => (await call("mis_productos", {})).productos as string[];
	kb.read = async (id) => await call("leer", { id }) as never;
	kb.currentPerillas = async (product) => {
		const found = (await call("buscar", { producto: product, tipo: "perillas", consulta: "", limite: 1 })).resultados as { id: string }[];
		return found[0] ? kb.read(found[0].id, AbortSignal.timeout(1000)) : null;
	};
	kb.save = async (input) => await call("guardar", { producto: input.product, tipo: "perillas", titulo: input.titulo, cuerpo: input.cuerpo, clave: input.clave }) as { id: string };
	kb.writeToolNames = () => ["mcp__harness_kb__guardar", "mcp__harness_kb__borrar"];
	return kb;
}
