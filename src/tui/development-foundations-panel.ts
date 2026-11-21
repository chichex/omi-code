// Panel vertical de Foundations. Sólo devuelve un borrador revisado; no persiste ni concede permisos.
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import {
	AUTO_WARNINGS, checkBlock, EMPTY_RULES_WARNING, foundationsDiff, MAX_RULES, POLICY_LABELS, ruleProblem, STRICT_POLICY, visibleText,
	type FoundationsBlock, type FoundationsPolicy, type PolicyPoint,
} from "../harness/foundations.ts";
import { FoundationsRulesEditor } from "./development-foundations-editor.ts";
import { commandDisplayLines } from "./development-approval.ts";

const POINTS: readonly PolicyPoint[] = ["arranque", "receta", "push_pr"];
const ASK_HELP: Record<PolicyPoint, string> = {
	arranque: "confirmar issue, worktree y sesión",
	receta: "revisar antes de implementar",
	push_pr: "confirmar push de rama y PR draft",
};
const RESTRICTIONS = "No es sandbox. Otras restricciones y confirmaciones de OMI siguen vigentes.";
const EMPTY_EDIT_WARNING = "Lista vacía: todo comando SIMPLE quedará sin confirmación por ESTA política.";

type View = { kind: "edit" } | { kind: "review"; block: FoundationsBlock; returnFocus: number };
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
	private readonly hasInitial: boolean;
	private readonly editor: FoundationsRulesEditor;
	private readonly policy: FoundationsPolicy;
	private view: View = { kind: "edit" };
	private focus = 3;
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
		this.hasInitial = initial !== undefined;
		this.policy = { ...(initial?.politica ?? STRICT_POLICY) };
		this.editor = new FoundationsRulesEditor({
			tui: options.tui, theme: options.theme, initial: initial?.confirmar.join("\n") ?? "",
			...(options.keybindings ? { keybindings: options.keybindings } : {}),
			problem: (message) => { this.error = message; }, changed: () => { this.error = ""; },
		});
	}
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.syncFocus(); }
	get capturesViewportInput(): boolean { return true; }
	private syncFocus(): void { this.editor.focused = this.hasFocus && !this.closed && this.view.kind === "edit" && this.focus === 3; }
	invalidate(): void { this.editor.invalidate(); }
	dispose(): void { this.finish(undefined); }
	private finish(block: FoundationsBlock | undefined): void {
		if (this.closed) return;
		this.closed = true; this.editor.dispose();
		this.options.done(block);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const editable = this.view.kind === "edit" && this.focus === 3;
		if (!this.editor.consumePaste(data, editable, (key) => this.handleKey(key))) this.handleKey(data);
		this.syncFocus(); this.options.tui.requestRender();
	}
	private handleKey(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
		if (matchesKey(data, "escape")) {
			if (this.view.kind === "review") { this.focus = this.view.returnFocus; this.view = { kind: "edit" }; }
			else this.finish(undefined);
			return;
		}
		if (matchesKey(data, "ctrl+s")) { this.save(); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const direction = matchesKey(data, "shift+tab") ? -1 : 1;
			this.focus = this.view.kind === "review" ? this.focus === 4 ? 5 : 4 : (this.focus + direction + 6) % 6;
			return;
		}
		if (this.view.kind === "review") { this.reviewKey(data); return; }
		if (this.focus === 3) { this.editor.handleInput(data); return; }
		if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const point = POINTS[this.focus];
			if (point) this.policy[point] = this.policy[point] === "ask" ? "auto" : "ask";
			else if (this.focus === 4) this.save();
			else if (this.focus === 5) this.finish(undefined);
		} else if (this.selectKey(data, "up")) this.focus = (this.focus + 5) % 6;
		else if (this.selectKey(data, "down")) this.focus = (this.focus + 1) % 6;
	}
	private selectKey(data: string, action: "up" | "down" | "pageUp" | "pageDown"): boolean {
		return this.options.keybindings?.matches(data, `tui.select.${action}`) ?? matchesKey(data, action);
	}
	private reviewKey(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (this.focus === 4) this.save(); else this.finish(undefined);
		} else if (this.selectKey(data, "up")) this.reviewOffset--;
		else if (this.selectKey(data, "down")) this.reviewOffset++;
		else if (this.selectKey(data, "pageUp")) this.reviewOffset -= this.reviewPage;
		else if (this.selectKey(data, "pageDown")) this.reviewOffset += this.reviewPage;
		else if (matchesKey(data, "home")) this.reviewOffset = 0;
		else if (matchesKey(data, "end")) this.reviewOffset = this.reviewLength;
		this.reviewOffset = Math.max(0, Math.min(this.reviewOffset, this.reviewLength - this.reviewPage));
	}

	private draft(): FoundationsBlock | undefined {
		const rules: string[] = []; const seen = new Set<string>();
		for (const [index, line] of this.editor.text.split("\n").entries()) {
			if (line === "") continue;
			const problem = ruleProblem(line) ?? (seen.has(line) ? "hay reglas repetidas exactas" : undefined)
				?? (rules.length >= MAX_RULES ? `se admiten hasta ${MAX_RULES} reglas` : undefined);
			if (problem) { this.error = `Línea ${index + 1}: ${problem}`; this.focus = 3; return undefined; }
			seen.add(line); rules.push(line);
		}
		const checked = checkBlock({ version: 2, repo: this.options.repo.toLowerCase(), confirmar: rules, politica: { ...this.policy } });
		if ("reason" in checked) { this.error = checked.reason; return undefined; }
		return checked.block;
	}
	private save(): void {
		if (!this.fits(Math.min(this.lastWidth, this.options.tui.terminal.columns))) return;
		if (this.view.kind === "review") { this.finish(copy(this.view.block)); return; }
		const block = this.draft();
		if (!block) return;
		this.error = "";
		this.view = { kind: "review", block, returnFocus: this.focus };
		this.focus = 4; this.reviewOffset = 0;
	}

	private fits(width: number): boolean {
		// Seis filas arriba, editor completo, ayuda y cuatro filas fijas abajo, más el marco.
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
		const content = this.view.kind === "edit" ? this.renderEdit(inner, available - 2) : this.renderReview(inner, available - 2, this.view.block);
		const border = theme.fg("border", "│");
		return [top, ...content.map((line) => `${border} ${truncateToWidth(line, inner, "", true)} ${border}`), theme.fg("border", `└${"─".repeat(Math.max(0, width - 2))}┘`)]
			.map((line) => truncateToWidth(line, width, ""));
	}
	private meta(): string {
		let location = this.options.kbUrl;
		try { location = new URL(location).host; } catch { /* La presentación no valida ni conecta la KB. */ }
		return visibleText(`KB · ${this.options.product} · ${location} · sólo harness`);
	}
	private actions(review: boolean): string {
		const theme = this.options.theme();
		const button = (label: string, index: number) => this.focus === index
			? theme.style(`[ ${label} ]`, { fg: "accent", bg: "selectedBg", bold: true }) : theme.fg("muted", `[ ${label} ]`);
		return `${button(review ? "Guardar" : "Guardar → revisar", 4)}   ${button("Cancelar", 5)}`;
	}
	private renderEdit(width: number, height: number): string[] {
		const theme = this.options.theme();
		const policies = POINTS.map((point, index) => {
			const mode = this.policy[point]; const focused = this.focus === index;
			const row = `${focused ? "›" : " "} ${POLICY_LABELS[point]}: ${mode} · ${mode === "auto" ? AUTO_WARNINGS[point] : ASK_HELP[point]}`;
			return theme.fg(focused ? "accent" : mode === "auto" ? "warning" : "text", visibleText(row));
		});
		const editor = this.editor.render(width);
		const editorHeight = Math.max(5, Math.floor(this.options.rows() * 0.3)) + 2;
		// El editor mantiene un área amplia aun con una lista vacía; no recortar sus filas reales.
		while (editor.length < editorHeight) editor.splice(editor.length - 1, 0, "");
		const count = this.editor.text.split("\n").filter((line) => line !== "").length;
		const header = [theme.fg("muted", this.meta()), theme.fg("accent", "POLÍTICAS · Espacio/Enter alterna"), ...policies,
			theme.fg(this.focus === 3 ? "accent" : "muted", `REGLAS PARA CONFIRMAR · ${count}/${MAX_RULES} · una por línea`)];
		const empty = count === 0;
		const message = this.error || this.options.notice || (!this.hasInitial ? "Sin revisión v2 válida: configurá y guardá de nuevo. No se hereda v1." : !this.previous ? "Borrador v2: abrir no acepta ni cambia permisos. Guardar confirma la revisión." : "");
		const status = message ? wrapTextWithAnsi(visibleText(message), width).slice(0, 2).map((line) => theme.fg(this.error ? "error" : "warning", line))
			: [theme.fg(empty ? "warning" : "muted", empty ? EMPTY_EDIT_WARNING : "Sólo líneas simples no coincidentes corren sin preguntar por esta política."), theme.fg("dim", RESTRICTIONS)];
		while (status.length < 2) status.push("");
		const footer = [...status, this.actions(false), theme.fg("dim", "Tab foco · Enter nueva línea · Ctrl+S revisar · Esc cancelar")];
		const help = theme.fg("dim", "* texto · ? un carácter · \\* \\? \\\\ literales · sin recortar espacios");
		const lines = [...header, ...editor, help];
		while (lines.length + footer.length < height) lines.push("");
		return [...lines, ...footer];
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
			blocked: { kind: "question", message: `Foundations · ${visibleText(input.repo)}` } });
	} finally { signal?.removeEventListener("abort", cancel); }
}
