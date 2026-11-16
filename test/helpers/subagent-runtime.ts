// E2E con proveedor local: padre -> subagent -> read por el pipeline padre -> respuesta.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { OmiProcess } from "./foreign-config.ts";

function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "subagent", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) })}\n\n`;
}
function answer(content: string): string {
	return chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}
function call(name: string, args: unknown): string {
	return chunk({ role: "assistant", tool_calls: [{ index: 0, id: "delegate", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
}

export async function exerciseSubagentRuntime(omi: OmiProcess, blockRead = false): Promise<void> {
	await mkdir(omi.agent, { recursive: true });
	await writeFile(join(omi.cwd, "delegated.txt"), "FILE_FROM_ACTIVE_WORKTREE");
	const observed = join(omi.cwd, "nested-calls.jsonl");
	const extension = join(omi.cwd, "subagent-probe.ts");
	await writeFile(extension, `import { appendFileSync } from "node:fs";
export default function(pi) { pi.on("tool_call", (event, ctx) => {
 if (event.toolName === "read") {
  appendFileSync(${JSON.stringify(observed)}, JSON.stringify({parent:event.parentToolCallId,cwd:ctx.cwd}) + "\\n");
  if (${blockRead}) return {block:true, reason:"PARENT_HOOK_BLOCKED"};
 }
}); }
`);
	const requests: string[] = [];
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); response.writeHead(404); response.end(); return; }
		let body = ""; request.on("data", (chunk: Buffer) => { body += chunk; });
		request.on("end", () => {
			requests.push(body); response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests.length === 1) response.end(call("subagent", { agent: "worker", task: "Read delegated.txt and summarize." }));
			else if (requests.length === 2) response.end(call("read", { path: "delegated.txt" }));
			else if (requests.length === 3) response.end(answer("CHILD_SUMMARY"));
			else response.end(answer("PARENT_DONE"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await writeFile(join(omi.agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "m" }] } } }));
		const child = spawn(omi.command, [...(omi.args ?? []), "--offline", "--no-session", "--extension", extension, "--provider", "mock", "--model", "m", "-p", "PARENT_PRIVATE_CONTEXT"], {
			cwd: omi.cwd, env: omi.env, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = ""; let stderr = "";
		child.stdout.on("data", (data: Buffer) => { output += data; });
		child.stderr.on("data", (data: Buffer) => { stderr += data; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
		try {
			const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
			assert.equal(code, 0, stderr); assert.match(output, /PARENT_DONE/);
			assert.equal(requests.length, 4, JSON.stringify({ requests, output, stderr }));
			assert.ok(requests[0]!.includes("subagent"));
			assert.ok(!requests[1]!.includes("PARENT_PRIVATE_CONTEXT"), "el hijo heredó conversación privada");
			assert.equal(requests[2]!.includes("FILE_FROM_ACTIVE_WORKTREE"), !blockRead, "read no respetó el cwd o el hook del padre");
			if (blockRead) assert.ok(requests[2]!.includes("PARENT_HOOK_BLOCKED"));
			assert.ok(requests[3]!.includes("CHILD_SUMMARY"));
			assert.deepEqual(JSON.parse((await readFile(observed, "utf8")).trim()), { parent: "delegate", cwd: await realpath(omi.cwd) });
		} finally { clearTimeout(timer); child.kill("SIGKILL"); }
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
