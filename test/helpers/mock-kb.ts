// KB de Harness falsa: MCP por HTTP (streamable, sin sesión) con documentos en memoria. Nunca la KB real.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export interface KbDocument { id: string; producto: string; tipo: string; titulo: string; cuerpo: string; autor: string; fecha: string; clave?: string }
export interface MockKb {
	url: string; products: string[]; documents: KbDocument[]; methods: string[]; calls: { tool: string; args: Record<string, unknown> }[];
	unauthorized: boolean;
	/** Antes de responder una tool: "error" la responde con isError; "drop" la procesa y responde un error de transporte. */
	hook: (tool: string, args: Record<string, unknown>) => "error" | "drop" | "invalid" | void;
	perillas: (producto: string, cuerpo: string, autor?: string) => KbDocument;
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const TOOLS = [
	{ name: "mis_productos", inputSchema: schema({}) },
	{ name: "buscar", inputSchema: schema({ producto: { type: "string" }, consulta: { type: "string" }, tipo: { type: "string" }, limite: { type: "integer" } }, ["producto"]) },
	{ name: "leer", inputSchema: schema({ id: { type: "string" } }, ["id"]) },
	{ name: "guardar", inputSchema: schema({ producto: { type: "string" }, tipo: { type: "string" }, titulo: { type: "string" }, cuerpo: { type: "string" }, clave: { type: "string" } }, ["producto", "tipo", "titulo", "cuerpo"]) },
	{ name: "borrar", inputSchema: schema({ id: { type: "string" }, producto: { type: "string" } }, ["id", "producto"]) },
];

export async function mockKb(t: TestContext, options: { products?: string[] } = {}): Promise<MockKb> {
	let clock = Date.parse("2026-11-18T00:00:00Z");
	const next = () => new Date(clock += 1000).toISOString();
	const kb: MockKb = {
		url: "", products: options.products ?? ["omi-code"], documents: [], methods: [], calls: [], unauthorized: false, hook: () => {},
		perillas(producto, cuerpo, autor = "ana@example.test") { const doc = { id: randomUUID(), producto, tipo: "perillas", titulo: `Perillas de ${producto}`, cuerpo, autor, fecha: next() }; kb.documents.push(doc); return doc; },
	};
	const tool = (name: string, args: Record<string, unknown>): unknown => {
		switch (name) {
			case "mis_productos": return { email: "ana@example.test", es_admin: false, productos: kb.products };
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
				if (!kb.products.includes(input.producto)) throw new Error("sin acceso al producto");
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
				const result = tool(name, args);
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
