// MCP: consultar es libre; ejecutar sólo sale por una elicitación que responde el usuario del cliente.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createMcpServer, type JsonRpcMessage } from "../src/mcp/server.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

const SQL = "DELETE FROM pruebas WHERE id = 7";

async function waitFor<T>(find: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const found = find();
		if (found !== undefined) return found;
		await sleep(2);
	}
	throw new Error("timeout esperando el mensaje");
}

/** Sesión con stage autorizado: lo máximo que un agente tiene sin un humano. */
async function server(linked: Linked, capabilities: Record<string, unknown>) {
	for (const environment of ["stage", "prod"]) {
		linked.workloads.resources.set(`res_${environment}`, { id: `res_${environment}`, environment, slug: "ventas", mode: "local", variable: "POSTGRES_URL_VENTAS", state: "lista" });
	}
	const sent: JsonRpcMessage[] = [];
	const mcp = createMcpServer({ tools: CATALOG, io: linked.io(), stageAuthorized: true, write: (message) => sent.push(message) });
	await mcp.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } });
	return { mcp, sent };
}

function call(name: string, environment: string, sql: string, extra: Record<string, unknown> = {}) {
	return { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: { environment, slug: "ventas", sql, ...extra } } };
}

test("mcp_tools/list ofrece consultar y ejecutar SQL y dice cuál pide un humano", async (t) => {
	const { mcp, sent } = await server(await linkedProject(t), {});
	await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const { tools } = sent.at(-1)?.result as { tools: { name: string; description: string; inputSchema: { required?: string[] } }[] };
	const query = tools.find((tool) => tool.name === "omi_postgres_query");
	const exec = tools.find((tool) => tool.name === "omi_postgres_exec");
	assert.match(query?.description ?? "", /sólo lectura.*sin confirmación/);
	assert.match(exec?.description ?? "", /Siempre pide confirmación humana/);
	assert.deepEqual(query?.inputSchema.required, ["sql"]);
	assert.deepEqual(exec?.inputSchema.required, ["sql"]);
});

for (const environment of ["stage", "prod"]) {
	test(`mcp_omi_postgres_query lee ${environment} sin elicitación`, async (t) => {
		const linked = await linkedProject(t);
		const { mcp, sent } = await server(linked, {});
		await mcp.handle(call("omi_postgres_query", environment, "SELECT id, email FROM usuarios"));
		const result = sent.at(-1)?.result as { isError?: boolean; content: { text: string }[]; structuredContent: { row_count: number; truncated: boolean } };
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.structuredContent.row_count, 2);
		assert.equal(result.structuredContent.truncated, false);
		assert.match(result.content[0]?.text ?? "", /ada@omi\.test/);
		assert.equal(sent.some((message) => message.method === "elicitation/create"), false);
		assert.deepEqual(linked.sql.calls.map((entry) => [entry.action, entry.resourceID]), [["query", `res_${environment}`]]);
	});

	test(`mcp_omi_postgres_exec queda bloqueado en ${environment} sin elicitación, aunque el modelo se apruebe`, async (t) => {
		const linked = await linkedProject(t);
		const { mcp, sent } = await server(linked, {});
		await mcp.handle(call("omi_postgres_exec", environment, SQL, { confirm: true, approved: true, yes: true }));
		const result = sent.at(-1)?.result as { isError: boolean; content: { text: string }[] };
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /guardrail_confirmation_required/);
		assert.deepEqual(linked.sql.calls, []);
		assert.deepEqual(linked.mutations(), []);
	});

	test(`mcp_omi_postgres_exec en ${environment} muestra ambiente, base y SQL en la elicitación y ejecuta con el sí`, async (t) => {
		const linked = await linkedProject(t);
		const { mcp, sent } = await server(linked, { elicitation: {} });
		const pending = mcp.handle(call("omi_postgres_exec", environment, SQL));
		const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
		assert.equal(request.params?.message, `Ejecutar SQL en Postgres ventas (${environment})\n\nAmbiente: ${environment}\nBase: ventas (local) · res_${environment}\nSQL:\n${SQL}`);
		assert.deepEqual(linked.sql.calls, []);
		await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result: { action: "accept", content: { confirmar: true } } });
		await pending;
		const result = sent.at(-1)?.result as { isError?: boolean; structuredContent: { rows_affected: number; command: string } };
		assert.equal(result.isError, undefined);
		assert.deepEqual([result.structuredContent.rows_affected, result.structuredContent.command], [1, "DELETE 1"]);
		assert.deepEqual(linked.sql.calls, [{ action: "exec", resourceID: `res_${environment}`, body: { sql: SQL } }]);
	});
}

test("mcp_omi_postgres_exec no ejecuta si el usuario rechaza la elicitación", async (t) => {
	const linked = await linkedProject(t);
	const { mcp, sent } = await server(linked, { elicitation: {} });
	const pending = mcp.handle(call("omi_postgres_exec", "stage", SQL));
	const request = await waitFor(() => sent.find((message) => message.method === "elicitation/create"));
	await mcp.handle({ jsonrpc: "2.0", id: request.id ?? null, result: { action: "decline" } });
	await pending;
	const result = sent.at(-1)?.result as { isError: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /guardrail_declined/);
	assert.deepEqual(linked.sql.calls, []);
});
