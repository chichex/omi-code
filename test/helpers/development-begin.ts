// Arranque desde el chat del repo principal: Git, worktrees y sesiones reales; GitHub y modelo falsos.
// switchSession reemplaza la instancia de la extensión como lo hace Pi: session_start primero, withSession después.
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Value } from "typebox/value";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { processRunner, type Runner } from "../../src/core/exec.ts";
import { developmentHarnessExtension } from "../../src/tui/development.ts";
import { tempDir, testIo } from "./io.ts";
import { emitLikePi } from "./pi-events.ts";
import type { KbClient } from "../../src/tui/kb-client.ts";

type Handler = (event: unknown, ctx: ExtensionCommandContext) => unknown;
interface Sent { text: string; options?: { expandPromptTemplates?: boolean } }
export interface Instance { stale: boolean; manager: SessionManager; ctx: ExtensionCommandContext; tools: Map<string, ToolDefinition>; commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>; events: Map<string, Handler[]>; activeTools: string[]; sent: Sent[]; notices: string[]; levels: (string | undefined)[]; send: (text: string, options?: Sent["options"]) => void }
const TRIAGE = JSON.stringify({ type: "fix", summary: "Corregir el valor", rationale: "Describe un bug", scope: [], acceptanceCriteria: [], questions: [] });
const ASSESSMENT = { scope: "crosscutting", impact: "local-behavior", reversible: "yes", verification: "clear", risk: "low", riskAreas: [], rationale: "Requiere seguimiento de varios puntos." };

export async function beginFixture(t: TestContext, options: { args?: readonly string[]; trusted?: boolean; authenticated?: boolean; persistent?: boolean; busy?: boolean; noMain?: boolean; kb?: KbClient } = {}) {
	const home = await realpath(await tempDir(t)); const root = join(home, "repo"); await mkdir(root); const sessions = join(home, "sessions");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", options.noMain ? "trunk" : "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://github.com/test/repo.git");
	await writeFile(join(root, "value.cjs"), "module.exports = 1;\n"); git("add", "."); git("commit", "-m", "test: initial");
	const remote = {
		issues: new Map<number, { title: string; body: string; labels: string[] }>([[42, { title: "Corregir resultado", body: "El resultado esperado es 2.", labels: ["bug"] }]]),
		created: [] as { title: string; body: string }[], confirm: true, failCreate: false, classify: TRIAGE, cancelSwitch: false,
		requestClassify: JSON.stringify({ triage: JSON.parse(TRIAGE), assessment: ASSESSMENT }), cancelClassify: false, failClassify: false, stopReason: "stop", onClassify: undefined as (() => Promise<void>) | undefined,
		cancelInFlight: false, classifyStarted: undefined as Promise<void> | undefined,
		// Retiene la respuesta del diálogo para probar un segundo arranque mientras el primero espera el sí.
		hold: undefined as Promise<void> | undefined,
	};
	const prompts: { title: string; description: string }[] = []; const switches: string[] = []; const modelCalls: unknown[] = []; const calls: string[][] = [];
	const order: string[] = []; const continuations: { customType: string; content: string; details?: unknown }[] = [];
	let cancelledWork: Promise<void> | undefined;
	const runner: Runner = { async run(command, args, runOptions) {
		if (command !== "gh") return processRunner.run(command, args, runOptions);
		calls.push(args);
		const json = (data: unknown) => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
		if (args[0] === "repo" && args[1] === "view") return json({ nameWithOwner: "test/repo", url: "https://github.com/test/repo" });
		if (args[0] === "issue" && args[1] === "create") {
			order.push("create");
			if (remote.failCreate) return { code: 1, stdout: "", stderr: "HTTP 502" };
			const title = args[args.indexOf("--title") + 1]!; const body = runOptions?.input ?? ""; const number = 43 + remote.created.length;
			remote.created.push({ title, body }); remote.issues.set(number, { title, body, labels: [] });
			return { code: 0, stdout: `https://github.com/test/repo/issues/${number}\n`, stderr: "" };
		}
		if (args[0] === "issue" && args[1] === "view") {
			const number = Number(args[2]); const issue = remote.issues.get(number);
			if (!issue) return { code: 1, stdout: "", stderr: "not found" };
			return json({ number, title: issue.title, body: issue.body, url: `https://github.com/test/repo/issues/${number}`, labels: issue.labels.map((name) => ({ name })) });
		}
		throw new Error(`Llamada remota no prevista: ${args.join(" ")}`);
	} };
	const queue: { instance: Instance; text: string }[] = [];
	let current: Instance;
	async function attach(manager: SessionManager): Promise<Instance> {
		const tools = new Map<string, ToolDefinition>(); const commands: Instance["commands"] = new Map(); const events = new Map<string, Handler[]>();
		const instance = { stale: false, manager, tools, commands, events, activeTools: ["read", "bash", "write", "edit"], sent: [] as Sent[], notices: [] as string[], levels: [] as (string | undefined)[] } as Instance;
		// Como Pi: después de reemplazar la sesión, usar el pi o el ctx viejos es un error.
		const live = () => { if (instance.stale) throw new Error("Stale extension: se usó la instancia de una sesión reemplazada"); };
		const send = instance.send = (text: string, sendOptions?: Sent["options"]) => {
			live(); instance.sent.push({ text, ...(sendOptions ? { options: sendOptions } : {}) });
			if (sendOptions?.expandPromptTemplates && text.startsWith("/")) queue.push({ instance, text });
		};
		const pi = {
			registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); if (tool.defaultActive !== false) instance.activeTools.push(tool.name); },
			registerCommand: (name: string, command: Instance["commands"] extends Map<string, infer C> ? C : never) => commands.set(name, command),
			on: (name: string, handler: Handler) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
			events: { emit: () => {} }, getActiveTools: () => instance.activeTools, setActiveTools: (names: string[]) => { instance.activeTools = names; }, getAllTools: () => [],
			appendEntry: (name: string, data: unknown) => { live(); manager.appendCustomEntry(name, data); }, sendUserMessage: send,
			sendMessage: (message: { customType: string; content: string; details?: unknown }) => { live(); continuations.push(message); manager.appendCustomMessageEntry(message.customType, message.content, true, message.details); },
		} as unknown as ExtensionAPI;
		instance.ctx = {
			cwd: manager.getCwd(), mode: "tui", hasUI: true, sessionManager: manager, model: { id: "mock", provider: "mock", input: ["text"] }, thinkingLevel: "off",
			isProjectTrusted: () => options.trusted ?? true, isIdle: () => !options.busy, hasPendingMessages: () => false,
			ui: { setStatus: () => {}, notify: (message: string, level?: string) => { live(); instance.notices.push(message); instance.levels.push(level); }, confirm: async (title: string, description: string) => { live(); order.push("confirm"); prompts.push({ title, description }); await remote.hold; return remote.confirm; } },
			modelRegistry: {
				hasConfiguredAuth: () => options.authenticated ?? true,
				complete: async (_model: unknown, input: unknown) => { order.push("classify"); modelCalls.push(input); await remote.onClassify?.(); if (remote.failClassify) throw new Error("Proveedor caído"); const fresh = JSON.stringify(input).includes("SIN issue"); return { stopReason: remote.stopReason, provider: "mock", model: "mock", content: [{ type: "text", text: fresh ? remote.requestClassify : remote.classify }], usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; },
			},
			switchSession: async (file: string, switchOptions?: { withSession?: (next: ExtensionCommandContext & { sendUserMessage: typeof send }) => Promise<void> }) => {
				switches.push(file);
				if (remote.cancelSwitch) return { cancelled: true };
				for (const handler of current.events.get("session_shutdown") ?? []) await handler({}, current.ctx);
				current.stale = true;
				const next = await attach(SessionManager.open(file)); current = next;
				await switchOptions?.withSession?.({ ...next.ctx, sendUserMessage: async (text: string, sendOptions?: Sent["options"]) => next.send(text, sendOptions) } as never);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext;
		const extension = developmentHarnessExtension(testIo({ homeDir: home, cwd: manager.getCwd() }), [...(options.args ?? []), "--session-dir", sessions], { runner, loader: async (_ctx, _title, work) => {
			if (remote.cancelClassify) return undefined;
			const controller = new AbortController(); const pending = work(controller.signal);
			if (!remote.cancelInFlight) return pending;
			cancelledWork = pending.then(() => {}, () => {});
			await remote.classifyStarted; controller.abort(); return undefined;
		}, ...(options.kb ? { kb: options.kb } : {}) });
		if (typeof extension === "function") await extension(pi); else await extension.factory(pi);
		for (const handler of events.get("session_start") ?? []) await handler({}, instance.ctx);
		return instance;
	}
	const main = options.persistent === false ? SessionManager.inMemory(root) : SessionManager.create(root, sessions);
	main.appendMessage({ role: "user", content: "Pedido en el chat principal", timestamp: Date.now() });
	current = await attach(main);
	const emit = (name: string, event: unknown = {}) => emitLikePi(current.events.get(name) ?? [], name, event, current.ctx);
	// Pi procesa los comandos despachados cuando la sesión queda en reposo; los mensajes comunes van al modelo.
	const flush = async () => {
		for (let item = queue.shift(); item; item = queue.shift()) {
			const [name, ...rest] = item.text.slice(1).split(" ");
			const command = item.instance.commands.get(name!); if (!command) throw new Error(`Comando no registrado: ${name}`);
			await command.handler(rest.join(" "), item.instance.ctx);
		}
	};
	const invoke = async (name: string, input: unknown) => {
		const tool = current.tools.get(name); if (!tool) throw new Error(`Tool no registrada: ${name}`);
		if (!Value.Check(tool.parameters, input)) throw new Error("Argumentos de tool inválidos");
		const blocked = await emit("tool_call", { toolName: name, input }); if (blocked && typeof blocked === "object" && "block" in blocked && blocked.block) throw new Error("Tool bloqueada");
		return tool.execute("tool", input as never, new AbortController().signal, undefined, current.ctx as unknown as ExtensionToolContext);
	};
	// El agente pide empezar, el turno termina y OMI despacha el comando interno.
	const ask = async (input: unknown) => { const result = await invoke("omi_work_begin", input); await emit("agent_settled"); await flush(); return result; };
	const command = async (input: string) => { await current.commands.get("omi-work")!.handler(input, current.ctx); await flush(); };
	const openMain = async () => { for (const handler of current.events.get("session_shutdown") ?? []) await handler({}, current.ctx); current.stale = true; current = await attach(SessionManager.open(main.getSessionFile()!)); };
	const reload = async () => { for (const handler of current.events.get("session_shutdown") ?? []) await handler({}, current.ctx); current.stale = true; current = await attach(SessionManager.open(current.manager.getSessionFile()!)); };
	return { home, root, sessions, remote, prompts, switches, modelCalls, calls, order, continuations, waitCancelled: async () => { await cancelledWork; }, main, git, ask, invoke, emit, flush, command, reload, openMain, current: () => current, kickoffs: () => current.sent.filter((message) => !message.options?.expandPromptTemplates).map((message) => message.text) };
}
