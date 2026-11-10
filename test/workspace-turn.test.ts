import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { exerciseWorkspace, plainTerminal } from "./helpers/workspace-pty.ts";

function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 128, completion_tokens: 8, total_tokens: 136 } } : {}) })}\n\n`;
}

test("workspace_un turno real conserva streaming y tools; una confirmación vuelve de Cambios al editor", { skip: process.platform === "win32", timeout: 25000 }, async (t) => {
	const home = await tempDir(t); const agent = join(home, ".omi/agent"); await mkdir(agent, { recursive: true });
	const promptMarker = join(home, "prompt-ready"); const replyMarker = join(home, "reply-ready");
	const requests: string[] = [];
	const server = createServer((request, response) => {
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", () => {
			requests.push(body);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests.length === 1) setTimeout(() => response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "probe", type: "function", function: { name: "workspace_confirm_probe", arguments: "{}" } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n"), 900);
			else { response.end(chunk({ role: "assistant", content: "PROBE_COMPLETED" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"); void writeFile(replyMarker, "done"); }
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "test-not-a-real-key", models: [{ id: "m", name: "Test model", contextWindow: 200000, maxTokens: 8192 }] } } }));
	const extension = join(home, "confirm-probe.ts");
	await writeFile(extension, `import { writeFile } from "node:fs/promises";
	 export default function (pi) {
	 pi.registerTool({ name: "workspace_confirm_probe", label: "Prueba de UI", description: "Pregunta de prueba sin efectos externos", parameters: { type: "object", properties: {} },
	 async execute(_id, _params, _signal, _update, ctx) {
	  const pending = ctx.ui.confirm("Confirmación OMI", "Continuar prueba sin efectos externos?");
	  await writeFile(${JSON.stringify(promptMarker)}, "ready");
	  const answer = await pending;
	  return { content: [{ type: "text", text: answer ? "PROBE_OK" : "PROBE_CANCEL" }], details: {} };
	 } });
	}`);
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await exerciseWorkspace(process.execPath, [binary, "--provider", "mock", "--model", "m", "--no-session", "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--offline"], home, { ...process.env, HOME: home, OMI_HOME: "", OMI_TEST_TURN: "1", OMI_TEST_PROMPT: promptMarker, OMI_TEST_REPLY: replyMarker });
	assert.equal(result.code, 0, result.output);
	const plain = plainTerminal(result.output);
	assert.equal(requests.length, 2, plain);
	assert.ok(requests[1]?.includes("PROBE_OK"), requests[1]);
	assert.match(plain, /▌ Vos/);
	for (const body of requests) {
		const payload = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
		assert.deepEqual(payload.messages.filter((message) => message.role === "user").map((message) => message.content), [[{ type: "text", text: "hola" }]]);
		assert.doesNotMatch(body, /▌ Vos/, "la etiqueta visual no se envía al proveedor");
	}
	// El renderer puede emitir sólo el sufijo cambiado del título: no buscar una pantalla completa en deltas ANSI.
	assert.match(plain, /Cambios locales/); assert.match(plain, /Esperando decisión/); assert.match(plain, /PROBE_COMPLETED/);
	assert.doesNotMatch(plain, /Extension error|TypeError|exceeds terminal width/);
});
