import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, parseColor, stripTerminalSequences, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
// Mismo contrato versionado que el adaptador de OMI, sin emular el algoritmo de layout.
import { getLayoutBoxesAt, renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { workspaceExtension } from "../src/tui/workspace/index.ts";
import { bar } from "../src/tui/workspace/presentation.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { linkedProject } from "./helpers/project.ts";
import { WORKSPACE_VIEWS, workspaceTabs } from "../src/tui/workspace/navigation.ts";

const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value, style: (value: string) => value } as unknown as Theme;

async function visualHarness(home: string, options: { cwd?: string; trusted?: boolean; online?: boolean; paletteAction?: string } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let root: Component | undefined; let focus: Component | undefined; let hasMessages = false; let unknownUsage = false; let approveSensitive = false;
	const prompts: string[] = []; const confirmations: string[] = []; const paletteOptions: string[][] = [];
	let terminalInput: ((data: string) => unknown) | undefined;
	const commands = new Map<string, { handler: () => Promise<void> }>();
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
		mode: "tui", cwd: options.cwd ?? home, model: { name: "Modelo real", provider: "proveedor-real", contextWindow: 200000 }, thinkingLevel: "high",
		scopedModels: [], modelRegistry: { getAvailable: () => [] }, isIdle: () => true, isProjectTrusted: () => options.trusted ?? false,
		sessionManager: { getBranch: () => hasMessages ? [{ type: "message" }] : [] },
		getContextUsage: () => unknownUsage ? undefined : { tokens: 56000, contextWindow: 200000, percent: 28 },
		ui: {
			theme, getTheme: () => undefined, setHeader() {}, getEditorComponent: () => undefined,
			setFooter: (factory: (ui: TUI, theme: Theme, data: unknown) => Component) => footer.addChild(factory(ui, theme, { getExtensionStatuses: () => new Map() })),
			setEditorComponent: (factory: (ui: TUI, theme: unknown, keys: unknown) => Component) => editor.addChild(factory(ui, { borderColor: (value: string) => value }, { getKeys: () => ["ctrl+l"], matches: () => false })),
			onTerminalInput: (handler: (data: string) => unknown) => { terminalInput = handler; return () => { terminalInput = undefined; }; }, notify() {},
			select: async (_title: string, values: string[]) => { paletteOptions.push(values); return options.paletteAction; },
			confirm: async (title: string) => {
				confirmations.push(title); handlers.get("ui_prompt_start")?.({}, ctx); handlers.get("ui_prompt_end")?.({}, ctx);
				return approveSensitive;
			},
			custom: async (factory: (ui: TUI, theme: Theme, keys: unknown, done: () => void) => Component) => {
				handlers.get("ui_prompt_start")?.({}, ctx);
				prompts.push(factory(ui, theme, {}, () => {}).render(90).map(stripTerminalSequences).join("\n"));
				handlers.get("ui_prompt_end")?.({}, ctx);
			},
		},
	} as unknown as ExtensionContext;
	const extension = workspaceExtension(testIo({ cwd: options.cwd ?? home, homeDir: home, env: {} }), options.online ? [] : ["--offline"]);
	if (typeof extension === "function") throw new Error("expected named extension");
	await extension.factory({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: (name: string, command: { handler: () => Promise<void> }) => commands.set(name, command), getSettings: () => ({}), registerMarkdownTransformer() {} } as never);
	await handlers.get("session_start")!({}, ctx);
	return {
		resources, chat, prompts, confirmations, commands, paletteOptions,
		terminal: (data: string) => terminalInput?.(data),
		click: (x: number, y: number, width = 132, height = 40) => {
			Object.assign(ui.terminal, { columns: width, rows: height }); const frame = renderLayoutFrame(root!, width, height, () => {});
			const box = getLayoutBoxesAt(frame, x, y).find((candidate) => candidate.component.handleMouse);
			return box?.component.handleMouse?.({ type: "click", x: x - box.rect.x, y: y - box.rect.y, width: box.rect.width, height: box.rect.height } as never);
		},
		command: (name: string) => commands.get(name)!.handler(),
		changes: () => commands.get("omi-changes")!.handler(),
		input: (data: string) => focus?.handleInput?.(data),
		approve: () => { approveSensitive = true; },
		frame: (width = 132, height = 40) => { Object.assign(ui.terminal, { columns: width, rows: height }); return renderLayoutFrame(root!, width, height, () => {}); },
		unknown: () => { unknownUsage = true; },
		messages: () => { hasMessages = true; chat.addChild(new Text("CONVERSACIÓN REAL", 0, 0)); },
		stop: async () => { await handlers.get("session_shutdown")!({}, ctx); },
	};
}

test("workspace_geometría real: Inicio, contexto justo sobre Equipo, cuatro barras y modelo en su propia fila", async (t) => {
	const ui = await visualHarness(await tempDir(t)); t.after(ui.stop);
	for (const [width, height] of [[132, 40], [160, 44], [110, 32], [110, 26]] as const) {
		const frame = ui.frame(width, height); const lines = frame.lines.map(stripTerminalSequences);
		assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /¿Qué hacemos en/); assert.doesNotMatch(lines.join("\n"), /HEADER INTERNO/);
		const side = lines.slice(3, -3).map((line) => Array.from(line).slice(width - 33).join(""));
		assert.ok(side.every((line) => line.startsWith("│")), `${width}x${height}`);
		const context = side.findIndex((line) => line.includes("CONTEXTO"));
		assert.match(side[context + 1]!, /56k \/ 200k tokens.*28%/);
		assert.match(side[context + 2]!, /█{30}/); assert.match(side[context + 4]!, /EQUIPO/);
		assert.equal(side.filter((line) => line.includes("█")).length, 4);
		assert.match(lines[height - 2]!, /Ctrl 1–5 vistas/); assert.doesNotMatch(lines.slice(-3).join("\n"), /Contexto|56k/);
		assert.match(lines[height - 1]!, /Modelo: Modelo real.*proveedor-real.*Razonamiento: high.*Ctrl L cambiar/);
		assert.match(lines[height - 4]!, /Enter enviar/);
	}
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
	for (const title of ["PROYECTO", "GITHUB", "OMI", "CONTEXTO", "EQUIPO"]) assert.ok(screen().includes(`▌ ${title}`));
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
		assert.doesNotMatch(lines.join("\n"), /Entregas|ENTREGAS|GITHUB ACTIONS/);
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
	const data = { issue: [issue(1, "ISSUE_FIRST"), issue(2, "ISSUE_SECOND")], pr: [{ ...issue(7, "PR_OPEN"), isDraft: true, headRefName: "feature", baseRefName: "main" }], failPr: false };
	await writeFile(dataPath, JSON.stringify(data));
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && data.failPr) process.exit(1);
console.log(JSON.stringify(args[1] === 'view' ? {body: 'DETAIL_' + args[0] + '_' + args[2]} : data[args[0]]));\n`, { mode: 0o755 });
	const previousPath = process.env.PATH; process.env.PATH = bin + delimiter + (previousPath ?? "");
	let ui: Awaited<ReturnType<typeof visualHarness>> | undefined;
	t.after(async () => { await ui?.stop(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
	const service = linked.project.services.get("api")!; service.view.environments[0]!.state = "running"; service.view.environments[0]!.current_version = "1.2.3";
	ui = await visualHarness(linked.home, { cwd: linked.repo, trusted: true, online: true }); const app = ui;
	const screen = () => app.frame().lines.map(stripTerminalSequences).join("\n");
	async function waitFor(test: () => boolean): Promise<void> { for (let i = 0; i < 120; i++) { if (test()) return; await setTimeout(25); } assert.ok(test(), screen()); }
	await app.command("omi-issues"); await waitFor(() => screen().includes("ISSUE_SECOND"));
	assert.doesNotMatch(screen(), /PR_OPEN/); app.input("\x1b[B"); app.input("\r");
	await waitFor(() => !!app.prompts.at(-1)?.includes("DETAIL_issue_2"));
	assert.match(app.prompts.at(-1)!, /Issue #2/); assert.match(screen(), /\[2 Issues\]/);
	await app.command("omi-prs"); await waitFor(() => screen().includes("PR_OPEN"));
	assert.match(screen(), /borrador/); assert.doesNotMatch(screen(), /ISSUE_FIRST|ISSUE_SECOND/); app.input("\r");
	await waitFor(() => !!app.prompts.at(-1)?.includes("DETAIL_pr_7")); assert.match(app.prompts.at(-1)!, /feature → main/); assert.match(screen(), /\[3 PRs\]/);
	await app.command("omi-platform"); await waitFor(() => screen().includes("1.2.3"));
	assert.match(screen(), /acme\/tienda/); assert.match(screen(), /SERVICIOS Y AMBIENTES/); assert.match(screen(), /stage.*1\.2\.3.*running/);
	assert.doesNotMatch(screen(), /ISSUE_FIRST|PR_OPEN|GITHUB ACTIONS/);
	assert.ok(linked.omi.requests.every((request) => request.method === "GET"), "la vista OMI no muta infraestructura");
	data.issue[0]!.title = "ISSUE_REFRESHED"; data.failPr = true; await writeFile(dataPath, JSON.stringify(data));
	await app.command("omi-issues"); app.input("r"); await waitFor(() => screen().includes("ISSUE_REFRESHED"));
	assert.match(screen(), /› #2 ISSUE_SECOND/, "se conserva el issue seleccionado al refrescar");
	await app.command("omi-prs"); await waitFor(() => screen().includes("datos desactualizados"));
	assert.match(screen(), /PR_OPEN/); assert.doesNotMatch(screen(), /No hay prs abiertos/);
	const beforeBlocked = await readFile(logPath, "utf8");
	for (const options of [{ trusted: true, online: false }, { trusted: false, online: true }]) {
		const blocked = await visualHarness(linked.home, { cwd: linked.repo, ...options });
		try {
			await blocked.command("omi-issues"); await setTimeout(40);
			const lines = blocked.frame().lines.map(stripTerminalSequences).join("\n");
			assert.match(lines, options.online ? /Proyecto sin confianza/ : /Offline/); assert.doesNotMatch(lines, /No hay issues abiertos/);
		} finally { await blocked.stop(); }
	}
	assert.equal(await readFile(logPath, "utf8"), beforeBlocked, "offline o sin confianza no llama a gh");
	const calls = beforeBlocked.trim().split("\n").map((line) => JSON.parse(line) as string[]);
	assert.ok(calls.every((args) => (args[0] === "issue" || args[0] === "pr") && (args[1] === "list" || args[1] === "view")));
	for (const args of calls.filter((args) => args[1] === "list")) { assert.ok(args.includes("open")); assert.ok(!args.includes("--branch")); }
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
