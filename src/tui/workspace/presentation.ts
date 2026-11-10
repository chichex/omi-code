import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { safeText } from "./data.ts";

export const BG = parseColor("#050607");
export const PANEL = parseColor("#15191c");
const LIGHT_BG = parseColor("#ffffff");
const LIGHT_PANEL = parseColor("#f3f4f5");
export function fit(line: string, width: number): string { return truncateToWidth(line, Math.max(0, width), "…", true); }
export function surface(theme: Theme, line: string, width: number, panel = false): string {
	const light = theme.appearance === "light";
	return theme.style(fit(line, width), { bg: light ? (panel ? LIGHT_PANEL : LIGHT_BG) : (panel ? PANEL : BG) });
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
export function modalLines(theme: Theme, title: string, content: string[], width: number): string[] {
	if (width < 4) return content.map((line) => fit(line, width));
	const inner = width - 4;
	return [theme.fg("border", `┌${"─".repeat(width - 2)}┐`),
		...['', theme.bold(title), '', ...content, '', theme.fg("dim", "Esc cancelar / cerrar")].map((line) => theme.fg("border", "│ ") + fit(line, inner) + theme.fg("border", " │")),
		theme.fg("border", `└${"─".repeat(width - 2)}┘`)];
}
