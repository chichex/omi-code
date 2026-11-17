import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, wrapTextWithAnsi, type Component, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { MODAL_CONTENT_ROW, modalBodyRows, modalHint, modalLines, modalSelection } from "./presentation.ts";
import { SIDEBAR_SECTIONS, type SidebarSectionId } from "./preferences.ts";

export interface SidebarSettingsOptions {
	hiddenSections: readonly SidebarSectionId[];
	theme: () => Theme;
	rows: () => number;
	redraw: () => void;
	done: (hidden: SidebarSectionId[] | undefined) => void;
}

/** Borrador local: Enter/Espacio alternan; sólo Ctrl+S aplica, Esc descarta. */
export class OmiSidebarSettings implements Component {
	readonly capturesViewportInput = true;
	private options: SidebarSettingsOptions;
	private hidden: Set<SidebarSectionId>;
	private items: SelectItem[];
	private list: SelectList;
	private selected = 0;
	private inner = 0;
	private visible: number = SIDEBAR_SECTIONS.length;
	private listRows = 0;
	private listTheme: Theme | undefined;
	private closed = false;

	constructor(options: SidebarSettingsOptions) {
		this.options = options;
		this.hidden = new Set(SIDEBAR_SECTIONS.filter(({ id }) => options.hiddenSections.includes(id)).map(({ id }) => id));
		this.items = SIDEBAR_SECTIONS.map(({ id, label }) => ({ value: id, label: this.checkbox(id, label) }));
		this.list = this.createList();
	}
	private checkbox(id: SidebarSectionId, label: string): string { return `[${this.hidden.has(id) ? " " : "x"}] ${label}`; }
	private updateLabels(): void {
		for (const item of this.items) {
			const section = SIDEBAR_SECTIONS.find(({ id }) => id === item.value);
			if (section) item.label = this.checkbox(section.id, section.label);
		}
	}
	private toggle(value: string): void {
		const section = SIDEBAR_SECTIONS.find(({ id }) => id === value);
		if (!section) return;
		if (this.hidden.has(section.id)) this.hidden.delete(section.id); else this.hidden.add(section.id);
		this.updateLabels();
	}
	private createList(): SelectList {
		const theme = this.options.theme(); this.listTheme = theme;
		const list = new SelectList(this.items, this.visible, {
			selectedPrefix: (value) => theme.fg("accent", value), selectedText: (value) => modalSelection(theme, value, this.inner),
			description: (value) => theme.fg("muted", value), scrollInfo: (value) => theme.fg("dim", value), noMatch: (value) => theme.fg("muted", value),
		});
		list.setSelectedIndex(this.selected);
		list.onSelectionChange = (item) => { this.selected = this.items.indexOf(item); };
		list.onSelect = (item) => this.toggle(item.value);
		list.onCancel = () => this.finish(undefined);
		return list;
	}
	private footer(theme: Theme, width: number): string[] {
		// Evitar que el texto del pie crezca sin límite al estrechar la terminal.
		if (width < 28) return [modalHint(theme, "␠/Enter", "alternar"), modalHint(theme, "Ctrl+S", "✓") + " · " + modalHint(theme, "Esc", "×"), modalHint(theme, "r", "ver todo")];
		if (width >= 70) return [modalHint(theme, "↑↓", "elegir") + " · " + modalHint(theme, "Espacio / Enter", "alternar"),
			modalHint(theme, "Ctrl+S", "guardar") + " · " + modalHint(theme, "Esc", "cancelar") + " · " + modalHint(theme, "r", "Restablecer todo visible")];
		return wrapTextWithAnsi(modalHint(theme, "␠/Enter", "alternar") + " · " + modalHint(theme, "Ctrl+S", "guardar") + " · "
			+ modalHint(theme, "Esc", "cancelar") + " · " + modalHint(theme, "r", "ver todo"), Math.max(1, this.inner));
	}
	render(width: number): string[] {
		this.inner = Math.max(0, width - 4);
		const theme = this.options.theme(); const footer = this.footer(theme, width);
		const bodyRows = modalBodyRows(this.options.rows(), footer.length);
		// SelectList agrega una fila de posición al hacer scroll. Con una sola fila se muestra sólo el item enfocado.
		const visible = Math.max(1, Math.min(SIDEBAR_SECTIONS.length, bodyRows - 1));
		if (theme !== this.listTheme || visible !== this.visible) { this.visible = visible; this.list = this.createList(); }
		const lines = this.list.render(Math.max(4, this.inner)).slice(0, bodyRows);
		this.listRows = Math.min(this.items.length, this.visible);
		return modalLines(theme, "Personalizar lateral", lines, width, { subtitle: "Secciones visibles · cambios al guardar", footer });
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+s")) { this.finish(SIDEBAR_SECTIONS.filter(({ id }) => this.hidden.has(id)).map(({ id }) => id)); return; }
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
		if (data === "r") { this.hidden.clear(); this.updateLabels(); }
		else if (matchesKey(data, "space")) { const item = this.list.getSelectedItem(); if (item) this.toggle(item.value); }
		else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.selected = matchesKey(data, "home") ? 0 : this.items.length - 1; this.list.setSelectedIndex(this.selected);
		} else this.list.handleInput(data);
		this.options.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return;
		if (event.type !== "wheel" && (event.y < MODAL_CONTENT_ROW || event.y >= MODAL_CONTENT_ROW + this.listRows || event.x < 2 || event.x >= event.width - 2)) return;
		const result = this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - MODAL_CONTENT_ROW, width: this.inner });
		if (result) this.options.redraw();
		return result;
	}
	private finish(hidden: SidebarSectionId[] | undefined): void { this.closed = true; this.options.done(hidden); }
	invalidate(): void { this.list.invalidate(); }
}
