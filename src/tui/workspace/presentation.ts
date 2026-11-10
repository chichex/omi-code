import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, parseColor, truncateToWidth, visibleWidth, type Color } from "@earendil-works/pi-tui";
import { safeText, type ChangedFile, type GitSnapshot } from "./data.ts";

export const BG = parseColor("#050607");
export const PANEL = parseColor("#15191c");
const LIGHT_BG = parseColor("#ffffff");
const LIGHT_PANEL = parseColor("#f3f4f5");
export function fit(line: string, width: number): string { return truncateToWidth(line, Math.max(0, width), "…", true); }
export function surface(theme: Theme, line: string, width: number, panel = false): string {
	const light = theme.appearance === "light";
	return paintBackground(theme, line, width, light ? (panel ? LIGHT_PANEL : LIGHT_BG) : (panel ? PANEL : BG));
}
function paintBackground(theme: Theme, line: string, width: number, bg: Color): string {
	const background = backgroundAnsi(bg, theme.getColorMode());
	// truncateToWidth emite SGR 0 y los encabezados cierran su tinte con SGR 49.
	// Restaurar sólo el fondo base: no borrar colores, atributos ni fondos internos.
	const content = fit(line, width).replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background);
	return theme.style(content, { bg });
}
export function sidebarSection(theme: Theme, title: string, width: number, color: ThemeColor): string {
	const label = `▌ ${text(title)} `;
	const base = theme.appearance === "light" ? LIGHT_PANEL : PANEL;
	const tint = theme.colors?.[color];
	return theme.style(fit(label + "─".repeat(Math.max(0, width - visibleWidth(label))), width), { fg: color, bg: tint ? mixColors(base, tint, .1) : base, bold: true });
}
export function gitSyncSummary(theme: Theme, git: Pick<GitSnapshot, "tracking" | "ahead" | "behind">): string {
	if (git.tracking === false) return theme.fg("dim", "sin upstream");
	if (git.tracking === undefined || git.ahead === undefined || git.behind === undefined) return theme.fg("warning", "↑— ↓—");
	if (git.ahead === 0 && git.behind === 0) return theme.fg("success", "Al día (local)");
	return `${theme.fg(git.ahead ? "success" : "dim", `↑${git.ahead}`)} ${theme.fg(git.behind ? "warning" : "dim", `↓${git.behind}`)}`;
}
export function text(value: string): string { return safeText(value); }
export function tokens(value: number): string {
	if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
	return value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(Math.round(value));
}
export function gib(value: number): string { return `${(value / 2 ** 30).toFixed(1)} GiB`; }
export function percentage(used: number, total: number): number | undefined { return total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : undefined; }
export function bar(theme: Theme, percent: number | undefined, width = 16): string {
	width = Math.max(0, Math.floor(width));
	const filled = percent === undefined ? 0 : Math.round(Math.max(0, Math.min(100, percent)) / 100 * width);
	const color = percent !== undefined && percent >= 90 ? "error" : percent !== undefined && percent >= 80 ? "warning" : "success";
	return theme.fg(color, "█".repeat(filled)) + theme.style("█".repeat(width - filled), { fg: parseColor(theme.appearance === "light" ? "#d0d5d9" : "#292f34") });
}
export function align(left: string, right: string, width: number): string {
	if (visibleWidth(left) + visibleWidth(right) + 2 > width) return fit(left, width);
	return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}
export function changedFileLine(theme: Theme, file: ChangedFile, width: number, selected = false): string {
	const counts = file.lines === "binary" ? theme.fg("dim", "binario") : file.lines
		? `${theme.fg("success", `+${file.lines.added}`)} ${theme.fg("error", `−${file.lines.removed}`)}`
		: theme.fg("dim", file.status === "??" ? "nuevo" : "—");
	const countWidth = visibleWidth(counts);
	if (width < countWidth + 3) return fit(counts, width);
	const name = fit(` ${selected ? "›" : " "} ${file.status} ${text(file.path)}`, width - countWidth - 2);
	return (selected ? theme.fg("accent", name) : name) + "  " + counts;
}
export const MODAL_CONTENT_ROW = 4;
export const MODAL_CHROME_ROWS = 7; // Cabecera (4), separador, una fila de atajos y borde inferior.
export interface ModalOptions { color?: ThemeColor; subtitle?: string; footer?: string[] }
export function modalHeight(rows: number): number { return Math.max(1, Math.floor(rows * .9)); }
export function modalBodyRows(rows: number, footerRows = 1): number { return Math.max(1, modalHeight(rows) - MODAL_CHROME_ROWS - Math.max(0, footerRows - 1)); }
export function modalHint(theme: Theme, key: string, label: string): string {
	return theme.style(key, { fg: "accent", bold: true }) + theme.fg("muted", label ? ` ${label}` : "");
}
function modalTint(theme: Theme, color: ThemeColor, amount: number): Color {
	const base = theme.appearance === "light" ? LIGHT_PANEL : PANEL;
	return theme.colors?.[color] ? mixColors(base, theme.colors[color], amount) : base;
}
export function modalSelection(theme: Theme, line: string, width: number, color: ThemeColor = "accent"): string {
	return paintBackground(theme, theme.style(line, { fg: color, bold: true }), width, modalTint(theme, color, .16));
}
export function modalLines(theme: Theme, title: string, content: string[], width: number, options: ModalOptions = {}): string[] {
	const color = options.color ?? "accent";
	const body = modalTint(theme, color, .025); const header = modalTint(theme, color, .12);
	const footer = options.footer ?? [modalHint(theme, "Esc", "cerrar") + " · " + modalHint(theme, "Enter", "cerrar")];
	if (width < 4) return [...content, ...footer].map((line) => paintBackground(theme, line, width, body));
	const inner = width - 4;
	const rule = (left: string, right: string, tone: ThemeColor = "border") => paintBackground(theme, theme.fg(tone, left + "─".repeat(width - 2) + right), width, body);
	const row = (line: string, bg = body) => paintBackground(theme, theme.fg("border", "│ ") + fit(theme.fg("text", line), inner) + theme.fg("border", " │"), width, bg);
	return [rule("┌", "┐", color), row(theme.style(`▌ ${text(title)}`, { fg: color, bold: true }), header),
		row(theme.fg("muted", text(options.subtitle ?? "OMI · Detalle")), header), rule("├", "┤"),
		...content.map((line) => row(line)), rule("├", "┤"), ...footer.map((line) => row(line)), rule("└", "┘", color)];
}
