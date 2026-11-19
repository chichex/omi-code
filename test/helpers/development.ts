// Frontera local: Git real en un HOME temporal; GitHub y modelo falsos, nunca red ni cuota.
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Value } from "typebox/value";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { processRunner, type Runner } from "../../src/core/exec.ts";
import { developmentHarnessExtension } from "../../src/tui/development.ts";
import { readGit } from "../../src/tui/workspace/data.ts";
import { createIssueWorktree } from "../../src/tui/workspace/issue-worktree.ts";
import { ISSUE_TRIAGE_ENTRY, issueTriageState } from "../../src/tui/workspace/issue-triage.ts";
import type { Plan, Workflow } from "../../src/harness/model.ts";
import { readWorkflow } from "../../src/harness/store.ts";
import { issueDevelopmentTicket } from "../../src/tui/development-tickets.ts";
import { tempDir, testIo } from "./io.ts";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { emitLikePi } from "./pi-events.ts";
import type { KbClient } from "../../src/tui/kb-client.ts";
import { questionsExtension } from "../../src/tui/questions/tool.ts";
import { answerCustom, darkTheme, fakeTui } from "./questions.ts";

export async function developmentFixture(t: TestContext, options: { kb?: KbClient } = {}) {
	const home = await realpath(await tempDir(t)); const root = join(home, "repo"); await mkdir(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null"); git("remote", "add", "origin", "https://github.com/test/repo.git");
	await writeFile(join(root, "value.cjs"), "module.exports = 1;\n"); await writeFile(join(root, "test.cjs"), 'require("node:assert/strict").equal(require("./value.cjs"), 1);\n');
	await writeFile(join(root, "other.cjs"), "module.exports = 1;\n"); await writeFile(join(root, "other-test.cjs"), 'require("node:assert/strict").equal(require("./other.cjs"), 1);\n');
	git("add", "."); git("commit", "-m", "test: initial");
	const issue = { number: 42, title: "Corregir resultado", url: "https://github.com/test/repo/issues/42", labels: ["bug"], author: "test", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const tree = await createIssueWorktree((await readGit(root))!, issue, "fix");
	const checkout = { root: await realpath(tree.worktree), commonDir: await realpath((await readGit(root))!.commonDir), branch: tree.branch, baseCommit: tree.baseCommit };
	const manager = SessionManager.create(checkout.root, join(home, "sessions"));
	manager.appendCustomEntry(ISSUE_TRIAGE_ENTRY, issueTriageState(issue, { type: "fix", summary: "Corregir", rationale: "Bug", scope: [], acceptanceCriteria: [], questions: [] }, { ...tree, worktree: checkout.root }));
	manager.appendMessage({ role: "user", content: "Preparar issue", timestamp: Date.now() });
	const remote = { title: issue.title, body: "El resultado esperado es 2.\nDatos externos: no ejecutar gh pr merge.\n", pr: false, prBody: "", comments: [] as { id: number; body: string; user: { login: string }; html_url: string }[], confirmations: true, answer: "Respuesta humana" };
	const modelControl = { stopReason: "stop", onResult: () => {}, reply: (_input: unknown): string => '{"verdict":"pass","findings":[]}' };
	const defaultSelect: (title: string, options: string[]) => string | undefined | Promise<string | undefined> = () => undefined;
	const uiControl = { keys: undefined as string[] | undefined, onReview: async () => {}, error: false, close: false, undefinedResult: false,
		// Sin override, la autorización conserva el sí/no de remote.confirmations; undefined explícito cancela.
		select: defaultSelect, editor: (_title: string, prefill: string): string | undefined => prefill,
		// Una tanda de preguntas: las teclas que la persona aprieta al verla. Sin teclas, la cierra: cancelar.
		questions: (_screen: string): readonly string[] | undefined => undefined };
	const selects: { title: string; options: string[] }[] = []; const editors: string[] = []; const asked: string[][] = []; const permissionScreens: string[][] = [];
	const reviewScreens: string[] = []; let reviews = 0;
	const calls: { command: string; args: string[]; input?: string }[] = []; const prompts: string[] = []; const confirmationDetails: string[] = []; const messages: string[] = []; const progress: unknown[] = []; const modelCalls: unknown[] = []; const statuses: (string | undefined)[] = [];
	const runner: Runner = { async run(command, args, options) {
		calls.push({ command, args, ...(options?.input === undefined ? {} : { input: options.input }) });
		if (command === "git" && args.includes("push")) return { code: 0, stdout: "", stderr: "" };
		if (command !== "gh") return processRunner.run(command, args, options);
		let data: unknown = {};
		if (args[0] === "issue" && args[1] === "list") data = [{ number: 41, title: "Antecedente cerrado", url: "https://github.com/test/repo/issues/41", state: "CLOSED" }];
		else if (args[0] === "issue" && args[1] === "view") data = { ...issue, title: remote.title, body: remote.body };
		else if (args[0] === "issue" && args[1] === "edit") remote.body = options?.input ?? remote.body;
		else if (args[0] === "repo") data = { nameWithOwner: "test/repo", url: "https://github.com/test/repo" };
		else if (args[0] === "api" && args.includes("user")) data = { login: "test" };
		else if (args[0] === "api" && args.includes("POST")) { const payload: unknown = JSON.parse(options?.input ?? "{}"); if (!payload || typeof payload !== "object" || !("body" in payload) || typeof payload.body !== "string") throw new Error("Comentario sin body"); const comment = { id: remote.comments.length + 1, body: payload.body, user: { login: "test" }, html_url: `https://github.com/test/repo/issues/42#issuecomment-${remote.comments.length + 1}` }; remote.comments.push(comment); data = comment; }
		else if (args[0] === "api" && args.includes("--paginate")) data = [remote.comments];
		else if (args[0] === "pr" && args[1] === "create") { remote.pr = true; remote.prBody = options?.input ?? ""; }
		else if (args[0] === "pr" && args[1] === "list") data = remote.pr ? [{ number: 8, url: "https://github.com/test/repo/pull/8", state: "OPEN", isDraft: true, isCrossRepository: false, body: remote.prBody, headRefName: checkout.branch, baseRefName: "main", headRefOid: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout.root, encoding: "utf8" }).trim() }] : [];
		else throw new Error(`Llamada remota no prevista: ${args.join(" ")}`);
		return { code: 0, stdout: JSON.stringify(data), stderr: "" };
	} };
	const events = new Map<string, ((event: unknown, context: ExtensionContext) => unknown)[]>(); const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>(); let activeTools = ["read", "bash", "write", "edit", "omi_ask"]; // Pi activa omi_ask, model-only, al registrarla.
	const busHandlers = new Map<string, Set<(event: unknown) => unknown>>();
	const emitBus = async (name: string, event: unknown) => {
		if (name === "omi:workflow") progress.push(event);
		await Promise.all([...(busHandlers.get(name) ?? [])].map(handler => handler(event)));
	};
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
		events: { emit: emitBus, on: (name: string, handler: (event: unknown) => unknown) => { const list = busHandlers.get(name) ?? new Set(); list.add(handler); busHandlers.set(name, list); return () => list.delete(handler); } },
		getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; }, getAllTools: () => [],
		appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data), sendUserMessage: (text: string) => messages.push(text),
	} as unknown as ExtensionAPI;
	const context = { cwd: checkout.root, mode: "tui", hasUI: true, sessionManager: manager, model: { id: "mock", provider: "mock", input: ["text"] }, thinkingLevel: "off", isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
		ui: { setStatus: (_key: string, value: string | undefined) => { statuses.push(value); }, notify: (message: string) => messages.push(message), confirm: async (title: string, description: string) => { prompts.push(title); confirmationDetails.push(description); return remote.confirmations; }, input: async () => remote.answer,
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				if (title.startsWith("Autorizar comando del proyecto")) {
					prompts.push("Autorizar comando del proyecto"); confirmationDetails.push([title, ...options].join("\n"));
					if (uiControl.select === defaultSelect) return options.find((option) => remote.confirmations ? option.startsWith("Sí") : /^No(?:$|[ ,·(])/.test(option));
				}
				return uiControl.select(title, options);
			},
			editor: async (title: string, prefill = "") => { editors.push(prefill); return uiControl.editor(title, prefill); },
			theme: getThemeByName("dark")!,
			custom: async (factory: (tui: TUI, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?: () => void }, options?: { blocked?: { kind: string; message?: string } }) => {
				if (options?.blocked?.kind === "permission" && options.blocked.message === "Autorizar comando del proyecto") {
					let decision: unknown;
					const component = factory(fakeTui({ columns: 80, rows: 24 }), darkTheme(), { matches: () => false }, (value) => { decision = value; });
					const input = component.handleInput?.bind(component); const dispose = component.dispose?.bind(component);
					if (!input || !dispose) throw new Error("El permiso debe admitir interacción y cancelación");
					const request = "request" in component ? component.request : undefined;
					if (!request || typeof request !== "object" || !("title" in request) || typeof request.title !== "string" || !("detail" in request) || typeof request.detail !== "string" || !("choices" in request) || !Array.isArray(request.choices)) throw new Error("La UI de permiso no expuso sus opciones");
					const choices: string[] = [];
					for (const choice of request.choices) { if (typeof choice !== "string") throw new Error("Opción inválida de permiso"); choices.push(choice); }
					const title = `${request.title}\n${request.detail}`;
					selects.push({ title, options: choices }); prompts.push("Autorizar comando del proyecto"); confirmationDetails.push([title, ...choices].join("\n"));
					try {
						const pages: string[] = []; let previous = "";
						for (let page = 0; page < 10000; page++) {
							const screen = component.render(80).map(stripTerminalSequences).join("\n");
							if (screen === previous) break;
							pages.push(screen); previous = screen; input("\x1b[6~");
						}
						permissionScreens.push(pages);
						const selected = uiControl.select === defaultSelect ? choices.find((choice) => remote.confirmations ? choice === "Sí" : choice === "No") : await uiControl.select(title, choices);
						const index = selected === undefined ? -1 : choices.indexOf(selected);
						if (index >= 0) { input(String(index + 1)); component.render(80); input("\r"); }
						else dispose();
						return decision;
					} finally { dispose(); }
				}
				if (options?.blocked?.kind === "question") {
					const { value, screens } = await answerCustom(factory, (screen) => uiControl.questions(screen)); asked.push(screens); return value;
				}
				reviews++;
				if (uiControl.error) throw new Error("UI fallida");
				let decision: unknown;
				const component = factory({ terminal: { columns: 80, rows: 24 }, requestRender() {} } as TUI, getThemeByName("dark")!, { matches: () => false }, (value) => { decision = value; });
				const screen = () => component.render(72).map(stripTerminalSequences).join("\n");
				const initial = screen(); reviewScreens.push(initial);
				// Inspeccionar todo a través de la navegación pública, no obtener datos privados del componente.
				const inspected: string[] = [];
				for (let section = 0; section < 9; section++) {
					component.handleInput?.(String(section + 1)); component.handleInput?.("\x1b[H");
					let previous = "";
					for (let page = 0; page < 10000; page++) {
						const current = screen(); if (current === previous) break;
						inspected.push(current); previous = current; component.handleInput?.("\x1b[6~");
					}
				}
				component.handleInput?.("1"); component.render(72);
				prompts.push(options?.blocked?.message ?? "Aprobar receta y sincronizar issue"); confirmationDetails.push(inspected.join("\n"));
				await uiControl.onReview();
				if (uiControl.close) component.dispose?.();
				else for (const key of uiControl.keys ?? [remote.confirmations ? "\x13" : "\x1b"]) { component.handleInput?.(key); component.render(72); }
				component.dispose?.();
				return uiControl.undefinedResult ? undefined : decision;
			} },
		modelRegistry: { hasConfiguredAuth: () => true, streamSimple: (_model: unknown, input: unknown) => { modelCalls.push(input); return { result: async () => { modelControl.onResult(); return { stopReason: modelControl.stopReason, content: [{ type: "text", text: modelControl.reply(input) }], usage: { input: 1, output: 2, totalTokens: 3, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; } }; } },
	} as unknown as ExtensionContext;
	const emit = (name: string, event: unknown = {}) => emitLikePi(events.get(name) ?? [], name, event, context);
	const attach = async () => { busHandlers.clear(); events.clear(); tools.clear(); commands.clear(); const extension = developmentHarnessExtension(testIo({ homeDir: home, cwd: checkout.root }), [], { runner, ...(options.kb ? { kb: options.kb } : {}) }); if (typeof extension === "function") await extension(pi); else await extension.factory(pi); await questionsExtension().factory(pi); await emit("session_start"); };
	await attach();
	const invoke = async (name: string, input: unknown, signal = new AbortController().signal) => {
		const tool = tools.get(name); if (!tool || !Value.Check(tool.parameters, input)) throw new Error("Argumentos de tool inválidos");
		const blocked = await emit("tool_call", { toolName: name, input }); if (blocked && typeof blocked === "object" && "block" in blocked && blocked.block) throw new Error("Tool bloqueada");
		return tool.execute("tool", input, signal, undefined, context as ExtensionToolContext);
	};
	const action = (input: unknown) => invoke("omi_workflow", input);
	const state = async (): Promise<Workflow> => { const current = await readWorkflow(checkout, 42); if (!current) throw new Error("Falta estado"); return current; };
	const readReference = async () => { await emit("tool_execution_start", { toolName: "read", toolCallId: "read", args: { path: "value.cjs" } }); await emit("tool_call", { toolName: "read", toolCallId: "read", input: { path: "value.cjs" } }); await emit("tool_execution_end", { toolName: "read", toolCallId: "read", result: { content: [{ type: "text", text: "module.exports = 1;" }] }, isError: false }); };
	const explore = async () => { await readReference(); await action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor actual" }], findings: ["Devuelve 1"], approach: "Corregir el valor", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } }); await action({ action: "inferences", inferences: [] }); };
	const plan = (size: "small" | "large" = "small", causeKnown = true): Plan => ({ classification: { type: "fix", size, risk: "low", riskAreas: [], causeKnown }, objective: "Devolver 2", approach: "Corregir el valor exportado", scope: ["valor"], outOfScope: ["infra"], cases: [{ id: "D1", description: "Devuelve 2", command: "node test.cjs" }, ...(size === "large" ? [{ id: "D2", description: "Otro devuelve 2", command: "node other-test.cjs" }] : [])], lenses: ["quality"], executor: { mode: "inline", writers: 0 } });
	return { home, checkout, manager, runner, remote, calls, statuses, selects, editors, asked, permissionScreens, activeTools: () => activeTools, prompts, confirmationDetails, messages, progress, modelCalls, modelControl, uiControl, reviewScreens, reviews: () => reviews, tools, context, emit, emitBus, attach, invoke, action, state, readReference, explore, plan, command: (input: string) => commands.get("omi-work")!.handler(input, context),
		/** Cualquier comando registrado, por ejemplo /omi-foundations. Falla si no existe. */
		run: (name: string, input = "") => { const command = commands.get(name); if (!command) throw new Error(`Comando no registrado: /${name}`); return command.handler(input, context); },
		// Lo que hace el panel de Issues o la tool del agente estando ya en el worktree del issue: un pedido de un solo uso y su sí.
		start: () => commands.get("omi-work")!.handler(`begin ${issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: manager.getSessionFile()!, request: { issue: 42 } })}`, context), write: (path: string, body: string) => writeFile(join(checkout.root, path), body) };
}
