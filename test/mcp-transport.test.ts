import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { JsonRpcMessage } from "../src/mcp/server.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";
import { startMockOmi } from "./helpers/mock-omi.ts";

function conversation(t: TestContext, linked: Linked, args: string[], call: object, capabilities: object, onMessage: (message: JsonRpcMessage) => boolean) {
	return new Promise<JsonRpcMessage[]>((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: linked.home, OMI_POLL_INTERVAL_MS: "1" };
		delete env.OMI_AGENT_SESSION;
		const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/omi.ts", import.meta.url)), "mcp", ...args], { cwd: linked.repo, env });
		const timeout = setTimeout(() => { child.kill(); reject(new Error("MCP no terminó al cerrar stdin")); }, 5000);
		t.after(() => { clearTimeout(timeout); child.kill(); });
		let buffer = "";
		const messages: JsonRpcMessage[] = [];
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const message = JSON.parse(buffer.slice(0, newline)) as JsonRpcMessage;
				buffer = buffer.slice(newline + 1);
				messages.push(message);
				if (onMessage(message)) child.stdin.end();
			}
		});
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timeout); code === 0 ? resolve(messages) : reject(new Error(`MCP exit ${code}`)); });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } }) + "\n");
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }) + "\n");
	});
}

test("omi mcp --api no ignora el destino pedido ni usa las credenciales en otro host", async (t) => {
	const linked = await linkedProject(t);
	const other = await startMockOmi(t);
	const messages = await conversation(t, linked, ["--api", other.url], { name: "omi_project_status", arguments: {} }, {}, (m) => m.id === 1);
	assert.match(JSON.stringify(messages.find((m) => m.id === 1)?.result), /api_url_mismatch/);
	assert.deepEqual(linked.omi.requests, []);
	assert.deepEqual(other.requests, []);
});

test("omi mcp termina cuando el cliente desconecta con una elicitación pendiente", async (t) => {
	const linked = await linkedProject(t);
	const messages = await conversation(t, linked, [], { name: "omi_env_set", arguments: { environment: "prod", set: [{ name: "A", value: "b" }] } }, { elicitation: {} }, (m) => m.method === "elicitation/create");
	assert.ok(messages.some((m) => m.method === "elicitation/create"));
	assert.deepEqual(linked.mutations(), []);
});
