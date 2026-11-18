// Revisión dedicada: el cuerpo puede crecer, las decisiones nunca se desplazan con él.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { modalBodyRows, modalHint, modalLines } from "./workspace/presentation.ts";
import { approvalLineText, commandDisplayLines, type ApprovalDocument, type ApprovalLine } from "./development-approval.ts";

// wrapTextWithAnsi hace word-wrap y recorta bordes: sirve para prosa, no para comandos.
function reviewRows(lines: ApprovalLine[], width: number): ApprovalLine[] {
	return lines.flatMap((l) => (l.kind === "command" ? commandDisplayLines(l.text, width) : wrapTextWithAnsi(approvalLineText(l), width)).map((text) => ({ kind: l.kind, text })));
}
export function reviewLines(lines: ApprovalLine[], width: number): string[] { return reviewRows(lines, width).map((l) => l.text); }
interface ReviewOptions {
	document: ApprovalDocument;
	theme: () => Theme;
	rows: () => number;
	redraw: () => void;
	done: (approved: boolean) => void;
}
export class ApprovalReview implements Component {
	readonly capturesViewportInput = true;
	private section = 0;
	private offset = 0;
	private lastOffset = 0;
	private pageSize = 1;
	private closed = false;
	private readable = false;
	private options: ReviewOptions;
	private cache: { width: number; section: number; lines: ApprovalLine[] } | undefined;
	constructor(options: ReviewOptions) { this.options = options; }
	render(width: number): string[] {
		const { document, rows } = this.options; const theme = this.options.theme();
		const section = document.sections[this.section]!;
		// Evitar cortar grafemas en panes que ya no permiten inspeccionar el contenido.
		this.readable = width >= 32 && rows() >= 14;
		if (!this.readable) return modalLines(theme, "Revisión pausada", [], width, { subtitle: "Ampliá el terminal (mín. 36×14).", footer: ["Esc volver sin aprobar"] }).slice(0, Math.max(1, rows()));
		const inner = width - 4;
		if (!this.cache || this.cache.width !== inner || this.cache.section !== this.section) this.cache = { width: inner, section: this.section, lines: reviewRows(section.lines, inner) };
		const lines = this.cache.lines;
		const footer = [modalHint(theme, "Ctrl+S", "aprobar") + " · " + modalHint(theme, "Esc", "volver"),
			modalHint(theme, "←→/Tab", "secciones") + " · " + modalHint(theme, "↑↓", "scroll"), modalHint(theme, "PgUp/PgDn", "") + " · " + modalHint(theme, "Home/End", "") + " · 1–9 ir"];
		this.pageSize = modalBodyRows(rows(), footer.length); this.lastOffset = Math.max(0, lines.length - this.pageSize); this.offset = Math.min(this.offset, this.lastOffset);
		const position = `${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)}/${lines.length}`;
		return modalLines(theme, document.title, lines.slice(this.offset, this.offset + this.pageSize).map((l) => l.kind === "heading" ? theme.style(l.text, { fg: "accent", bold: true }) : theme.fg(l.kind === "command" ? "toolOutput" : "text", l.text)), width,
			{ color: "accent", subtitle: `${this.section + 1}/${document.sections.length} ${section.title} · ${position}`, footer });
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) { this.finish(false); return; }
		if (matchesKey(data, "ctrl+s")) { if (this.canApprove) this.finish(true); return; }
		if (matchesKey(data, "right") || matchesKey(data, "tab")) this.select(this.section + 1);
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.select(this.section - 1);
		else if (/^[1-9]$/.test(data)) this.select(Number(data) - 1);
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.move(this.pageSize);
		else if (matchesKey(data, "home")) this.move(-this.lastOffset);
		else if (matchesKey(data, "end")) this.move(this.lastOffset);
	}
	private get canApprove(): boolean { return this.readable && this.options.rows() >= 14; }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return;
		this.move(event.wheelDelta ?? 0); return { handled: true };
	}
	private select(index: number): void { this.section = (index + this.options.document.sections.length) % this.options.document.sections.length; this.offset = 0; this.invalidate(); this.options.redraw(); }
	private move(delta: number): void { this.offset = Math.max(0, Math.min(this.lastOffset, this.offset + delta)); this.options.redraw(); }
	private finish(value: boolean): void { if (!this.closed) { this.closed = true; this.options.done(value); } }
	invalidate(): void { this.cache = undefined; }
	dispose(): void { this.finish(false); }
}

export async function showApprovalReview(ctx: ExtensionContext, document: ApprovalDocument, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return false;
	let tui: TUI | undefined; let cancel: (() => void) | undefined;
	try {
		const approved = await ctx.ui.custom<boolean | undefined>((ui, theme, _keys, done) => {
			tui = ui;
			const review = new ApprovalReview({ document, theme: () => ctx.ui.theme ?? theme, rows: () => ui.terminal.rows,
				redraw: () => ui.requestRender(), done: (value) => done(!signal.aborted && value) });
			cancel = () => review.dispose();
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			return review;
		}, { overlay: true, overlayOptions: () => ({ width: Math.max(1, Math.min(112, Math.floor((tui?.terminal.columns ?? 80) * .9))), maxHeight: "90%", anchor: "center" }),
			blocked: { kind: "permission", message: document.title } });
		return approved === true && !signal.aborted;
	} finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
