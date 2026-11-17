import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { surface } from "./presentation.ts";
export { CompactTranscript } from "./tool-output.ts";

export class Lines implements Component {
	private lines: (width: number) => string[];
	private mouse: ((event: TuiMouseEvent) => TuiMouseEventResult | undefined) | undefined;
	constructor(lines: (width: number) => string[], mouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined) { this.lines = lines; this.mouse = mouse; }
	render(width: number): string[] { return this.lines(width); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse?.(event); }
	invalidate(): void {}
}

export class PaintedDocument extends Container {
	private theme: () => Theme;
	private minimumHeight: (width: number) => number;
	constructor(document: Component, theme: () => Theme, minimumHeight: (width: number) => number) { super(); this.theme = theme; this.minimumHeight = minimumHeight; this.addChild(document); }
	override render(width: number): string[] {
		const lines = super.render(width);
		while (lines.length < this.minimumHeight(width)) lines.push("");
		return lines.map((line) => surface(this.theme(), line, width));
	}
}

export class ReadView implements Component {
	capturesViewportInput = true;
	offset = 0;
	private getLines: (width: number) => string[];
	private input: (data: string) => boolean;
	private redraw: () => void;
	private height: () => number;
	constructor(getLines: (width: number) => string[], input: (data: string) => boolean, redraw: () => void, height: () => number) { this.getLines = getLines; this.input = input; this.redraw = redraw; this.height = height; }
	handleInput(data: string): void {
		if (this.input(data)) return;
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset++;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 10);
		else if (matchesKey(data, "pageDown")) this.offset += 10;
		else if (matchesKey(data, "home")) this.offset = 0;
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { if (event.type === "wheel") { this.offset = Math.max(0, this.offset + (event.wheelDelta ?? 0)); this.redraw(); return { handled: true }; } return undefined; }
	render(width: number): string[] { const lines = this.getLines(width); const height = Math.max(1, this.height()); this.offset = Math.min(this.offset, Math.max(0, lines.length - height)); return lines.slice(this.offset, this.offset + height); }
	invalidate(): void {}
}
