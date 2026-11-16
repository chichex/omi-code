// Black box: launch -> parent returns -> another user turn -> child uses tools again
// -> completion notification -> result collection. Same driver for Node and release binary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { OmiProcess } from "./foreign-config.ts";

function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "background", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) })}\n\n`;
}
const answer = (text: string) => chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
const call = (id: string, args: unknown) => chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "subagent", arguments: JSON.stringify(args) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
const read = (id: string, path: string) => chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

export async function exerciseSubagentBackgroundRuntime(omi: OmiProcess): Promise<void> {
	await mkdir(omi.agent, { recursive: true });
	await writeFile(join(omi.cwd, "background.txt"), "BACKGROUND_WORKTREE_OK");
	const observed = join(omi.cwd, "background-hooks.jsonl"); const extension = join(omi.cwd, "background-probe.ts");
	await writeFile(extension, `import { appendFileSync } from "node:fs";
export default function(pi) {
 pi.on("tool_call", (event) => { if(event.toolName === "read") {
 appendFileSync(${JSON.stringify(observed)}, JSON.stringify({id:event.toolCallId,parent:event.parentToolCallId})+"\\n");
 if(event.input.path === "blocked.txt") return {block:true,reason:"BACKGROUND_HOOK_BLOCKED"};
 }});
}
`);
	let childCalls = 0; let parentCalls = 0; let otherTurn = false; let collected = false; let jobId = ""; let holding: ServerResponse | undefined;
	const childRequests: string[] = [];
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); response.writeHead(404); response.end(); return; }
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (body.includes("<delegated_task>")) {
				childRequests.push(body); childCalls++;
				if (childCalls === 1) response.end(read("first", "background.txt"));
				else if (childCalls === 2) { if (otherTurn) response.end(read("second", "blocked.txt")); else holding = response; }
				else response.end(answer("CHILD_BACKGROUND_DONE"));
				return;
			}
			parentCalls++;
			jobId ||= body.match(/bg-[a-f0-9-]{36}/)?.[0] ?? "";
			if (parentCalls === 1) response.end(call("launch", { agent: "worker", task: "Read background.txt, then blocked.txt, then summarize." }));
			else if (parentCalls === 2) response.end(answer("CONTROL_RETURNED"));
			else if (!otherTurn) { otherTurn = true; response.end(answer("OTHER_THING_DONE")); holding?.end(read("second", "blocked.txt")); }
			else if (!collected) { collected = true; response.end(call("collect", { action: "result", id: jobId })); }
			else response.end(answer("COMPLETION_COLLECTED"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await writeFile(join(omi.agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "m" }] } } }));
		const child = spawn(omi.command, [...(omi.args ?? []), "--mode", "rpc", "--offline", "--no-session", "--no-context-files", "--no-skills", "--extension", extension, "--provider", "mock", "--model", "m"], { cwd: omi.cwd, env: omi.env, stdio: ["pipe", "pipe", "pipe"] });
		let output = ""; let pending = ""; let stderr = ""; let askedOther = false; let finished = false;
		const events: Record<string, unknown>[] = [];
		child.stderr.on("data", (data: Buffer) => { stderr += data; });
		child.stdout.on("data", (data: Buffer) => {
			output += data; pending += data;
			for (;;) {
				const index = pending.indexOf("\n"); if (index < 0) break;
				const line = pending.slice(0, index); pending = pending.slice(index + 1);
				let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { continue; } events.push(event);
				if (event.type === "message_end") {
					const message = event.message as { role?: string; content?: unknown };
					if (message?.role === "assistant" && JSON.stringify(message.content).includes("CONTROL_RETURNED") && !askedOther) {
						askedOther = true; child.stdin.write(JSON.stringify({ type: "prompt", id: "other", message: "OTHER_THING", streamingBehavior: "followUp" }) + "\n");
					}
					if (message?.role === "assistant" && JSON.stringify(message.content).includes("COMPLETION_COLLECTED")) finished = true;
				}
				if (event.type === "agent_end" && finished) child.stdin.end();
			}
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
		try {
			child.stdin.write(JSON.stringify({ type: "prompt", id: "launch", message: "LAUNCH_BACKGROUND_PARENT_PRIVATE" }) + "\n");
			const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
			assert.equal(code, 0, JSON.stringify({ output, stderr, parentCalls, childCalls }));
			assert.equal(otherTurn, true); assert.equal(finished, true, output); assert.equal(collected, true);
			assert.equal(parentCalls, 5, output); assert.equal(childCalls, 3, output);
			assert.ok(childRequests[1]?.includes("BACKGROUND_WORKTREE_OK")); assert.ok(childRequests[2]?.includes("BACKGROUND_HOOK_BLOCKED"));
			assert.ok(childRequests.every((body) => !body.includes("LAUNCH_BACKGROUND_PARENT_PRIVATE") && !body.includes("OTHER_THING")), "child inherited parent conversation");
			const calls = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string; parent: string });
			assert.equal(calls.length, 2); assert.notEqual(calls[0]!.id, calls[1]!.id); assert.notEqual(calls[0]!.parent, calls[1]!.parent);
			assert.ok(calls.every((c) => c.parent.startsWith("omi-background-") && c.id.startsWith(`${c.parent}/`)));
			const collection = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "collect");
			assert.equal((collection?.result as { usage?: { totalTokens: number } })?.usage?.totalTokens, 36, output);
			assert.doesNotMatch(stderr, /Extension error|TypeError|unhandled/i);
		} finally { clearTimeout(timer); child.kill("SIGKILL"); }
	} finally { holding?.end(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
