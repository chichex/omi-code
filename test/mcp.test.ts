import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createMcpServer, type JsonRpcMessage } from "../src/mcp/server.ts";
import { defineTool } from "../src/tools/types.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const eco = defineTool({
	name: "omi_eco",
	label: "Eco",
	description: "Devuelve lo que recibe",
	parameters: Type.Object({ texto: Type.String() }),
	run: async ({ texto }) => ({ text: `eco: ${texto}`, data: { texto } }),
});

const rota = defineTool({
	name: "omi_rota",
	label: "Rota",
	description: "Siempre falla",
	parameters: Type.Object({}),
	run: async () => {
		throw new Error("se rompió");
	},
});

function server(home: string) {
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({ tools: [eco, rota], io: testIo({ homeDir: home }), write: (message) => sent.push(message) });
	return { mcp, sent };
}

test("mcp aísla el stdout del protocolo y no ofrece prompts de terminal a las tools", async (t) => {
	const io = testIo({ homeDir: await tempDir(t), interactive: true });
	const tool = defineTool({
		name: "progress", label: "Progress", description: "progress", parameters: Type.Object({}),
		run: async (_args, runtime) => {
			runtime.io.out("progress for humans");
			assert.equal(runtime.io.interactive, false);
			return { text: "done", data: {} };
		},
	});
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({ tools: [tool], io, write: (message) => sent.push(message) });
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "progress", arguments: {} } });
	assert.equal(io.output(), "");
	assert.match(io.errors(), /progress for humans/);
	assert.deepEqual(sent[0]?.result, { content: [{ type: "text", text: "done" }], structuredContent: {} });
});

test("mcp_initialize declara tools y la versión pedida por el cliente", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
	const result = sent[0]?.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
	assert.equal(result.protocolVersion, "2025-06-18");
	assert.equal(result.serverInfo.name, "omi");
	assert.deepEqual(result.capabilities.tools, {});
});

test("mcp_tools/list expone el catálogo con su esquema", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	const { tools } = sent[0]?.result as { tools: { name: string; inputSchema: { type: string } }[] };
	assert.deepEqual(tools.map((tool) => tool.name), ["omi_eco", "omi_rota"]);
	assert.equal(tools[0]?.inputSchema.type, "object");
});

test("mcp_tools/call ejecuta la tool y devuelve texto y datos", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "omi_eco", arguments: { texto: "hola" } } });
	assert.deepEqual(sent[0]?.result, { content: [{ type: "text", text: "eco: hola" }], structuredContent: { texto: "hola" } });
});

test("mcp_tools/call valida los argumentos contra el esquema", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "omi_eco", arguments: { texto: 1 } } });
	const result = sent[0]?.result as { isError: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /invalid_arguments/);
});

test("mcp_un error de tool se reporta como resultado, no como error de protocolo", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "omi_rota", arguments: {} } });
	const result = sent[0]?.result as { isError: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /se rompió/);
});

test("mcp_método o tool desconocidos devuelven error JSON-RPC", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
	await mcp.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "omi_nada", arguments: {} } });
	assert.equal(sent[0]?.error?.code, -32601);
	assert.equal(sent[1]?.error?.code, -32602);
});

test("mcp_las notificaciones no tienen respuesta", async (t) => {
	const { mcp, sent } = server(await tempDir(t));
	await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
	assert.deepEqual(sent, []);
});
