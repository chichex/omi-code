import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { hyperlink, matchesKey, SelectList, wrapTextWithAnsi, type Component, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { MODAL_CONTENT_ROW, modalBodyRows, modalHint, modalLines, modalSelection, text, type ModalOptions } from "./presentation.ts";

// El contenido se guarda sin ANSI. Sólo se colorea al renderizar con el tema vigente.
export type ModalEntry = string | { label: string; value: string; color?: ThemeColor } | { text: string; color: ThemeColor } | { section: string };
export function field(label: string, value: string, color?: ThemeColor): ModalEntry { return { label, value, ...(color ? { color } : {}) }; }
export function notice(value: string, color: ThemeColor = "muted"): ModalEntry { return { text: value, color }; }
export function section(value: string): ModalEntry { return { section: value }; }

export function modalEntry(theme: Theme, entry: ModalEntry, color: ThemeColor): string {
	if (typeof entry !== "string") {
		if ("label" in entry) return theme.fg("muted", `${text(entry.label)}: `) + theme.fg(entry.color ?? "text", text(entry.value));
		if ("section" in entry) return theme.style(`▌ ${text(entry.section)}`, { fg: color, bold: true });
		return theme.fg(entry.color, text(entry.text));
	}
	// Sólo URLs HTTP(S) completas y sin credenciales pueden convertirse en enlaces OSC 8.
	if (/^https?:\/\/[^\s\x00-\x1f\x7f-\x9f]+$/.test(entry)) {
		try {
			const url = new URL(entry);
			if (!url.username && !url.password) return hyperlink(theme.style(entry, { fg: "mdLink", underline: true }), url.href);
		} catch { /* Un texto que parece URL sigue siendo texto. */ }
	}
	return theme.fg("text", text(entry));
}

interface ModalContext {
	theme: () => Theme;
	rows: () => number;
	redraw: () => void;
}
export class OmiInfoModal implements Component {
	readonly capturesViewportInput = true;
	private offset = 0;
	private lastOffset = 0;
	private pageSize = 1;
	private options: ModalContext & { title: string; content: ModalEntry[]; done: (confirmed?: boolean) => void; confirmLabel?: string } & ModalOptions;
	constructor(options: OmiInfoModal["options"]) { this.options = options; }
	render(width: number): string[] {
		const { title, content, rows, theme: getTheme } = this.options;
		const theme = getTheme(); const color = this.options.color ?? "accent";
		const lines = content.flatMap((entry) => wrapTextWithAnsi(modalEntry(theme, entry, color), Math.max(1, width - 4)));
		this.pageSize = modalBodyRows(rows()); this.lastOffset = Math.max(0, lines.length - this.pageSize);
		this.offset = Math.min(this.offset, this.lastOffset);
		const position = `${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)}/${lines.length}`;
		const scroll = this.lastOffset ? ` · ${modalHint(theme, width < 70 ? "↑↓" : "↑↓ / PgUp PgDn", width < 70 ? position : `desplazar · ${position}`)}` : "";
		const action = this.options.confirmLabel ? modalHint(theme, "Esc", "cerrar") + " · " + modalHint(theme, "Enter", this.options.confirmLabel) : modalHint(theme, width < 70 ? "Esc" : "Esc / Enter", "cerrar");
		return modalLines(theme, title, lines.slice(this.offset, this.offset + this.pageSize), width, { ...this.options, footer: [action + scroll] });
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.options.done(); return; }
		if (matchesKey(data, "return")) { this.options.done(this.options.confirmLabel ? true : undefined); return; }
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.move(this.pageSize);
		else if (matchesKey(data, "home")) this.move(-this.lastOffset);
		else if (matchesKey(data, "end")) this.move(this.lastOffset);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return;
		this.move(event.wheelDelta ?? 0); return { handled: true };
	}
	private move(delta: number): void { this.offset = Math.max(0, Math.min(this.lastOffset, this.offset + delta)); this.options.redraw(); }
	invalidate(): void {}
}

export class OmiCommandPalette implements Component {
	readonly capturesViewportInput = true;
	readonly items: SelectItem[];
	private list: SelectList;
	private selected = 0;
	private inner = 0;
	private listRows = 0;
	private listTheme: Theme | undefined;
	private visible = 0;
	private options: ModalContext & { items: SelectItem[]; keys: KeybindingsManager; done: (value: string | undefined) => void };
	constructor(options: OmiCommandPalette["options"]) {
		this.options = options;
		this.items = options.items.map((item) => ({ ...item, label: text(item.label), ...(item.description ? { description: text(item.description) } : {}) }));
		this.list = this.createList();
	}
	private createList(): SelectList {
		const theme = this.options.theme(); this.listTheme = theme;
		this.visible = Math.max(1, modalBodyRows(this.options.rows()) - 1);
		const list = new SelectList(this.items, this.visible, {
			selectedPrefix: (value) => theme.fg("accent", value), selectedText: (value) => modalSelection(theme, value, this.inner),
			description: (value) => theme.fg("muted", value), scrollInfo: (value) => theme.fg("dim", value), noMatch: (value) => theme.fg("muted", value),
		});
		list.setSelectedIndex(this.selected);
		list.onSelectionChange = (item) => { this.selected = this.items.indexOf(item); };
		list.onSelect = (item) => this.options.done(item.value);
		list.onCancel = () => this.options.done(undefined);
		return list;
	}
	render(width: number): string[] {
		this.inner = Math.max(0, width - 4);
		const theme = this.options.theme();
		if (theme !== this.listTheme || this.visible !== Math.max(1, modalBodyRows(this.options.rows()) - 1)) this.list = this.createList();
		const lines = this.list.render(Math.max(4, this.inner)); this.listRows = Math.min(this.items.length, this.visible);
		return modalLines(theme, "OMI · Comandos", lines, width, { color: "accent", subtitle: "Vistas y herramientas del workspace",
			footer: [width < 70 ? modalHint(theme, "Esc", "salir") + " · " + modalHint(theme, "↑↓", "") + " · " + modalHint(theme, "Enter", "abrir")
				: modalHint(theme, "Esc", "cancelar") + " · " + modalHint(theme, "↑ ↓", "elegir") + " · " + modalHint(theme, "Enter", "abrir")] });
	}
	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) this.options.done(undefined);
		else if (this.options.keys.matches(data, "tui.select.cancel")) this.options.done(undefined);
		else this.list.handleInput(data);
		this.options.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" && (event.y < MODAL_CONTENT_ROW || event.y >= MODAL_CONTENT_ROW + this.listRows || event.x < 2 || event.x >= event.width - 2)) return;
		const result = this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - MODAL_CONTENT_ROW, width: this.inner });
		if (result) this.options.redraw(); return result;
	}
	invalidate(): void { this.list.invalidate(); }
}
