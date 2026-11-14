import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createMcpServer, type JsonRpcMessage } from "../src/mcp/server.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

const PASSWORD = "push-clave-de-un-solo-uso";
const createRegistry = { name: "omi_registry_manage", arguments: { action: "create", hostId: "hst_cp" } };
const publishStage = { name: "omi_visibility_set", arguments: { environment: "stage", visibility: "publico" } };

async function waitFor<T>(find: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const found = find();
		if (found !== undefined) return found;
		await sleep(2);
	}
	throw new Error("timeout esperando el mensaje");
}

/** Sesión con stage autorizado: lo máximo que un agente tiene sin un humano. */
async function authorizedServer(linked: Linked, capabilities: Record<string, unknown>) {
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({ tools: CATALOG, io: linked.io(), stageAuthorized: true, write: (message) => sent.push(message) });
	await mcp.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } });
	return { mcp, sent };
}

async function callApproving(linked: Linked, params: { name: string; arguments: Record<string, unknown> }) {
	const { mcp, sent } = await authorizedServer(linked, { elicitation: {} });
	const call = mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params });
	const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
	await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result: { action: "accept", content: { confirmar: true } } });
	await call;
	return { sent, question: String(request.params?.message) };
}

test("mcp_tools/list ofrece el registry y la visibilidad con sus valores válidos", async (t) => {
	const { mcp, sent } = await authorizedServer(await linkedProject(t), {});
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const { tools } = sent.at(-1)?.result as { tools: { name: string; inputSchema: unknown }[] };
	const schemaOf = (name: string): string => JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema);
	for (const action of ["status", "hosts", "create", "retry_route"]) assert.ok(schemaOf("omi_registry_manage").includes(`"${action}"`), action);
	for (const value of ["privado", "organizacion", "publico"]) assert.ok(schemaOf("omi_visibility_set").includes(`"${value}"`), value);
});

for (const params of [createRegistry, publishStage]) {
	test(`mcp_${params.name} queda bloqueado sin elicitación aunque stage esté autorizado`, async (t) => {
		const linked = await linkedProject(t);
		const { mcp, sent } = await authorizedServer(linked, {});
		await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params });
		const result = sent.at(-1)?.result as { isError: boolean; content: { text: string }[] };
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /guardrail_confirmation_required/);
		assert.deepEqual(linked.mutations(), []);
	});
}

test("mcp_crear el registry con la elicitación aprobada no devuelve la credencial", async (t) => {
	const linked = await linkedProject(t);
	const { sent, question } = await callApproving(linked, createRegistry);
	assert.match(question, /Crear el registry de acme/);
	assert.match(question, /hst_cp/);
	assert.equal((sent.at(-1)?.result as { isError?: boolean }).isError, undefined);
	assert.equal(linked.mutations().length, 1);
	assert.doesNotMatch(JSON.stringify(sent), new RegExp(PASSWORD));
});

test("mcp_hacer público un ambiente muestra la exposición en la elicitación", async (t) => {
	const linked = await linkedProject(t);
	const { sent, question } = await callApproving(linked, publishStage);
	assert.match(question, /stage: privado → publico/);
	assert.match(question, /en internet/);
	assert.equal((sent.at(-1)?.result as { structuredContent?: { visibility: string } }).structuredContent?.visibility, "publico");
});

test("mcp_una visibilidad fuera de la lista se rechaza como argumento inválido", async (t) => {
	const linked = await linkedProject(t);
	const { mcp, sent } = await authorizedServer(linked, { elicitation: {} });
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "omi_visibility_set", arguments: { environment: "stage", visibility: "interno" } } });
	const result = sent.at(-1)?.result as { isError: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /invalid_arguments/);
	assert.deepEqual(linked.omi.requests, []);
});
