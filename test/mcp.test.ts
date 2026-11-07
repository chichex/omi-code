import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { setTimeout as sleep } from "node:timers/promises";
import { createMcpServer, type JsonRpcMessage, type McpServer } from "../src/mcp/server.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { defineTool } from "../src/tools/types.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

async function waitFor<T>(find: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const found = find();
		if (found !== undefined) return found;
		await sleep(2);
	}
	throw new Error("timeout esperando el mensaje");
}

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

function linkedServer(linked: Linked, options: { stageAuthorized?: boolean; capabilities?: Record<string, unknown> } = {}) {
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({
		tools: CATALOG,
		io: linked.io(),
		write: (message) => sent.push(message),
		...(options.stageAuthorized === undefined ? {} : { stageAuthorized: options.stageAuthorized }),
	});
	return { mcp, sent, capabilities: options.capabilities ?? {} };
}

async function initialize(mcp: McpServer, capabilities: Record<string, unknown>): Promise<void> {
	await mcp.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } });
}

const deployProd = { name: "omi_deploy", arguments: { service: "api", environment: "prod", version: "1.1.0" } };
const envStage = { name: "omi_env_set", arguments: { service: "api", environment: "stage", set: [{ name: "A", value: "b" }] } };

function publishVersion(linked: Linked): void {
	const view = linked.project.services.get("api")?.view;
	if (view !== undefined) view.versions = [{ tag: "1.1.0", prerelease: false }];
}

for (const reason of ["timeout", "close"]) {
	test(`mcp cancela la elicitación pendiente por ${reason}`, async (t) => {
		const sent: JsonRpcMessage[] = [];
		const { enforce } = await import("../src/guardrails/policy.ts");
		const tool = defineTool({ name: "mutate", label: "mutate", description: "mutate", parameters: Type.Object({}), run: async (_params, runtime) => {
			await enforce({ operation: "deploy", environment: "prod", summary: "deploy", diff: "prod" }, runtime.guard);
			throw new Error("no debe aprobarse");
		} });
		const mcp = createMcpServer({ tools: [tool], io: testIo({ homeDir: await tempDir(t) }), write: (message) => sent.push(message), elicitationTimeoutMs: 10 });
		await initialize(mcp, { elicitation: {} });
		const call = mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mutate", arguments: {} } });
		if (reason === "close") mcp.close?.();
		const result = await Promise.race([call.then(() => "completed"), new Promise((resolve) => setTimeout(() => resolve("hung"), 100))]);
		assert.equal(result, "completed");
		assert.equal((sent.at(-1)?.result as { isError?: boolean }).isError, true);
	});
}

test("mcp_sin aprobación rechaza prod con guardrail_confirmation_required", async (t) => {
	const linked = await linkedProject(t);
	publishVersion(linked);
	const { mcp, sent } = linkedServer(linked);
	await initialize(mcp, {});
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: deployProd });
	const result = sent.at(-1)?.result as { isError: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /guardrail_confirmation_required/);
	assert.deepEqual(linked.mutations(), []);
});

test("mcp_no acepta un parámetro de aprobación puesto por el modelo", async (t) => {
	const linked = await linkedProject(t);
	publishVersion(linked);
	const { mcp, sent } = linkedServer(linked);
	await initialize(mcp, {});
	const approved = { name: deployProd.name, arguments: { ...deployProd.arguments, confirm: true, approved: true, yes: true } };
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: approved });
	assert.equal((sent.at(-1)?.result as { isError: boolean }).isError, true);
	assert.deepEqual(linked.mutations(), []);
});

test("mcp_con elicitación aprobada por el usuario ejecuta prod", async (t) => {
	const linked = await linkedProject(t);
	publishVersion(linked);
	const { mcp, sent } = linkedServer(linked);
	await initialize(mcp, { elicitation: {} });
	const call = mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: deployProd });
	const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
	assert.match(String(request.params?.message), /sin versión → 1\.1\.0/);
	await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result: { action: "accept", content: { confirmar: true } } });
	await call;
	assert.equal((sent.at(-1)?.result as { isError?: boolean }).isError, undefined);
	assert.equal(linked.mutations().length, 1);
});

for (const [name, result] of [
	["cancela", { action: "cancel" }],
	["rechaza", { action: "decline" }],
	["acepta sin marcar", { action: "accept", content: { confirmar: false } }],
] as const) {
	test(`mcp_si el usuario ${name} la elicitación no ejecuta`, async (t) => {
		const linked = await linkedProject(t);
		publishVersion(linked);
		const { mcp, sent } = linkedServer(linked);
		await initialize(mcp, { elicitation: {} });
		const call = mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: deployProd });
		const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
		await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result });
		await call;
		assert.equal((sent.at(-1)?.result as { isError: boolean }).isError, true);
		assert.deepEqual(linked.mutations(), []);
	});
}

test("mcp_stage queda bloqueado salvo sesión autorizada con --authorize-stage", async (t) => {
	const blocked = await linkedProject(t);
	const closed = linkedServer(blocked);
	await initialize(closed.mcp, {});
	await closed.mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: envStage });
	assert.equal((closed.sent.at(-1)?.result as { isError: boolean }).isError, true);
	assert.deepEqual(blocked.mutations(), []);

	const open = await linkedProject(t);
	const authorized = linkedServer(open, { stageAuthorized: true });
	await initialize(authorized.mcp, {});
	await authorized.mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: envStage });
	assert.equal(open.mutations().length, 1);
});

test("mcp_una lectura pasa sin autorización", async (t) => {
	const linked = await linkedProject(t);
	const { mcp, sent } = linkedServer(linked);
	await initialize(mcp, {});
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "omi_project_status", arguments: {} } });
	assert.equal((sent.at(-1)?.result as { isError?: boolean }).isError, undefined);
});

test("mcp_un secreto nunca aparece en la respuesta", async (t) => {
	const linked = await linkedProject(t);
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({ tools: CATALOG, io: linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", MI_CLAVE: "ultrasecreto" } }), write: (message) => sent.push(message) });
	await initialize(mcp, { elicitation: {} });
	const call = mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "omi_env_set", arguments: { service: "api", environment: "stage", secrets: [{ name: "API_KEY", fromEnv: "MI_CLAVE" }] } } });
	const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
	await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result: { action: "accept", content: { confirmar: true } } });
	await call;
	assert.equal(linked.workloads.secrets.get("stage/API_KEY"), "ultrasecreto");
	assert.doesNotMatch(JSON.stringify(sent), /ultrasecreto/);
});
