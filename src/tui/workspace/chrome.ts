// Chrome del workspace: montaje de paneles y controles persistentes, sin cargar datos ni cambiar sesiones.
import { basename } from "node:path";
import type { CustomEditor, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { HStack, ScrollView, VStack, wrapTextWithAnsi, type Component, type Container, type TUI } from "@earendil-works/pi-tui";
import { Lines, PaintedDocument } from "./components.ts";
import { workspaceName, type GitSnapshot } from "./data.ts";
import { workspaceTabs, type WorkspaceView } from "./navigation.ts";
import { align, fit, surface, text } from "./presentation.ts";
import { footerStatus, type BranchPullRequest, type FooterStatus } from "./pull-request.ts";
import { reasoningDots } from "./indicators.ts";

type Action = () => void | Promise<void>;
interface NavigationActions { palette: Action; switchView: (view: WorkspaceView) => void }
interface HeaderSnapshot { theme: Theme; cwd: string; git: GitSnapshot | undefined; view: WorkspaceView }

export function workspaceHeader(snapshot: () => HeaderSnapshot, actions: NavigationActions): Component {
	return new Lines((width) => {
		const { theme: t, cwd, git, view } = snapshot(); const name = text(basename(git?.root ?? cwd));
		return [surface(t, align(t.bold(t.fg("accent", " > omi code")) + `  ·  ${name}`, t.fg("dim", width >= 90 ? "Ctrl K comandos  F4 lateral " : "Ctrl K comandos "), width), width, true),
			surface(t, workspaceTabs(width, view).map((tab) => tab.view === view ? t.fg("accent", t.bold(tab.label)) : t.fg("muted", tab.label)).join(""), width, true),
			t.fg("border", "─".repeat(Math.max(0, width)))];
	}, (event) => { if (event.type !== "click") return; if (event.y === 0 && event.x > event.width - 22) { void actions.palette(); return { handled: true }; } if (event.y === 1) { const tab = workspaceTabs(event.width, snapshot().view).find((item) => event.x >= item.start && event.x < item.end); if (tab) { actions.switchView(tab.view); return { handled: true }; } } return undefined; });
}

interface WelcomeSnapshot { theme: Theme; cwd: string; git: GitSnapshot | undefined; visible: boolean; modelShortcut: string }
export function workspaceWelcome(snapshot: () => WelcomeSnapshot, actions: NavigationActions & { showModel: Action }): Component {
	let commandStart = 8;
	return new Lines((width) => {
		const { theme: t, cwd, git, visible, modelShortcut } = snapshot();
		if (!visible) return [];
		const name = text(basename(git?.root ?? cwd));
		const identity = git ? `${text(git.branch)} · ${text(workspaceName(git))} · ${git.changeCount} cambios locales` : text(cwd);
		const description = wrapTextWithAnsi("La conversación aparece acá. Podés empezar escribiendo o abrir los comandos.", Math.max(1, width - 4));
		commandStart = 7 + description.length;
		const lines = ["", t.fg("accent", t.bold("omi code")), "", `¿Qué hacemos en ${name}?`, "", t.fg("muted", identity), ...description.map((line) => t.fg("muted", line)), "", t.fg("muted", "Ctrl K   Comandos"), t.fg("muted", `${modelShortcut}   Elegir modelo`), t.fg("muted", "Ctrl 4   Revisar cambios"), ""];
		return lines.map((line) => fit(`  ${line}`, width));
	}, (event) => { if (event.type !== "click") return; if (event.y === commandStart) void actions.palette(); else if (event.y === commandStart + 1) void actions.showModel(); else if (event.y === commandStart + 2) actions.switchView("changes"); else return; return { handled: true }; });
}

interface FooterSnapshot {
	theme: Theme;
	state: string;
	blocked: boolean;
	git: GitSnapshot | undefined;
	context: { label: string; percent: number | undefined };
	sidebar: boolean;
	extra: string;
	model: { name: string; provider: string } | undefined;
	thinking: string;
	modelShortcut: string;
	pr: BranchPullRequest | undefined;
	prStale: boolean;
}
interface FooterActions { openPr: (pr: BranchPullRequest) => Promise<void>; showModel: Action; palette: Action; showContext: Action; showWorkspace: Action }
function statusAt(snapshot: FooterSnapshot, width: number): FooterStatus {
	const { theme: t, state, blocked, git, context, sidebar, extra, pr, prStale } = snapshot;
	const left = ` ${t.fg(blocked ? "warning" : "success", "●")} ${text(state)} · ${text(workspaceName(git))}${git ? ` · ${text(git.branch)}` : ""}`;
	const hint = sidebar ? extra || "Ctrl 1–6 vistas · /omi" : `Contexto ${context.label}${context.percent === undefined ? "" : ` · ${context.percent.toFixed(0)}%`}`;
	return footerStatus(t, left, hint, width, pr, prStale);
}
export function workspaceFooter(snapshot: (width: number) => FooterSnapshot, actions: FooterActions): Component {
	let pressedPr: BranchPullRequest | undefined;
	return new Lines((width) => {
		const current = snapshot(width); const { theme: t, model, thinking, modelShortcut } = current;
		const statusLine = statusAt(current, width).line;
		const name = model ? text(model.name) : "Sin modelo";
		const modelName = fit(name, Math.min(name.length, Math.max(0, width - 9)));
		const effort = `${reasoningDots(t, thinking)} ${thinking}`;
		const details = !model ? " · /login" : width >= 110 ? `  ·  ${text(model.provider)}  ·  Razonamiento: ${effort}  ·  ${modelShortcut} cambiar` : width >= 70 ? `  ·  ${effort}  ·  ${modelShortcut} cambiar` : ` · ${modelShortcut}`;
		return [t.fg("border", "─".repeat(width)), surface(t, statusLine, width, true), surface(t, t.fg("muted", " Modelo: ") + t.fg("accent", t.bold(modelName)) + t.fg("muted", details), width, true)];
	}, (event) => {
		if (event.button === "right" || event.button === "middle") return;
		// Calcular con el ancho del evento: una medición de layout no debe alterar los hit targets.
		const current = snapshot(event.width); const status = statusAt(current, event.width);
		const onPr = event.y === 1 && status.prStart !== undefined && event.x >= status.prStart && event.x < (status.prEnd ?? 0);
		if (event.type === "press") {
			pressedPr = onPr ? current.pr : undefined;
			// El clic completo pertenece al botón, no al fallback OSC 8 best-effort del renderer.
			return pressedPr ? { handled: true, render: false } : undefined;
		}
		if (event.type === "drag") { if (pressedPr) { pressedPr = undefined; return { handled: true, render: false }; } return; }
		if (event.type !== "click") return;
		const targetPr = pressedPr ?? (onPr ? current.pr : undefined); pressedPr = undefined;
		if (targetPr) { if (targetPr.url === current.pr?.url) void actions.openPr(targetPr); }
		else if (event.y === 2) void actions.showModel();
		else if (event.y === 1 && event.x >= status.hintStart) { if (current.sidebar) void actions.palette(); else void actions.showContext(); }
		else if (event.y === 1 && event.x < status.workspaceEnd) void actions.showWorkspace();
		return { handled: true };
	});
}

interface TranscriptParts { document: Component; workspaceDocument: Component; pending: Component; status: Component; above: Component; editor: Container; below: Component; footer: Component }
export function transcriptRoots(parts: TranscriptParts, theme: () => Theme, rows: () => number): { projectRoot: Component; baseRoot: Component } {
	const { document, workspaceDocument, pending, status, above, editor, below, footer } = parts;
	const dock = new VStack([pending, status, above, { component: editor, shrink: 1, minSize: 3 }, below]);
	const content = new PaintedDocument(workspaceDocument, theme, (width) => Math.max(0, rows() - 6 - dock.render(width).length));
	const transcript = new ScrollView(content, { follow: "end", primary: true, scrollbar: "auto" });
	return {
		projectRoot: new VStack([{ component: transcript, basis: 0, grow: 1, minSize: 1 }, { component: dock, basis: "auto", shrink: 1, minSize: 3 }]),
		baseRoot: new VStack([{ component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 }, dock, footer]),
	};
}
export function workspaceRoot(parts: { header: Component; main: Component; sidebar: Component; footer: Component }, sidebarVisible: (width: number, height: number) => boolean): Component {
	const { header, main, sidebar, footer } = parts;
	return new VStack([{ component: header, basis: 3, shrink: 0 }, { component: new HStack([{ component: main, basis: 0, grow: 1, minSize: 20 }, { component: sidebar, basis: 41, shrink: 0, visible: (viewport) => sidebarVisible(viewport.width, viewport.height) }]), basis: 0, grow: 1, minSize: 1 }, { component: footer, basis: "auto", shrink: 0 }]);
}

interface EditorActions { theme: () => Theme; showModel: (query?: string) => Promise<void>; shortcut: (value: string) => void }
export function workspaceEditor(BaseEditor: typeof CustomEditor, actions: EditorActions): typeof CustomEditor {
	return class OmiEditor extends BaseEditor {
		private omiKeys: KeybindingsManager;
		constructor(ui: TUI, editorTheme: ConstructorParameters<typeof CustomEditor>[1], keys: KeybindingsManager) {
			super(ui, editorTheme, keys); this.omiKeys = keys;
			actions.shortcut((keys.getKeys("app.model.select")[0] ?? "/omi-model").replace(/\+/g, " ").replace(/\bctrl\b/g, "Ctrl").replace(/\bl\b/g, "L"));
		}
		protected override renderBottomBorder(width: number, hiddenLineCount: number): string { return hiddenLineCount ? super.renderBottomBorder(width, hiddenLineCount) : " ".repeat(width); }
		override render(width: number): string[] {
			return [...super.render(width), actions.theme().fg("muted", " Enter enviar · /omi comandos")].map((line) => surface(actions.theme(), line, width));
		}
		override handleInput(data: string): void {
			if (this.omiKeys.matches(data, "app.model.select")) { void actions.showModel(); return; }
			const value = this.getText().trim();
			if (this.omiKeys.matches(data, "tui.input.submit") && /^\/model(?:\s|$)/.test(value)) { this.setText(""); void actions.showModel(value.slice(6).trim()); return; }
			super.handleInput(data);
		}
	};
}
