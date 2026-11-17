import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { fit, text } from "./presentation.ts";

/** Filled/empty circles always keep the same number of terminal cells. */
export function dots(theme: Theme, percent: number | undefined, count = 10, color?: ThemeColor): string {
	count = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	if (!count) return "";
	const known = percent !== undefined && Number.isFinite(percent);
	const filled = known ? Math.round(Math.max(0, Math.min(100, percent)) / 100 * count) : 0;
	const tone = color ?? (known && percent >= 90 ? "error" : known && percent >= 80 ? "warning" : "success");
	return theme.fg(tone, "●".repeat(filled)) + theme.fg("dim", "○".repeat(count - filled));
}

/** This scale is effort, never an invented model capability/quality rating. */
export function reasoningDots(theme: Theme, level: string): string {
	const effort = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].indexOf(level);
	return dots(theme, Math.max(0, effort) / 6 * 100, 6, "accent");
}

export function sidebarBox(theme: Theme, title: string, content: string[], width: number, color: ThemeColor = "accent"): string[] {
	width = Math.max(0, Math.floor(width));
	if (width < 4) return ["┌" + "─".repeat(Math.max(0, width - 1)), ...content, "└" + "─".repeat(Math.max(0, width - 1))].map((line) => fit(line, width));
	const label = fit(text(title), Math.max(0, width - 6)).trimEnd();
	const top = theme.fg("border", "┌─ ") + theme.fg(color, theme.bold(label)) + theme.fg("border", " " + "─".repeat(Math.max(0, width - 5 - visibleWidth(label))) + "┐");
	const row = (line: string) => theme.fg("border", "│ ") + fit(line, width - 4) + theme.fg("border", " │");
	return [fit(top, width), ...content.map(row), theme.fg("border", "└" + "─".repeat(width - 2) + "┘")];
}

/** No tinted section strips: a single black surface (white in light themes). */
export function sidebarSurface(theme: Theme, line: string, width: number): string {
	const bg = parseColor(theme.appearance === "light" ? "#ffffff" : "#000000");
	const background = backgroundAnsi(bg, theme.getColorMode());
	const content = fit(line, width).replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background);
	return theme.style(content, { bg });
}
