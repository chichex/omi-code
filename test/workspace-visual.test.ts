import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager, type ExtensionCommandContext, type ExtensionContext, type SessionEntry, type SessionHeader, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getOsc8LinkAtColumn, parseColor, sliceByColumn, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
// Mismo contrato versionado que el adaptador de OMI, sin emular el algoritmo de layout.
import { getLayoutBoxesAt, renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { bar } from "../src/tui/workspace/presentation.ts";
import { OmiCommandPalette, OmiInfoModal } from "../src/tui/workspace/modals.ts";
import { createIssueWorktree } from "../src/tui/workspace/issue-worktree.ts";
import { ISSUE_TRIAGE_ENTRY, issueTriageState, type IssueTriage } from "../src/tui/workspace/issue-triage.ts";
import { prepareIssue } from "../src/tui/workspace/issue-preparation.ts";
import { readGit, type GithubItem } from "../src/tui/workspace/data.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { linkedProject } from "./helpers/project.ts";
import { WORKSPACE_VIEWS, workspaceTabs } from "../src/tui/workspace/navigation.ts";

const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value, style: (value: string) => value, getColorMode: () => "truecolor" } as unknown as Theme;

async function visualHarness(home: string, options: { cwd?: string; trusted?: boolean; online?: boolean; paletteAction?: string; browserCode?: number; theme?: Theme; entries?: SessionEntry[]; detailKey?: string; sessionFile?: string; sessionDir?: string; sessionHeader?: SessionHeader } = {}) {
	const activeTheme = options.theme ?? theme;
	const modals: { lines: string[]; width: number; dispatchedBefore: number }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let root: Component | undefined; let focus: Component | undefined; let hasMessages = false; let unknownUsage = false; let approveSensitive = false;
	const prompts: string[] = []; const confirmations: string[] = []; const paletteOptions: string[][] = []; const notices: string[] = [];
	const browserCalls: { command: string; args: string[]; options: { cwd?: string; timeout?: number } }[] = [];
	const dispatched: { text: string; options: unknown }[] = []; const switches: string[] = []; let authChecks = 0;
	let entries = options.entries;
	let terminalInput: ((data: string) => unknown) | undefined;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const resources = new Container(); const chat = new Container(); const document = new Container();
	// El header viejo, sus márgenes y anuncios técnicos no deben ocupar el centro.
	document.addChild(new Text("HEADER INTERNO", 0, 1)); document.addChild(resources); document.addChild(chat);
	const editor = new Container(); const footer = new Container();
	const ui = {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true, mode: "fullscreen", terminal: { columns: 132, rows: 40 },
		children: [document, new Container(), new Container(), new Container(), editor, new Container(), footer],
		requestRender() {}, setLayoutRoot: (next: Component) => { root = next; }, hasOverlay: () => false, setFocus: (component: Component) => { focus = component; },
	} as unknown as TUI;
	const ctx = {
		mode: "tui", cwd: options.cwd ?? home, model: { id: "real", name: "Modelo real", provider: "proveedor-real", contextWindow: 200000 }, thinkingLevel: "high",
		scopedModels: [], modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => { authChecks++; return false; } }, isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => options.trusted ?? false,
		switchSession: async (file: string) => { switches.push(file); return { cancelled: true }; },
		sessionManager: { getBranch: () => entries ?? (hasMessages ? [{ type: "message" }] : []), getSessionFile: () => options.sessionFile, getHeader: () => options.sessionHeader },
		getContextUsage: () => unknownUsage ? undefined : { tokens: 56000, contextWindow: 200000, percent: 28 },
		ui: {
			theme: activeTheme, getTheme: () => undefined, setHeader() {}, getEditorComponent: () => undefined,
			setFooter: (factory: (ui: TUI, theme: Theme, data: unknown) => Component) => footer.addChild(factory(ui, activeTheme, { getExtensionStatuses: () => new Map() })),
			setEditorComponent: (factory: (ui: TUI, theme: unknown, keys: unknown) => Component) => editor.addChild(factory(ui, { borderColor: (value: string) => value }, { getKeys: () => ["ctrl+l"], matches: () => false })),
			onTerminalInput: (handler: (data: string) => unknown) => { terminalInput = handler; return () => { terminalInput = undefined; }; }, notify: (message: string) => notices.push(message),
			select: async (_title: string, values: string[]) => { paletteOptions.push(values); return options.paletteAction; },
			confirm: async (title: string) => {
				confirmations.push(title); handlers.get("ui_prompt_start")?.({}, ctx); handlers.get("ui_prompt_end")?.({}, ctx);
				return approveSensitive;
			},
			custom: async (factory: (ui: TUI, theme: Theme, keys: unknown, done: (value?: unknown) => void) => Component, displayOptions?: { overlayOptions: () => { width: number } }) => {
				handlers.get("ui_prompt_start")?.({}, ctx);
				let result: unknown;
				const component = factory(ui, activeTheme, { matches: () => false }, (value) => { result = value; });
				const width = displayOptions?.overlayOptions().width ?? 90; const lines = component.render(width);
				modals.push({ lines, width, dispatchedBefore: dispatched.length }); prompts.push(lines.map(stripTerminalSequences).join("\n"));
				if (component instanceof OmiCommandPalette) {
					paletteOptions.push(component.items.map((item) => item.label));
					const index = component.items.findIndex((item) => item.value === options.paletteAction);
					if (index >= 0) { for (let i = 0; i < index; i++) component.handleInput("\x1b[B"); component.handleInput("\r"); }
				}
				if (component instanceof OmiInfoModal && options.detailKey) component.handleInput(options.detailKey);
				handlers.get("ui_prompt_end")?.({}, ctx);
				return result;
			},
		},
	} as unknown as ExtensionContext;
	const extension = workspaceExtension(testIo({ cwd: options.cwd ?? home, homeDir: home, env: {} }), [...(options.online ? [] : ["--offline"]), ...(options.sessionDir ? ["--session-dir", options.sessionDir] : [])]);
	if (typeof extension === "function") throw new Error("expected named extension");
	await extension.factory({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command), getSettings: () => ({}), registerMarkdownTransformer() {}, sendUserMessage: (text: string, options: unknown) => dispatched.push({ text, options }), exec: async (command: string, args: string[], execOptions = {}) => { browserCalls.push({ command, args, options: execOptions }); return { code: options.browserCode ?? 0, stdout: "", stderr: "" }; } } as never);
	await handlers.get("session_start")!({}, ctx);
	return {
		resources, chat, prompts, confirmations, commands, paletteOptions, browserCalls, notices, modals, dispatched, switches, authChecks: () => authChecks,
		restore: (next: SessionEntry[]) => { entries = next; handlers.get("session_tree")?.({}, ctx); },
		terminal: (data: string) => terminalInput?.(data),
		click: (x: number, y: number, width = 132, height = 40) => {
			Object.assign(ui.terminal, { columns: width, rows: height }); const frame = renderLayoutFrame(root!, width, height, () => {});
			const box = getLayoutBoxesAt(frame, x, y).find((candidate) => candidate.component.handleMouse);
			return box?.component.handleMouse?.({ type: "click", x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height } as never);
		},
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx as ExtensionCommandContext),
		changes: () => commands.get("omi-changes")!.handler("", ctx as ExtensionCommandContext),
		input: (data: string) => focus?.handleInput?.(data),
		approve: () => { approveSensitive = true; },
		frame: (width = 132, height = 40) => { Object.assign(ui.terminal, { columns: width, rows: height }); return renderLayoutFrame(root!, width, height, () => {}); },
		unknown: () => { unknownUsage = true; },
		messages: () => { hasMessages = true; chat.addChild(new Text("CONVERSACIÓN REAL", 0, 0)); },
		stop: async () => { await handlers.get("session_shutdown")!({}, ctx); },
	};
}

test("workspace_todos los modales propios usan el marco común y el color de su sección", async (t) => {
	const theme = getThemeByName("dark")!;
	const ui = await visualHarness(await tempDir(t), { theme }); t.after(ui.stop);
	for (const [command, color, limit] of [["omi-workspace", "syntaxType", 104], ["omi-pr", "mdLink", 104], ["omi-actions", "mdLink", 104],
		["omi-context", "warning", 104], ["omi-resources", "syntaxVariable", 104], ["omi-model", "accent", 112], ["omi", "accent", 76]] as const) {
		await ui.command(command);
		const modal = ui.modals.at(-1)!;
		assert.equal(modal.width, limit); assert.ok(modal.lines.every((line) => visibleWidth(line) === limit));
		assert.ok(modal.lines[0]!.includes(theme.getFgAnsi(color)), command);
		assert.match(stripTerminalSequences(modal.lines[1]!), /▌/); assert.ok(modal.lines[1]!.includes("\x1b[1m"));
		assert.match(stripTerminalSequences(modal.lines.at(-1)!), /└.*┘$/);
	}
	ui.frame(40, 16); await ui.command("omi-pr");
	assert.equal(ui.modals.at(-1)!.width, 36, "el ancho se recalcula al achicar el pane");
	assert.ok(ui.modals.at(-1)!.lines.length <= 14);
});

test("workspace_geometría real: Inicio, contexto justo sobre Equipo, cuatro barras y modelo en su propia fila", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	for (const [width, height] of [[132, 40], [160, 70], [110, 32], [110, 26]] as const) {
		const frame = ui.frame(width, height); const lines = frame.lines.map(stripTerminalSequences);
		assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /¿Qué hacemos en/); assert.doesNotMatch(lines.join("\n"), /HEADER INTERNO/);
		const side = lines.slice(3, -3).map((line) => Array.from(line).slice(width - 33).join(""));
		assert.ok(side.every((line) => line.startsWith("│")), `${width}x${height}`);
		for (const title of ["PROYECTO", "GITHUB ACTIONS", "OMI", "CONTEXTO", "EQUIPO"]) assert.ok(side.some((line) => line.includes(`▌ ${title}`)), `${width}x${height}: ${title}`);
		assert.ok(side.some((line) => line.includes("Claude reviews"))); assert.ok(side.some((line) => line.includes("Releases")));
		const context = side.findIndex((line) => line.includes("CONTEXTO"));
		const omi = side.findIndex((line) => line.includes("▌ OMI"));
		assert.equal(context - omi, 3, "no queda un hueco creciente entre OMI y Contexto");
		assert.match(side[context + 1]!, /56k \/ 200k tokens.*28%/);
		assert.match(side[context + 2]!, /█{30}/); assert.match(side[context + 4]!, /EQUIPO/);
		assert.equal(side.filter((line) => line.includes("█")).length, 4);
		assert.match(lines[height - 2]!, /Ctrl 1–5 vistas/); assert.doesNotMatch(lines.slice(-3).join("\n"), /Contexto|56k/);
		assert.match(lines[height - 1]!, /Modelo: Modelo real.*proveedor-real.*Razonamiento: high.*Ctrl L cambiar/);
		assert.match(lines[height - 4]!, /Enter enviar/);
	}
});

test("workspace_el espacio libre al final de la lateral no abre detalles al hacer clic", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	const lines = ui.frame(132, 70).lines.map(stripTerminalSequences);
	const end = lines.findIndex((line) => line.includes("Detalles del host >"));
	assert.ok(end > 0 && end < 65);
	ui.click(120, end + 2, 132, 70);
	ui.click(70, 68, 132, 70); // Padding del pie, fuera del texto de ubicación y del acceso derecho.
	assert.equal(ui.prompts.length, 0);
});

test("workspace_lateral refresca commits, distingue ceros reales de referencia ausente y abre la explicación", async (t) => {
	const home = await tempDir(t);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: home, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(home, "file.txt"), "initial\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
	git("remote", "add", "origin", "."); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("branch", "--set-upstream-to=origin/main");
	await writeFile(join(home, "file.txt"), "changed\n");
	const ui = await visualHarness(home, { paletteAction: "Actualizar datos" }); t.after(ui.stop);
	const screen = () => ui.frame().lines.map(stripTerminalSequences).join("\n");
	async function waitFor(expected: RegExp): Promise<void> {
		for (let i = 0; i < 120; i++) { if (expected.test(screen())) return; await setTimeout(25); }
		assert.match(screen(), expected);
	}
	await waitFor(/1 archivos · Al día \(local\)/); assert.doesNotMatch(screen(), /↑0 ↓0/);
	for (const title of ["PROYECTO", "GITHUB ACTIONS", "OMI", "CONTEXTO", "EQUIPO"]) assert.ok(screen().includes(`▌ ${title}`));
	assert.doesNotMatch(screen(), /┌ GitHub Actions/); assert.match(screen(), /Claude reviews/); assert.match(screen(), /Releases/);
	for (const height of [26, 40]) {
		const side = ui.frame(132, height).lines.map((line) => stripTerminalSequences(sliceByColumn(line, 99, 33)));
		const actionsY = side.findIndex((line) => line.includes("Claude reviews"));
		ui.click(120, height === 26 ? actionsY : actionsY + 1, 132, height);
		assert.match(ui.prompts.at(-1)!, /GitHub Actions/, "los errores Offline repetidos no cambian el destino del clic"); await Promise.resolve();
		ui.click(120, side.findIndex((line) => line.includes("▌ OMI")), 132, height);
		assert.match(ui.frame(132, height).lines.map(stripTerminalSequences)[1]!, /\[5 OMI\]/);
		await ui.command("omi-chat");
	}
	git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "local"); await ui.command("omi");
	await waitFor(/0 archivos · ↑1 ↓0/); await ui.command("omi-workspace");
	assert.match(ui.prompts.at(-1)!, /Upstream: origin\/main/); assert.match(ui.prompts.at(-1)!, /Commits: ↑1 ↓0/);
	assert.match(ui.prompts.at(-1)!, /último fetch/); assert.match(ui.prompts.at(-1)!, /git fetch/); assert.match(ui.prompts.at(-1)!, /archivos sin commit/);
	git("update-ref", "-d", "refs/remotes/origin/main"); await ui.command("omi"); await waitFor(/0 archivos · ↑— ↓—/);
	assert.doesNotMatch(screen(), /Al día|↑0 ↓0|sin upstream/);
	git("branch", "--unset-upstream"); await ui.command("omi"); await waitFor(/0 archivos · sin upstream/);
});

test("workspace_panes bajos y angostos conservan modelo y contexto sin lateral ni overflow", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	for (const [width, height] of [[109, 40], [132, 25], [80, 24], [40, 24], [28, 16]] as const) {
		const lines = ui.frame(width, height).lines.map(stripTerminalSequences);
		assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(lines.join("\n"), /CONTEXTO|EQUIPO/);
		assert.match(lines[height - 2]!, /Contexto/); assert.match(lines[height - 1]!, /Modelo: Modelo real/);
	}
	ui.unknown(); const lines = ui.frame(132, 40).lines.map(stripTerminalSequences);
	assert.match(lines.join("\n"), /— \/ 200k tokens/); assert.doesNotMatch(lines.join("\n"), /0 \/ 200k tokens/);
});

test("workspace_no tapa conversación ni diagnósticos y el clic abre el detalle correcto", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	ui.resources.addChild(new Text("DIAGNÓSTICO IMPORTANTE", 0, 0)); ui.messages();
	for (const [width, height] of [[132, 40], [110, 26], [80, 24]] as const) {
		const frame = ui.frame(width, height); const lines = frame.lines.map(stripTerminalSequences);
		assert.doesNotMatch(lines.join("\n"), /¿Qué hacemos/);
		assert.match(lines.join("\n"), /CONVERSACIÓN REAL/); assert.match(lines.join("\n"), /DIAGNÓSTICO IMPORTANTE/);
		const y = width >= 110 ? lines.findIndex((line) => line.includes("CONTEXTO")) : height - 2;
		const x = width - 8; const box = getLayoutBoxesAt(frame, x, y).find((box) => box.component.handleMouse);
		assert.ok(box);
		box.component.handleMouse!({ type: "click", x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height } as never);
		assert.match(ui.prompts.at(-1)!, /Ventana de contexto/);
		// Dejar finalizar el modal para poder abrir el siguiente.
		await Promise.resolve();
		if (width >= 110) {
			const resourceY = lines.findIndex((line) => line.includes("EQUIPO"));
			const resourceBox = getLayoutBoxesAt(frame, x, resourceY).find((box) => box.component.handleMouse)!;
			resourceBox.component.handleMouse!({ type: "click", x: x - resourceBox.rect.x, y: resourceY - resourceBox.rect.y, width: resourceBox.rect.width, height: resourceBox.rect.height } as never);
			assert.match(ui.prompts.at(-1)!, /Recursos · equipo donde corre OMI/); await Promise.resolve();
		}
		const modelBox = getLayoutBoxesAt(frame, 5, height - 1).find((box) => box.component.handleMouse)!;
		modelBox.component.handleMouse!({ type: "click", x: 5, y: height - 1 - modelBox.rect.y, width: modelBox.rect.width, height: modelBox.rect.height } as never);
		assert.match(ui.prompts.at(-1)!, /Elegir modelo · OMI/); await Promise.resolve();
	}
});

test("workspace_las cinco vistas funcionan por teclado, comandos, clic y Escape sin perder el chat", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop); ui.messages();
	assert.equal(ui.commands.has("omi-deliveries"), false);
	for (const width of [132, 80, 40, 28]) for (const [index, item] of WORKSPACE_VIEWS.entries()) {
		ui.terminal(`\x1b[${49 + index};5u`);
		let lines = ui.frame(width, 32).lines.map(stripTerminalSequences);
		assert.equal(lines.length, 32); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines[1]!.includes(`[${index + 1} ${item.label}]`));
		const mainWidth = width - (width >= 110 ? 33 : 0);
		assert.doesNotMatch(lines.map((line) => sliceByColumn(line, 0, mainWidth)).join("\n"), /Entregas|ENTREGAS|GITHUB ACTIONS/);
		if (item.id === "chat") assert.match(lines.join("\n"), /CONVERSACIÓN REAL/);
		else assert.doesNotMatch(lines.slice(3, -3).join("\n"), /Enter enviar|CONVERSACIÓN REAL/);
		const next = WORKSPACE_VIEWS[(index + 1) % 5]!; const tab = workspaceTabs(width, item.id).find((tab) => tab.view === next.id)!;
		ui.click(tab.start, 1, width, 32);
		lines = ui.frame(width, 32).lines.map(stripTerminalSequences); assert.ok(lines[1]!.includes(`${(index + 1) % 5 + 1} ${next.label}]`));
		await ui.command(item.command); ui.frame(width, 32); ui.click(width - 1, 1, width, 32);
		assert.ok(ui.frame(width, 32).lines.map(stripTerminalSequences)[1]!.includes(`${index + 1} ${item.label}]`));
		if (item.id !== "chat") { ui.input("\x1b"); assert.match(ui.frame(width, 32).lines.map(stripTerminalSequences)[1]!, /\[1 Chat\]/); }
	}
	await ui.command("omi"); assert.deepEqual(ui.paletteOptions.at(-1)?.slice(0, 5), ["Chat", "Issues", "PRs", "Cambios", "OMI"]);
});

test("workspace_Issues, PRs y OMI tienen datos independientes, detalle seleccionado y errores sin inventar vacíos", { skip: process.platform === "win32" }, async (t) => {
	const linked = await linkedProject(t); const bin = join(linked.home, "mock-bin"); await mkdir(bin);
	execFileSync("git", ["init", "-b", "main"], { cwd: linked.repo, stdio: "ignore" });
	const dataPath = join(linked.home, "github.json"); const logPath = join(linked.home, "github-calls.jsonl");
	const issue = (number: number, title: string) => ({ number, title, author: { login: "ada" }, labels: [{ name: "ui" }], url: `https://github.com/test/repo/issues/${number}` });
	const data = { issue: [issue(1, "ISSUE_FIRST"), issue(2, "ISSUE_SECOND")], pr: [{ ...issue(7, "PR_OPEN"), isDraft: true, headRefName: "feature", baseRefName: "main" }], failPr: false, failRuns: false,
		currentBranch: { number: 9, title: "CURRENT_BRANCH_PR", url: "https://github.com/test/repo/pull/9", isDraft: true, state: "OPEN" } as { number: number; title: string; url: string; isDraft: boolean; state: string } | null };
	await writeFile(dataPath, JSON.stringify(data));
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && data.failPr) process.exit(1);
if (args[0] === 'pr' && args[1] === 'status') { console.log(JSON.stringify({currentBranch: data.currentBranch, createdBy: [], needsReview: []})); process.exit(0); }
if (args[0] === 'run') {
 if (data.failRuns) process.exit(1);
 const review = args.includes('claude-review.yml');
 console.log(JSON.stringify(Array.from({length: 3}, (_, index) => ({databaseId: (review ? 81 : 82) + index * 2, displayTitle: (review ? 'feat/herdr-status' : 'v0.4.0') + (index ? '-' + index : ''), status: 'completed', conclusion: 'success', createdAt: new Date(Date.now() - 42 * 60000).toISOString(), url: 'https://github.com/test/repo/actions/runs/81'})))); process.exit(0);
}
console.log(JSON.stringify(args[1] === 'view' ? {body: 'DETAIL_' + args[0] + '_' + args[2]} : data[args[0]]));\n`, { mode: 0o755 });
	const previousPath = process.env.PATH; process.env.PATH = bin + delimiter + (previousPath ?? "");
	let ui: Awaited<ReturnType<typeof visualHarness>> | undefined;
	t.after(async () => { await ui?.stop(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
	const service = linked.project.services.get("api")!; service.view.environments[0]!.state = "running"; service.view.environments[0]!.current_version = "1.2.3";
	ui = await visualHarness(linked.home, { cwd: linked.repo, trusted: true, online: true, paletteAction: "Actualizar datos" }); const app = ui;
	const screen = () => app.frame().lines.map(stripTerminalSequences).join("\n");
	async function waitFor(test: () => boolean): Promise<void> { for (let i = 0; i < 120; i++) { if (test()) return; await setTimeout(25); } assert.ok(test(), screen()); }
	await app.command("omi-issues"); await waitFor(() => screen().includes("ISSUE_SECOND"));
	await waitFor(() => screen().includes("feat/herdr-status") && screen().includes("v0.4.0"));
	assert.match(screen(), /✓ feat\/herdr-status.*42m/); assert.match(screen(), /✓ v0\.4\.0.*42m/);
	assert.doesNotMatch(screen(), /Copilot/);
	await waitFor(() => screen().includes("PR #9 ↗"));
	for (const width of [28, 40, 80, 132]) {
		const row = app.frame(width, 40).lines[38]!; const plain = stripTerminalSequences(row); const badge = "[ PR #9 ↗ ]"; const x = plain.indexOf(badge);
		assert.ok(x >= 0); assert.equal(getOsc8LinkAtColumn(row, x), "https://github.com/test/repo/pull/9");
		for (const offset of [0, 1, 2, badge.length - 2, badge.length - 1]) {
			const prompts = app.prompts.length; const calls = app.browserCalls.length;
			app.click(x + offset, 38, width, 40); await Promise.resolve();
			assert.equal(app.prompts.length, prompts, "ni el texto ni el padding abren otro modal"); assert.equal(app.browserCalls.length, calls + 1);
			assert.deepEqual(app.browserCalls.at(-1), { command: "gh", args: ["pr", "view", "https://github.com/test/repo/pull/9", "--web"], options: { cwd: linked.repo, timeout: 5000, maxBuffer: 8192 } });
		}
	}
	const footerPlain = stripTerminalSequences(app.frame().lines[38]!); const emptyX = footerPlain.indexOf("[ PR #9 ↗ ]") + "[ PR #9 ↗ ]".length + 5;
	const promptsBeforeEmptyClick = app.prompts.length; const callsBeforeEmptyClick = app.browserCalls.length;
	app.click(emptyX, 38); assert.equal(app.prompts.length, promptsBeforeEmptyClick); assert.equal(app.browserCalls.length, callsBeforeEmptyClick);
	await app.command("omi-pr"); assert.match(app.prompts.at(-1)!, /borrador/);
	// Si el launcher falla, mostrar una advertencia y el PR correcto con su URL, nunca Ubicación.
	const failed = await visualHarness(linked.home, { cwd: linked.repo, trusted: true, online: true, browserCode: 1 });
	try {
		for (let i = 0; i < 120 && !failed.frame().lines.map(stripTerminalSequences).join("\n").includes("PR #9"); i++) await setTimeout(25);
		const x = stripTerminalSequences(failed.frame().lines[38]!).indexOf("[ PR #9"); assert.ok(x >= 0); failed.click(x, 38);
		for (let i = 0; i < 120 && !failed.prompts.length; i++) await setTimeout(25);
		assert.match(failed.notices.join("\n"), /No se pudo abrir el navegador/);
		assert.match(failed.prompts.at(-1)!, /CURRENT_BRANCH_PR/); assert.match(failed.prompts.at(-1)!, /https:\/\/github.com\/test\/repo\/pull\/9/); assert.doesNotMatch(failed.prompts.at(-1)!, /Ubicación de trabajo/);
	} finally { await failed.stop(); }
	for (const height of [26, 28, 30, 32, 36, 40, 70]) {
		const side = app.frame(132, height).lines.slice(3, -3).map((line) => stripTerminalSequences(sliceByColumn(line, 99, 33)));
		for (const title of ["PROYECTO", "GITHUB ACTIONS", "OMI", "CONTEXTO", "EQUIPO"]) assert.ok(side.some((line) => line.includes(`▌ ${title}`)), `132x${height}: ${title}`);
		assert.ok(side.some((line) => line.includes("Claude reviews"))); assert.ok(side.some((line) => line.includes("Releases")));
		if (height === 26) assert.match(side.join("\n"), /Claude reviews.*✓ 42m.*\n.*Releases.*✓ 42m/);
		if (height === 70) assert.equal(side.filter((line) => line.includes("✓")).length, 6);
	}
	app.frame();
	await app.command("omi-actions"); assert.match(app.prompts.at(-1)!, /GitHub Actions/); assert.match(app.prompts.at(-1)!, /actions\/runs\/81/);
	const cardY = app.frame().lines.map(stripTerminalSequences).findIndex((line) => line.includes("Claude reviews"));
	app.click(120, cardY); assert.match(app.prompts.at(-1)!, /no significa aprobación/); await Promise.resolve();
	assert.doesNotMatch(screen(), /PR_OPEN/); app.input("\x1b[B"); app.input("\r");
	await waitFor(() => !!app.prompts.at(-1)?.includes("DETAIL_issue_2"));
	assert.match(app.prompts.at(-1)!, /Issue #2/); assert.match(screen(), /\[2 Issues\]/);
	await app.command("omi-prs"); await waitFor(() => screen().includes("PR_OPEN"));
	assert.match(screen(), /borrador/); assert.doesNotMatch(screen(), /ISSUE_FIRST|ISSUE_SECOND/); app.input("\r");
	await waitFor(() => !!app.prompts.at(-1)?.includes("DETAIL_pr_7")); assert.match(app.prompts.at(-1)!, /feature → main/); assert.match(screen(), /\[3 PRs\]/);
	await app.command("omi-platform"); await waitFor(() => screen().includes("1.2.3"));
	assert.match(screen(), /acme\/tienda/); assert.match(screen(), /SERVICIOS Y AMBIENTES/); assert.match(screen(), /stage.*1\.2\.3.*running/);
	assert.doesNotMatch(app.frame().lines.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 99))).join("\n"), /ISSUE_FIRST|PR_OPEN|GITHUB ACTIONS/);
	assert.ok(linked.omi.requests.every((request) => request.method === "GET"), "la vista OMI no muta infraestructura");
	data.issue[0]!.title = "ISSUE_REFRESHED"; data.failPr = true; data.failRuns = true; await writeFile(dataPath, JSON.stringify(data));
	await app.command("omi-issues"); app.input("r"); await waitFor(() => screen().includes("ISSUE_REFRESHED"));
	assert.match(screen(), /› #2 \[Sin triage\] ISSUE_SECOND/, "se conserva el issue seleccionado al refrescar");
	await app.command("omi-prs"); await waitFor(() => screen().includes("datos desactualizados"));
	assert.match(screen(), /PR_OPEN/); assert.doesNotMatch(screen(), /No hay prs abiertos/);
	await waitFor(() => screen().includes("Datos desactualizados"));
	await app.command("omi-actions"); assert.match(app.prompts.at(-1)!, /datos desactualizados/); assert.match(app.prompts.at(-1)!, /feat\/herdr-status/);
	await waitFor(() => screen().includes("PR #9* ↗"));
	await app.command("omi-pr"); assert.match(app.prompts.at(-1)!, /enlace desactualizado/);
	// El enlace anterior desaparece al cambiar de rama, aunque la lista global conserve otros PRs.
	data.currentBranch = null; data.failPr = false; await writeFile(dataPath, JSON.stringify(data));
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: linked.repo }); await app.command("omi");
	for (let i = 0; i < 120; i++) { await app.command("omi-pr"); if (app.prompts.at(-1)?.includes("No hay un PR asociado")) break; await setTimeout(25); }
	assert.match(app.prompts.at(-1)!, /Rama: other/); assert.match(app.prompts.at(-1)!, /No hay un PR asociado/);
	assert.doesNotMatch(screen(), /PR #9/);
	const beforeBlocked = await readFile(logPath, "utf8");
	for (const options of [{ trusted: true, online: false }, { trusted: false, online: true }]) {
		const blocked = await visualHarness(linked.home, { cwd: linked.repo, ...options });
		try {
			await blocked.command("omi-issues"); await setTimeout(40);
			const lines = blocked.frame().lines.map(stripTerminalSequences).join("\n");
			assert.match(lines, options.online ? /Proyecto sin confianza/ : /Offline/); assert.doesNotMatch(lines, /No hay issues abiertos/);
			await blocked.command("omi-pr"); assert.match(blocked.prompts.at(-1)!, options.online ? /Proyecto sin confianza/ : /Offline/); assert.doesNotMatch(blocked.prompts.at(-1)!, /No hay un PR asociado/);
		} finally { await blocked.stop(); }
	}
	assert.equal(await readFile(logPath, "utf8"), beforeBlocked, "offline o sin confianza no llama a gh");
	const calls = beforeBlocked.trim().split("\n").map((line) => JSON.parse(line) as string[]);
	assert.ok(calls.every((args) => (args[0] === "issue" || args[0] === "pr" || args[0] === "run") && (args[1] === "list" || args[1] === "view" || (args[0] === "pr" && args[1] === "status"))));
	assert.ok(calls.some((args) => args.includes("claude-review.yml"))); assert.ok(calls.some((args) => args.includes("release.yml")));
	for (const args of calls.filter((args) => args[0] !== "run" && args[1] === "list")) { assert.ok(args.includes("open")); assert.ok(!args.includes("--branch")); }
});

test("workspace_Cambios muestra líneas por archivo y conserva contadores al achicar el pane", async (t) => {
	const home = await tempDir(t); const path = "long-file-name-".repeat(12) + ".txt";
	const git = (...args: string[]) => execFileSync("git", args, { cwd: home, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(home, path), "initial\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
	await writeFile(join(home, path), "added\nsecond\n");
	const ui = await visualHarness(home); t.after(ui.stop); await ui.changes();
	for (let i = 0; i < 80 && !ui.frame().lines.some((line) => stripTerminalSequences(line).includes("+2 −1")); i++) await setTimeout(25);
	for (const width of [132, 80, 40, 28]) {
		const lines = ui.frame(width, 32).lines.map(stripTerminalSequences);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.some((line) => /…\s+\+2 −1/.test(line)), `${width}: ${lines.join("\n")}`);
	}
});

test("workspace_Enter abre archivos nuevos, confirma sensibles y vuelve a Cambios sin enviarlos al chat", async (t) => {
	const home = await tempDir(t);
	execFileSync("git", ["init", "-b", "main"], { cwd: home, stdio: "ignore" });
	await mkdir(join(home, "test")); await writeFile(join(home, "test/new.test.ts"), "SOURCE_PREVIEW_ONLY\n");
	await writeFile(join(home, "credentials.json"), "SENSITIVE_PREVIEW_ONLY\n");
	const ui = await visualHarness(home); t.after(ui.stop); await ui.changes();
	const screen = () => ui.frame().lines.map(stripTerminalSequences).join("\n");
	async function waitFor(expected: RegExp): Promise<void> {
		for (let i = 0; i < 80; i++) { if (expected.test(screen())) return; await setTimeout(25); }
		assert.match(screen(), expected);
	}
	await waitFor(/\?\? test\/new.test.ts/);
	assert.doesNotMatch(screen(), /SOURCE_PREVIEW_ONLY|SENSITIVE_PREVIEW_ONLY/);
	// Git ordena credentials.json antes de test/new.test.ts.
	ui.input("\x1b[B"); ui.input("\r");
	await waitFor(/SOURCE_PREVIEW_ONLY/); assert.match(screen(), /ARCHIVO NUEVO/); assert.equal(ui.confirmations.length, 0);
	ui.input("\x7f"); ui.input("\x1b[A"); ui.input("\r");
	await waitFor(/\?\? credentials.json/); assert.equal(ui.confirmations.length, 1); assert.doesNotMatch(screen(), /SENSITIVE_PREVIEW_ONLY/);
	ui.approve(); ui.input("\r"); await waitFor(/SENSITIVE_PREVIEW_ONLY/); assert.equal(ui.confirmations.length, 2);
	assert.match(screen(), /Cambios locales/); assert.doesNotMatch(screen(), /¿Qué hacemos en/);
	assert.equal(ui.chat.children.length, 0, "la previsualización nunca entra en la conversación");
});

test("workspace_barras sólidas: ancho y pista constante, también sin dato o en tema claro", () => {
	const calls: { used: string; track: string }[] = [];
	let used = "";
	const meterTheme = { ...theme, fg: (_role: string, value: string) => { used = value; return value; }, style: (value: string) => { calls.push({ used, track: value }); return value; } } as unknown as Theme;
	for (const percent of [undefined, -1, 0, 28, 80, 95, 100, 200]) {
		assert.equal(bar(meterTheme, percent, 30), "█".repeat(30));
	}
	assert.deepEqual(calls[0], { used: "", track: "█".repeat(30) }); assert.equal(calls[3]!.used.length, 8); assert.equal(calls.at(-1)!.track, "");
	assert.equal(bar(meterTheme, 50, 0), "");
	for (const appearance of ["dark", "light"] as const) {
		let trackColor: unknown;
		const colored = { ...meterTheme, appearance, style: (value: string, options: { fg: unknown }) => { trackColor = options.fg; return value; } } as unknown as Theme;
		bar(colored, 50, 10);
		assert.deepEqual(trackColor, parseColor(appearance === "light" ? "#d0d5d9" : "#292f34"));
	}
});

test("workspace_triage muestra issue y categoría debajo de recursos, incluso en panes bajos, y restaura sólo la rama activa", async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); await mkdir(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "file"), "main"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main");
	const issue = { number: 42, title: "ISSUE_ACTIVO 漢字", url: "https://github.com/test/repo/issues/42" } as GithubItem;
	const checkout = await createIssueWorktree((await readGit(root))!, issue, "feature");
	const triage: IssueTriage = { type: "feature", summary: "Nueva función", rationale: "Capacidad nueva", scope: [], acceptanceCriteria: [], questions: [] };
	const state = issueTriageState(issue, triage, checkout);
	const entries: SessionEntry[] = [{ type: "custom", customType: ISSUE_TRIAGE_ENTRY, data: state, id: "triage", parentId: null, timestamp: new Date().toISOString() }];
	const ui = await visualHarness(home, { cwd: checkout.worktree, entries }); t.after(ui.stop);
	for (let i = 0; i < 100 && !ui.frame().lines.map(stripTerminalSequences).some((line) => line.includes("Worktree")); i++) await setTimeout(20);
	for (const [width, height] of [[110, 26], [132, 28], [132, 32], [132, 34], [160, 70]] as const) {
		const frame = ui.frame(width, height); const side = frame.lines.slice(3, -3).map((line) => stripTerminalSequences(sliceByColumn(line, width - 33, 33)));
		assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
		assert.match(side.join("\n"), /ISSUE ACTIVO/); assert.match(side.join("\n"), /#42 · Nuevo feature/); assert.match(side.join("\n"), /ISSUE_ACTIVO 漢字/);
		const headings = ["PROYECTO", "GITHUB ACTIONS", "OMI", "CONTEXTO", "EQUIPO", "ISSUE ACTIVO"].map((title) => {
			const index = side.findIndex((line) => line.includes(`▌ ${title}`)); assert.ok(index >= 0, `${width}x${height}: ${title}`); return index;
		});
		assert.deepEqual(headings, [...headings].sort((a, b) => a - b), "Issue activo queda después de Equipo, no debajo de Proyecto");
		const issueY = headings.at(-1)!; const hostEnd = side.findIndex((line) => line.includes("Detalles del host >"));
		if (hostEnd >= 0) assert.equal(issueY, hostEnd + 2, "una línea separa los recursos del issue");
		const before = ui.prompts.length; ui.click(width - 5, issueY + 3, width, height);
		assert.equal(ui.prompts.length, before, "el issue no pertenece al área clickeable de recursos");
		for (const [title, expected] of [["GITHUB ACTIONS", /GitHub Actions/], ["CONTEXTO", /Ventana de contexto/], ["EQUIPO", /Recursos · equipo/]] as const) {
			const y = side.findIndex((line) => line.includes(`▌ ${title}`)) + 3;
			ui.click(width - 5, y, width, height); assert.match(ui.prompts.at(-1)!, expected); await Promise.resolve();
		}
	}
	ui.restore([]); assert.doesNotMatch(ui.frame().lines.map(stripTerminalSequences).join("\n"), /ISSUE ACTIVO|#42 · Nuevo feature/);
	ui.restore(entries); assert.match(ui.frame().lines.map(stripTerminalSequences).join("\n"), /#42 · Nuevo feature/);
	const other = await visualHarness(home, { cwd: root, entries });
	try { assert.doesNotMatch(other.frame().lines.map(stripTerminalSequences).join("\n"), /ISSUE ACTIVO|#42 · Nuevo feature/); } finally { await other.stop(); }
});

test("workspace_Enter en el detalle de un issue despacha triage; Esc y el detalle de PR siguen sin mutaciones", { skip: process.platform === "win32" }, async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); const bin = join(home, "bin"); await mkdir(root); await mkdir(bin);
	execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst args = process.argv.slice(2); if (args[0] === 'run') { console.log('[]'); } else if (args[1] === 'status') { console.log('{}'); } else { console.log(JSON.stringify(args[1] === 'view' ? {body: 'ISSUE_BODY'} : [{number: 42, title: 'ISSUE_TO_TRIAGE', url: 'https://github.com/test/repo/issues/42', labels: [], author: {login: 'ada'}}])); }\n`, { mode: 0o755 });
	const previous = process.env.PATH; process.env.PATH = bin + delimiter + (previous ?? ""); t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
	for (const key of ["\r", "\x1b"]) {
		const ui = await visualHarness(home, { cwd: root, trusted: true, online: true, detailKey: key });
		try {
			await ui.command("omi-issues");
			for (let i = 0; i < 100 && !ui.frame().lines.map(stripTerminalSequences).some((line) => line.includes("ISSUE_TO_TRIAGE")); i++) await setTimeout(20);
			ui.input("\r");
			for (let i = 0; i < 100 && !ui.prompts.length; i++) await setTimeout(20);
			for (let i = 0; i < 5; i++) await Promise.resolve();
			assert.match(ui.prompts.at(-1)!, /Enter iniciar triage/); assert.match(ui.prompts.at(-1)!, /main local/);
			assert.deepEqual(ui.dispatched, key === "\r" ? [{ text: "/omi-triage 42", options: { expandPromptTemplates: true } }] : []);
			const before = ui.dispatched.length; await ui.command("omi-prs"); ui.input("\r");
			for (let i = 0; i < 100 && !ui.prompts.at(-1)?.includes("PR #42"); i++) await setTimeout(20);
			assert.match(ui.prompts.at(-1)!, /PR #42/); assert.equal(ui.dispatched.length, before);
		} finally { await ui.stop(); }
	}
});

test("workspace_issue preparado: badges locales, Enter siempre detalle, Esc no cambia y el segundo Enter retoma o permanece en la sesión actual", { skip: process.platform === "win32" }, async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); const bin = join(home, "bin"); await mkdir(root); await mkdir(bin);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "main.txt"), "main"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main");
	const item: GithubItem = { number: 42, title: "ISSUE_PREPARED", author: "ada", labels: ["bug"], url: "https://github.com/test/repo/issues/42", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const triage: IssueTriage = { type: "fix", summary: "Corregir", rationale: "Bug", scope: [], acceptanceCriteria: [], questions: [] };
	const sessionDir = join(home, "sessions"); const parent = SessionManager.create(root, join(home, "parent"));
	const result = (await prepareIssue((await readGit(root))!, 42, item, { sessionManager: parent } as unknown as ExtensionContext, {
		sessionDir, signal: new AbortController().signal, isCurrent: () => true,
		classify: async () => ({ triage, body: "ISSUE_SAVED_BODY", provider: "mock", model: "triage", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } }),
	}))!;
	const { state, sessionFile } = result.record; const conversation = await readFile(sessionFile!, "utf8");
	await writeFile(join(state.worktree, "keep"), "Trabajo sin commit");
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst args = process.argv.slice(2); console.log(JSON.stringify(args[0] === 'run' ? [] : args[1] === 'status' ? {} : args[1] === 'view' ? {body:'ISSUE_BODY'} : [{number:42,title:'ISSUE_PREPARED',url:'https://github.com/test/repo/issues/42',labels:[{name:'bug'}],author:{login:'ada'}},{number:43,title:'ISSUE_FRESH',url:'https://github.com/test/repo/issues/43',labels:[],author:{login:'ada'}}]));\n`, { mode: 0o755 });
	const previous = process.env.PATH; process.env.PATH = bin + delimiter + (previous ?? ""); t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
	for (const here of [false, true]) for (const key of ["\x1b", "\r"]) {
		const ui = await visualHarness(home, { cwd: here ? state.worktree : root, trusted: true, online: true, sessionDir, detailKey: key,
			...(here ? { entries: SessionManager.open(sessionFile!).getBranch(), sessionFile: sessionFile! } : {}) });
		try {
			await ui.command("omi-issues");
			for (let i = 0; i < 100 && !ui.frame().lines.map(stripTerminalSequences).join("\n").includes("[issue-42]"); i++) await setTimeout(20);
			assert.match(ui.frame().lines.map(stripTerminalSequences).join("\n"), /#42 \[Fix\] \[issue-42\] ISSUE_PREPARED/);
			assert.equal(ui.dispatched.length, 0); assert.equal(ui.authChecks(), 0, "abrir la lista no consulta el clasificador");
			ui.input("\r");
			for (let i = 0; i < 100 && !ui.prompts.length; i++) await setTimeout(20);
			for (let i = 0; i < 5; i++) await Promise.resolve();
			const detail = ui.prompts.at(-1)!;
			assert.match(detail, /Enter retomar worktree/); assert.match(detail, /Clasificación local: Fix/); assert.match(detail, /Rama: fix\/issue-42-issue-prepared/);
			assert.ok(detail.includes(state.worktree)); assert.match(detail, /Etiquetas GitHub: bug/); assert.equal(ui.modals.at(-1)!.dispatchedBefore, 0, "el Enter de la lista sólo abre el detalle");
			assert.equal(ui.dispatched.length, key === "\r" ? 1 : 0); assert.equal(ui.switches.length, 0);
			if (key === "\r") {
				await ui.command("omi-triage", "42");
				assert.deepEqual(ui.switches, here ? [] : [sessionFile]);
				assert.ok(ui.notices.some((message) => message.includes(here ? "Ya estás en la sesión" : "Cambio de sesión cancelado")));
			}
			assert.equal(ui.authChecks(), 0); assert.equal(await readFile(sessionFile!, "utf8"), conversation);
			assert.equal(await readFile(join(state.worktree, "keep"), "utf8"), "Trabajo sin commit");
			if (!here && key === "\x1b") {
				await ui.command("omi-triage", "43");
				assert.equal(ui.authChecks(), 1, "un issue nuevo sí exige modelo autenticado antes de clasificar");
				assert.ok(ui.notices.some((message) => message.includes("modelo autenticado")));
				assert.equal(git("branch", "--list", "*issue-43*"), "");
			}
		} finally { await ui.stop(); }
	}
	const offline = await visualHarness(home, { cwd: root, trusted: true, sessionDir });
	try {
		for (let i = 0; i < 100 && !offline.frame().lines.map(stripTerminalSequences).join("\n").includes("Repo principal"); i++) await setTimeout(20);
		await offline.command("omi-triage", "42"); assert.deepEqual(offline.switches, [sessionFile]); assert.equal(offline.authChecks(), 0);
	} finally { await offline.stop(); }
	// Ni el badge ni el detalle prometen retomar cuando falta la conversación guardada.
	await writeFile(sessionFile!, "sesión dañada");
	const broken = await visualHarness(home, { cwd: root, trusted: true, online: true, sessionDir, detailKey: "\r" });
	try {
		await broken.command("omi-issues");
		for (let i = 0; i < 100 && !broken.frame().lines.map(stripTerminalSequences).join("\n").includes("ISSUE_PREPARED"); i++) await setTimeout(20);
		broken.input("\r"); for (let i = 0; i < 100 && !broken.prompts.length; i++) await setTimeout(20);
		assert.match(broken.prompts.at(-1)!, /Recuperación pendiente/); assert.doesNotMatch(broken.prompts.at(-1)!, /Enter retomar worktree/);
		assert.equal(broken.dispatched.length, 0); assert.match(broken.frame().lines.map(stripTerminalSequences).join("\n"), /\[Fix\] \[Revisar\]/);
	} finally { await broken.stop(); }
});

test("workspace_main sólo ofrece volver en worktrees: paleta, Enter en Ubicación, Esc cancela y /omi-main retoma sin auth ni red", async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); await mkdir(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "main.txt"), "main"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main"); git("checkout", "-b", "root-branch");
	const tree = await createIssueWorktree((await readGit(root))!, { number: 42, title: "Test" }, "fix");
	const sessionDir = join(home, "sessions"); const original = SessionManager.create(root, sessionDir); original.appendMessage({ role: "user", content: "MAIN_ORIGINAL", timestamp: Date.now() });
	const issue = SessionManager.create(tree.worktree, sessionDir, { parentSession: original.getSessionFile()! }); issue.appendMessage({ role: "user", content: "ISSUE_INTACTO", timestamp: Date.now() });
	const originalText = await readFile(original.getSessionFile()!, "utf8");
	for (const key of ["\x1b", "\r"]) {
		const ui = await visualHarness(home, { cwd: tree.worktree, trusted: true, detailKey: key, sessionFile: issue.getSessionFile()!, sessionHeader: issue.getHeader()!, sessionDir, paletteAction: "Volver al repo principal" });
		try {
			for (let i = 0; i < 100 && !ui.frame().lines.map(stripTerminalSequences).join("\n").includes("Worktree"); i++) await setTimeout(20);
			await ui.command("omi-workspace"); assert.match(ui.prompts.at(-1)!, /Enter volver al repo/); assert.match(ui.prompts.at(-1)!, /no hace git checkout main/);
			assert.deepEqual(ui.dispatched, key === "\r" ? [{ text: "/omi-main", options: { expandPromptTemplates: true } }] : []); assert.equal(ui.switches.length, 0);
			await ui.command("omi"); assert.ok(ui.paletteOptions.at(-1)!.includes("Volver al repo principal")); assert.equal(ui.dispatched.at(-1)!.text, "/omi-main");
			await ui.command("omi-main"); await ui.command("omi-main"); assert.deepEqual(ui.switches, [original.getSessionFile(), original.getSessionFile()]);
			assert.ok(ui.notices.some((message) => message.includes("Regreso cancelado"))); assert.equal(ui.authChecks(), 0);
			assert.equal(await readFile(original.getSessionFile()!, "utf8"), originalText); assert.equal(git("branch", "--show-current"), "root-branch");
		} finally { await ui.stop(); }
	}
	const main = await visualHarness(home, { cwd: root, trusted: true, sessionDir, paletteAction: "Volver al repo principal" });
	try {
		for (let i = 0; i < 100 && !main.frame().lines.map(stripTerminalSequences).join("\n").includes("Repo principal"); i++) await setTimeout(20);
		await main.command("omi"); assert.ok(!main.paletteOptions.at(-1)!.includes("Volver al repo principal"));
		await main.command("omi-workspace"); assert.doesNotMatch(main.prompts.at(-1)!, /Enter volver al repo/);
		await main.command("omi-main"); assert.match(main.notices.at(-1)!, /Ya estás en el repo principal/); assert.equal(main.switches.length, 0); assert.equal(main.dispatched.length, 0);
	} finally { await main.stop(); }
});
