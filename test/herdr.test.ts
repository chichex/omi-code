import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { herdrExtension, sendHerdrReport, type HerdrReport, type HerdrSend } from "../src/tui/herdr.ts";
import { tempDir, testIo as baseTestIo } from "./helpers/io.ts";

function testIo(env: Record<string, string>) { return baseTestIo({ homeDir: "/home/test", env }); }
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const sessionFile = "/home/test/.omi/agent/sessions/project/session.jsonl";
const context = (overrides: Record<string, unknown> = {}): ExtensionContext => ({
	mode: "tui", isIdle: () => true,
	sessionManager: { getSessionFile: () => sessionFile },
	model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high",
	...overrides,
}) as unknown as ExtensionContext;

async function bind(extension: InlineExtension) {
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
	assert.equal(typeof extension, "object");
	if (typeof extension === "function") throw new Error("se esperaba una extensión con nombre");
	await extension.factory({ on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) => {
		handlers.set(name, handler);
	} } as never);
	return async (name: string, event: Record<string, unknown> = {}, ctx = context()) => {
		await handlers.get(name)?.({ type: name, ...event }, ctx);
		await setImmediate(); // drenar los reportes en background, no bloquear los handlers
	};
}

function recorder() {
	const calls: HerdrReport[] = [];
	const send: HerdrSend = async (socket, report) => { assert.equal(socket, env.HERDR_SOCKET_PATH); calls.push(report); };
	return { calls, send };
}
function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

test("Herdr_reporta omi, sesión, modelo y razonamiento sin necesitar una extensión instalada", async () => {
	const { calls, send } = recorder();
	const fire = await bind(herdrExtension(testIo(env), [], send));
	await fire("session_start");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, "pane.report_agent");
	assert.deepEqual(calls[0]?.params, {
		pane_id: env.HERDR_PANE_ID, source: "omi", agent: "omi", state: "idle", seq: calls[0]!.params.seq,
		agent_session_path: sessionFile,
		resume_argv: ["omi", "--session", sessionFile, "--model", "openai/gpt-test", "--thinking", "high"],
	});
});

for (const missing of Object.keys(env)) {
	test(`Herdr_no actúa sin ${missing}`, async () => {
		const { calls, send } = recorder();
		const partial: Record<string, string> = { ...env };
		delete partial[missing];
		const fire = await bind(herdrExtension(testIo(partial), [], send));
		await fire("session_start");
		await fire("agent_start");
		await fire("session_shutdown", { reason: "quit" });
		assert.deepEqual(calls, []);
	});
}
for (const mode of ["rpc", "json", "print"]) {
	test(`Herdr_${mode} no se apropia del pane del agente padre`, async () => {
		const { calls, send } = recorder();
		const fire = await bind(herdrExtension(testIo(env), [], send));
		for (const name of ["session_start", "agent_start", "ui_prompt_start", "agent_settled"]) await fire(name, {}, context({ mode }));
		await fire("session_shutdown", { reason: "quit" }, context({ mode }));
		assert.deepEqual(calls, []);
	});
}

test("Herdr_working hasta agent_settled, blocked durante decisiones, vuelve al estado anterior", async () => {
	const { calls, send } = recorder();
	const fire = await bind(herdrExtension(testIo(env), [], send));
	await fire("session_start");
	await fire("before_agent_start");
	await fire("agent_start");
	await fire("ui_prompt_start", { title: "¿Desplegar en producción?" });
	assert.equal(calls.at(-1)!.params.message, "¿Desplegar en producción?");
	await fire("ui_prompt_end");
	const beforeEnd = calls.length;
	await fire("agent_end");
	assert.equal(calls.length, beforeEnd, "agent_end puede ir seguido de reintentos");
	await fire("agent_settled", { aborted: true });
	await fire("ui_prompt_start", { title: "Elegir sesión" });
	await fire("ui_prompt_end");
	assert.deepEqual(calls.map(({ params }) => params.state), ["idle", "working", "working", "blocked", "working", "idle", "blocked", "idle"]);
});

for (const reason of ["reload", "new", "resume", "fork"]) {
	test(`Herdr_${reason} conserva autoridad, actualiza sesión y secuencia; quit libera una sola vez`, async () => {
		const { calls, send } = recorder();
		const extension = herdrExtension(testIo(env), [], send);
		const old = await bind(extension);
		await old("session_start");
		await old("session_shutdown", { reason });
		await old("agent_settled"); // callbacks tardíos de la instancia anterior no reportan
		assert.equal(calls.length, 1);
		const fresh = await bind(extension);
		const ctx = context({ isIdle: () => false, sessionManager: { getSessionFile: () => "/other/session.jsonl" } });
		await fresh("session_start", { reason }, ctx);
		assert.equal(calls.at(-1)!.params.state, "working");
		assert.equal(flag(calls.at(-1)!.params.resume_argv!, "--session"), "/other/session.jsonl");
		await fresh("session_shutdown", { reason: "quit" });
		await fresh("session_shutdown", { reason: "quit" });
		assert.equal(calls.length, 3);
		assert.equal(calls[2]!.method, "pane.release_agent");
		const seq = calls.map(({ params }) => params.seq);
		assert.ok(seq[0]! < seq[1]! && seq[1]! < seq[2]!);
	});
}

test("Herdr_actualiza el comando al cambiar modelo o razonamiento", async () => {
	const { calls, send } = recorder();
	const fire = await bind(herdrExtension(testIo(env), [], send));
	await fire("session_start");
	await fire("model_select", {}, context({ model: { provider: "anthropic", id: "claude-test" } }));
	assert.equal(flag(calls.at(-1)!.params.resume_argv!, "--model"), "anthropic/claude-test");
	await fire("thinking_level_select", {}, context({ thinkingLevel: "low" }));
	assert.equal(flag(calls.at(-1)!.params.resume_argv!, "--thinking"), "low");
});

test("Herdr_restaura restricciones de tools y recursos, no vuelve a enviar prompts ni API keys", async () => {
	const { calls, send } = recorder();
	const fire = await bind(herdrExtension(testIo(env), [
		"--continue", "--api-key", "secret", "--tools", "read,bash", "--no-mcp", "-nc", "-ne", "--no-approve",
		"--extension", "/test/ext.ts", "--session-dir", "/sessions", "--models", "openai/*", "@attachment", "prompt privado",
	], send));
	await fire("session_start");
	const command = calls[0]!.params.resume_argv!;
	for (const absent of ["secret", "--api-key", "--continue", "--session-dir", "@attachment", "prompt privado"]) assert.ok(!command.includes(absent));
	for (const present of ["--tools", "read,bash", "--no-mcp", "--no-context-files", "--no-extensions", "--no-approve", "--extension", "/test/ext.ts", "--models", "openai/*"]) assert.ok(command.includes(present));
});

for (const file of [undefined, "/a'b/session.jsonl", "/a\nb/session.jsonl", "/" + "é".repeat(5000)]) {
	test(`Herdr_sin resume válido sigue reportando estado (${file === undefined ? "efímera" : "ruta no admitida"})`, async () => {
		const { calls, send } = recorder();
		const fire = await bind(herdrExtension(testIo(env), [], send));
		await fire("session_start", {}, context({ sessionManager: { getSessionFile: () => file } }));
		assert.equal(calls[0]!.params.state, "idle");
		assert.equal(calls[0]!.params.resume_argv, undefined);
		assert.equal(calls[0]!.params.agent_session_path, undefined);
	});
}

test("Herdr_errores de comunicación no rompen eventos ni shutdown", async () => {
	let attempts = 0;
	const fire = await bind(herdrExtension(testIo(env), [], async () => { attempts++; throw new Error("socket cerrado"); }));
	await fire("session_start");
	await fire("agent_start");
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(attempts, 3);
});

test("Herdr_cola acotada: eventos no bloquean y sólo se envía el estado más reciente", async () => {
	const calls: HerdrReport[] = [];
	let finish!: () => void;
	const held = new Promise<void>((resolve) => { finish = resolve; });
	const fire = await bind(herdrExtension(testIo(env), [], async (_socket, report) => { calls.push(report); if (calls.length === 1) await held; }));
	await fire("session_start");
	for (let i = 0; i < 20; i++) {
		await fire("agent_start");
		await fire("ui_prompt_start", { title: "esperando" });
		await fire("ui_prompt_end");
	}
	await fire("agent_settled");
	assert.equal(calls.length, 1);
	finish();
	await setImmediate();
	assert.equal(calls.length, 2);
	assert.equal(calls[1]!.params.state, "idle");
	assert.ok(calls[1]!.params.seq > calls[0]!.params.seq);
	await fire("session_shutdown", { reason: "quit" });
});

test("Herdr_quit no deja que un reporte pendiente vuelva a reclamar el pane", async () => {
	const calls: HerdrReport[] = [];
	let finish!: () => void;
	const held = new Promise<void>((resolve) => { finish = resolve; });
	const fire = await bind(herdrExtension(testIo(env), [], async (_socket, report) => { calls.push(report); if (calls.length === 1) await held; }));
	await fire("session_start");
	await fire("agent_start");
	const quit = fire("session_shutdown", { reason: "quit" });
	finish();
	await quit;
	assert.deepEqual(calls.map(({ method }) => method), ["pane.report_agent", "pane.release_agent"]);
});

const report: HerdrReport = { id: "test", method: "pane.report_agent", params: { pane_id: "w1:p1", source: "omi", agent: "omi", state: "idle", seq: 1 } };

test("Herdr_transporte real envía JSONL y cierra la conexión al recibir el acuse", async (t) => {
	const path = process.platform === "win32" ? `\\\\.\\pipe\\omi-herdr-${process.pid}` : join(await tempDir(t), "herdr.sock");
	const received: string[] = [];
	const server = createServer((socket) => {
		socket.on("data", (data) => { received.push(data.toString()); socket.write('{"result":{}}\n'); });
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	await sendHerdrReport(path, report);
	assert.equal(received.join(""), JSON.stringify(report) + "\n");
});

test("Herdr_transporte real ignora sockets ausentes", async (t) => {
	await sendHerdrReport(join(await tempDir(t), "missing.sock"), report);
});

test("Herdr_transporte real abandona un servidor que no responde", async (t) => {
	const path = process.platform === "win32" ? `\\\\.\\pipe\\omi-herdr-timeout-${process.pid}` : join(await tempDir(t), "herdr.sock");
	const server = createServer((socket) => { socket.resume(); });
	await new Promise<void>((resolve) => server.listen(path, resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const start = Date.now();
	await sendHerdrReport(path, report);
	assert.ok(Date.now() - start < 2500, "el timeout debe ser corto");
});
