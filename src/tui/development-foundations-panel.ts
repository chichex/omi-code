// Panel de Foundations: cuándo pide confirmación el agente. Abre en las políticas; las reglas de comandos se
// editan aparte, con ejemplos. Sólo devuelve un borrador revisado; no persiste ni concede permisos.
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import {
	ASK_HELP, AUTO_WARNINGS, checkBlock, EMPTY_RULES_WARNING, foundationsDiff, MAX_RULES, ruleProblem, DEFAULT_POLICY, visibleText,
	type FoundationsBlock, type FoundationsPolicy, type PolicyPoint,
} from "../harness/foundations.ts";
import { FoundationsRulesEditor } from "./development-foundations-editor.ts";
import { commandDisplayLines } from "./development-approval.ts";

const POINTS: readonly PolicyPoint[] = ["arranque", "receta", "push_pr"];
const LABELS: Record<PolicyPoint, string> = { arranque: "Arranque", receta: "Receta", push_pr: "Push + PR draft" };
const RULES_ROW = 3; const SAVE = 4; const CANCEL = 5; const ROWS = 6; const PREVIEW = 3; const LABEL_WIDTH = 20;
const ROW_HELP: Record<number, string> = {
	[RULES_ROW]: "Comandos que piden tu sí antes de correr, por ejemplo git push *. Enter para editarlos.",
	[SAVE]: "Muestra el cambio para revisarlo; recién ahí se guarda en la KB.",
	[CANCEL]: "Sale sin guardar nada.",
};
const RULES_ABOUT = "Un comando que coincide con una regla te pide el sí antes de correr. Los compuestos (&&, |, comillas, redirecciones) siempre lo piden.";
const EMPTY_RULES = "Vacía: ningún comando simple pide confirmación.";
const EXAMPLES = "Ejemplos: git push *  ·  gh pr merge *  ·  rm -rf *  ·  npm publish*";
const SYNTAX = "* cualquier texto · ? un carácter · \\* \\? \\\\ literales · distingue mayúsculas";
const RESTRICTIONS = "No es sandbox. Otras restricciones y confirmaciones de OMI siguen vigentes.";
const PASTE_START = "\x1b[200~";

type View = { kind: "list" } | { kind: "rules" } | { kind: "review"; block: FoundationsBlock; back: "list" | "rules"; returnFocus: number };
export interface FoundationsPanelInput {
	repo: string;
	initial?: unknown;
	/** Sólo una aceptación real puede figurar como la revisión anterior del diff; precargar no acepta. */
	previousAccepted?: unknown;
	product: string;
	kbUrl: string;
	notice?: string;
}
export interface FoundationsPanelOptions extends FoundationsPanelInput {
	tui: TUI;
	theme: () => Theme;
	rows: () => number;
	done: (block: FoundationsBlock | undefined) => void;
	keybindings?: Pick<KeybindingsManager, "matches">;
}
const copy = (block: FoundationsBlock): FoundationsBlock => ({ ...block, confirmar: [...block.confirmar], politica: { ...block.politica } });

export class FoundationsPanel implements Component, Focusable {
	private readonly options: FoundationsPanelOptions;
	private readonly previous: FoundationsBlock | undefined;
	private readonly editor: FoundationsRulesEditor;
	private readonly policy: FoundationsPolicy;
	private view: View = { kind: "list" };
	private focus = 0;
	private hasFocus = false;
	private closed = false;
	private error = "";
	private reviewOffset = 0;
	private reviewPage = 1;
	private reviewLength = 0;
	private lastWidth = 0;

	constructor(options: FoundationsPanelOptions) {
		this.options = options;
		const checked = checkBlock(options.initial);
		const initial = "block" in checked && checked.block.repo === options.repo.toLowerCase() ? copy(checked.block) : undefined;
		const accepted = checkBlock(options.previousAccepted);
		this.previous = "block" in accepted && accepted.block.repo === options.repo.toLowerCase() ? copy(accepted.block) : undefined;
		this.policy = { ...(initial?.politica ?? DEFAULT_POLICY) };
		this.editor = new FoundationsRulesEditor({
			tui: options.tui, theme: options.theme, initial: initial?.confirmar.join("\n") ?? "",
			...(options.keybindings ? { keybindings: options.keybindings } : {}),
			problem: (message) => { this.error = message; }, changed: () => { this.error = ""; },
		});
	}
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.syncFocus(); }
	get capturesViewportInput(): boolean { return true; }
	private syncFocus(): void { this.editor.focused = this.hasFocus && !this.closed && this.view.kind === "rules"; }
	invalidate(): void { this.editor.invalidate(); }
	dispose(): void { this.finish(undefined); }
	private finish(block: FoundationsBlock | undefined): void {
		if (this.closed) return;
		this.closed = true; this.editor.dispose();
		this.options.done(block);
	}
	private openRules(): void { this.view = { kind: "rules" }; this.focus = RULES_ROW; }

	handleInput(data: string): void {
		if (this.closed) return;
		// Pegar desde la lista es querer cargar reglas: se abre su editor y el texto entra tal cual.
		if (this.view.kind === "list" && data.includes(PASTE_START)) this.openRules();
		if (!this.editor.consumePaste(data, this.view.kind === "rules", (key) => this.handleKey(key))) this.handleKey(data);
		this.syncFocus(); this.options.tui.requestRender();
	}
	private handleKey(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
		if (matchesKey(data, "ctrl+s")) { this.save(); return; }
		const view = this.view;
		if (matchesKey(data, "escape")) {
			if (view.kind === "review") { this.view = { kind: view.back }; this.focus = view.returnFocus; }
			else if (view.kind === "rules") this.view = { kind: "list" };
			else this.finish(undefined);
			return;
		}
		if (view.kind === "review") { this.reviewKey(data); return; }
		if (view.kind === "rules") {
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.view = { kind: "list" };
			else this.editor.handleInput(data);
			return;
		}
		if (matchesKey(data, "tab") || this.selectKey(data, "down")) { this.focus = (this.focus + 1) % ROWS; return; }
		if (matchesKey(data, "shift+tab") || this.selectKey(data, "up")) { this.focus = (this.focus + ROWS - 1) % ROWS; return; }
		const point = POINTS[this.focus];
		if (point && (matchesKey(data, "left") || matchesKey(data, "right"))) { this.policy[point] = matchesKey(data, "left") ? "ask" : "auto"; return; }
		if (!matchesKey(data, "enter") && !matchesKey(data, "space")) return;
		if (point) this.policy[point] = this.policy[point] === "ask" ? "auto" : "ask";
		else if (this.focus === RULES_ROW) this.openRules();
		else if (this.focus === SAVE) this.save();
		else this.finish(undefined);
	}
	private selectKey(data: string, action: "up" | "down" | "pageUp" | "pageDown"): boolean {
		return this.options.keybindings?.matches(data, `tui.select.${action}`) ?? matchesKey(data, action);
	}
	private reviewKey(data: string): void {
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { this.focus = this.focus === SAVE ? CANCEL : SAVE; return; }
		if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (this.focus === SAVE) this.save(); else this.finish(undefined);
		} else if (this.selectKey(data, "up")) this.reviewOffset--;
		else if (this.selectKey(data, "down")) this.reviewOffset++;
		else if (this.selectKey(data, "pageUp")) this.reviewOffset -= this.reviewPage;
		else if (this.selectKey(data, "pageDown")) this.reviewOffset += this.reviewPage;
		else if (matchesKey(data, "home")) this.reviewOffset = 0;
		else if (matchesKey(data, "end")) this.reviewOffset = this.reviewLength;
		this.reviewOffset = Math.max(0, Math.min(this.reviewOffset, this.reviewLength - this.reviewPage));
	}

	private rules(): string[] { return this.editor.text.split("\n").filter((line) => line !== ""); }
	private draft(): FoundationsBlock | undefined {
		const rules: string[] = []; const seen = new Set<string>();
		for (const [index, line] of this.editor.text.split("\n").entries()) {
			if (line === "") continue;
			const problem = ruleProblem(line) ?? (seen.has(line) ? "hay reglas repetidas exactas" : undefined)
				?? (rules.length >= MAX_RULES ? `se admiten hasta ${MAX_RULES} reglas` : undefined);
			if (problem) { this.error = `Línea ${index + 1}: ${problem}`; this.openRules(); return undefined; }
			seen.add(line); rules.push(line);
		}
		const checked = checkBlock({ version: 2, repo: this.options.repo.toLowerCase(), confirmar: rules, politica: { ...this.policy } });
		if ("reason" in checked) { this.error = checked.reason; return undefined; }
		return checked.block;
	}
	private save(): void {
		if (!this.fits(Math.min(this.lastWidth, this.options.tui.terminal.columns))) return;
		if (this.view.kind === "review") { this.finish(copy(this.view.block)); return; }
		const back = this.view.kind; const returnFocus = this.focus;
		const block = this.draft();
		if (!block) return;
		this.error = "";
		this.view = { kind: "review", block, back: this.view.kind === "rules" ? "rules" : back, returnFocus };
		this.focus = SAVE; this.reviewOffset = 0;
	}

	private fits(width: number): boolean {
		// Encabezado, editor completo, ejemplos y pie fijo, más el marco.
		return width >= 40 && this.options.rows() - 2 >= Math.max(5, Math.floor(this.options.rows() * 0.3)) + 15;
	}
	render(width: number): string[] {
		this.lastWidth = width;
		const available = Math.max(1, this.options.rows() - 2);
		const inner = Math.max(1, width - 4);
		const theme = this.options.theme();
		// No cortar el Editor/cursor ni aceptar una revisión que no se puede mostrar.
		if (!this.fits(width)) return [
			theme.fg("accent", "Foundations"), theme.fg("warning", "Ampliá la terminal para editar (80×24 recomendado)."),
			"[ Guardar: ampliar ]  [ Cancelar: Esc ]",
		].slice(0, available).map((line) => truncateToWidth(line, width));
		const title = truncateToWidth(theme.fg("accent", theme.bold(visibleText(`Foundations · ${this.options.repo}`))), width - 5);
		const top = theme.fg("border", "┌─ ") + title + theme.fg("border", ` ${"─".repeat(Math.max(0, width - visibleWidth(title) - 5))}┐`);
		const height = available - 2;
		const content = this.view.kind === "review" ? this.renderReview(inner, height, this.view.block) : this.view.kind === "rules" ? this.renderRules(inner, height) : this.renderList(inner, height);
		const border = theme.fg("border", "│");
		return [top, ...content.map((line) => `${border} ${truncateToWidth(line, inner, "", true)} ${border}`), theme.fg("border", `└${"─".repeat(Math.max(0, width - 2))}┘`)]
			.map((line) => truncateToWidth(line, width, ""));
	}
	private meta(): string {
		let location = this.options.kbUrl;
		try { location = new URL(location).host; } catch { /* La presentación no valida ni conecta la KB. */ }
		return visibleText(`Se guarda en la KB (${this.options.product} · ${location}) · vale sólo en el harness`);
	}
	private actions(review: boolean): string {
		const theme = this.options.theme();
		const button = (label: string, index: number) => this.focus === index
			? theme.style(`[ ${label} ]`, { fg: "accent", bg: "selectedBg", bold: true }) : theme.fg("muted", `[ ${label} ]`);
		return `${button(review ? "Guardar" : "Guardar → revisar", SAVE)}   ${button("Cancelar", CANCEL)}`;
	}
	private status(width: number, idle: string[]): string[] {
		const theme = this.options.theme(); const message = this.error || this.options.notice || "";
		const lines = message ? wrapTextWithAnsi(visibleText(message), width).slice(0, 2).map((line) => theme.fg(this.error ? "error" : "warning", line)) : idle;
		while (lines.length < 2) lines.push("");
		return lines;
	}
	private policyRow(point: PolicyPoint, index: number): string {
		const theme = this.options.theme(); const mode = this.policy[point]; const focused = this.focus === index;
		const option = (value: "ask" | "auto") => mode === value ? theme.fg(value === "auto" ? "warning" : "accent", theme.bold(`[${value}]`)) : theme.fg("dim", ` ${value} `);
		return `${theme.fg(focused ? "accent" : "text", `${focused ? "›" : " "} ${LABELS[point].padEnd(LABEL_WIDTH)}`)}${option("ask")} ${option("auto")}`;
	}
	private explanation(): { text: string; color: "warning" | "muted" } {
		const point = POINTS[this.focus];
		if (!point) return { text: ROW_HELP[this.focus] ?? "", color: "muted" };
		return this.policy[point] === "auto" ? { text: `Auto: ${AUTO_WARNINGS[point]}.`, color: "warning" } : { text: `Ask: ${ASK_HELP[point]}.`, color: "muted" };
	}
	private renderList(width: number, height: number): string[] {
		const theme = this.options.theme(); const rules = this.rules(); const focused = this.focus === RULES_ROW;
		const header = [theme.fg("accent", theme.bold("¿Cuándo te pide confirmación el agente?")), theme.fg("dim", this.meta()), ""];
		const count = rules.length ? `${rules.length} ${rules.length === 1 ? "regla" : "reglas"} · Enter editar` : "ninguna · Enter agregar";
		const rulesRow = `${theme.fg(focused ? "accent" : "text", `${focused ? "›" : " "} ${"Reglas de comandos".padEnd(LABEL_WIDTH)}`)}${theme.fg("muted", count)}`;
		const preview = rules.slice(0, PREVIEW).map((rule) => theme.fg("muted", `      ${visibleText(rule)}`));
		if (rules.length > PREVIEW) preview.push(theme.fg("dim", `      … y ${rules.length - PREVIEW} más`));
		const { text, color } = this.explanation();
		const explanation = wrapTextWithAnsi(visibleText(text), width).slice(0, 3).map((line) => theme.fg(color, line));
		const footer = [...this.status(width, []), this.actions(false), theme.fg("dim", "↑↓ mover · Espacio cambiar · Enter abrir · Ctrl+S revisar · Esc salir")];
		// Si falta alto, se resume la vista previa antes que la explicación de la fila enfocada.
		while (preview.length && header.length + 4 + preview.length + 1 + explanation.length + footer.length > height) preview.pop();
		const lines = [...header, ...POINTS.map((point, index) => this.policyRow(point, index)), rulesRow, ...preview, "", ...explanation];
		while (lines.length + footer.length < height) lines.push("");
		return [...lines.slice(0, Math.max(0, height - footer.length)), ...footer];
	}
	private renderRules(width: number, height: number): string[] {
		const theme = this.options.theme(); const count = this.rules().length;
		const header = [theme.fg("accent", `REGLAS DE COMANDOS · ${count}/${MAX_RULES} · una por línea`),
			...wrapTextWithAnsi(RULES_ABOUT, width).slice(0, 3).map((line) => theme.fg("muted", line))];
		const editor = this.editor.render(width);
		const editorHeight = Math.max(5, Math.floor(this.options.rows() * 0.3)) + 2;
		// El editor mantiene un área amplia aun con una lista vacía; no recortar sus filas reales.
		while (editor.length < editorHeight) editor.splice(editor.length - 1, 0, "");
		const tips = [theme.fg("dim", EXAMPLES), theme.fg("dim", SYNTAX)];
		const footer = [...this.status(width, [count ? "" : theme.fg("warning", EMPTY_RULES)]), theme.fg("dim", "Esc volver · Enter nueva línea · Ctrl+S revisar")];
		const lines = [...header, ...editor, ...tips];
		while (lines.length + footer.length < height) lines.push("");
		return [...lines.slice(0, Math.max(0, height - footer.length)), ...footer];
	}
	private renderReview(width: number, height: number, block: FoundationsBlock): string[] {
		const theme = this.options.theme();
		const warning = block.confirmar.length ? "Sólo comandos SIMPLE no coincidentes quedan sin confirmación por esta política." : EMPTY_RULES_WARNING;
		const header = [theme.fg("accent", "REVISAR · Ctrl+S confirma esta revisión exacta"),
			...wrapTextWithAnsi(warning, width).map((line) => theme.fg("warning", line)), theme.fg("dim", RESTRICTIONS)];
		const body = foundationsDiff(this.previous, block, { product: this.options.product, kbUrl: this.options.kbUrl }).split("\n")
			// El word-wrap de prosa recorta espacios al borde de cada tramo: no sirve para patrones exactos.
			.flatMap((line) => /^  (?:[+-] | {2})/.test(line) ? commandDisplayLines(line, width) : wrapTextWithAnsi(visibleText(line), width));
		const footer = [theme.fg("dim", "Reglas: │ línea · ↳ continúa · \\\\ representa un backslash"),
			theme.fg("muted", "Guardar no ejecuta comandos ni crea un permiso del trabajo."), this.actions(true),
			theme.fg("dim", "↑↓/PgUp/PgDn desplazar · Esc volver · Ctrl+S guardar")];
		this.reviewPage = Math.max(1, height - header.length - footer.length - 1);
		this.reviewLength = body.length;
		this.reviewOffset = Math.max(0, Math.min(this.reviewOffset, body.length - this.reviewPage));
		const visible = body.slice(this.reviewOffset, this.reviewOffset + this.reviewPage).map((line) => theme.fg("text", line));
		while (visible.length < this.reviewPage) visible.push("");
		const position = theme.fg("dim", `Revisión ${this.reviewOffset + 1}–${Math.min(body.length, this.reviewOffset + this.reviewPage)} de ${body.length} · ↑↓ desplazar`);
		return [...header, ...visible, position, ...footer];
	}
}

/** La integración espera una decisión; persistencia KB/aceptación local quedan a cargo de quien la llama. */
export async function showFoundationsPanel(ctx: ExtensionContext, input: FoundationsPanelInput, signal?: AbortSignal): Promise<FoundationsBlock | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Foundations necesita la TUI interactiva de OMI.");
	if (signal?.aborted) return undefined;
	let panel: FoundationsPanel | undefined;
	const cancel = () => panel?.dispose();
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		return await ctx.ui.custom<FoundationsBlock | undefined>((tui, theme, keybindings, done) => {
			panel = new FoundationsPanel({ ...input, tui, theme: () => ctx.ui.theme ?? theme, rows: () => tui.terminal.rows, keybindings, done });
			if (signal?.aborted) panel.dispose();
			return panel;
		}, { overlay: true, overlayOptions: () => ({ anchor: "center", width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } }),
			blocked: { kind: "question", message: "Configurar Foundations" } });
	} finally { signal?.removeEventListener("abort", cancel); }
}
