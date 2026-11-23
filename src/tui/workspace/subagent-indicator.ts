// Session-local presentation only: the animation tick never refreshes data or changes task state.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { surface } from "./presentation.ts";
import type { SubagentMonitor } from "./subagents.ts";

const FRAME_MS = 120;
const FRAMES = ["◐", "◓", "◑", "◒"];

export class SubagentIndicator implements Component {
	private monitor: SubagentMonitor;
	private theme: () => Theme;
	private requestRender: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(monitor: SubagentMonitor, theme: () => Theme, requestRender: () => void) {
		this.monitor = monitor; this.theme = theme; this.requestRender = requestRender;
	}

	sync(): void {
		if (!this.monitor.summary.running) { this.dispose(); return; }
		if (this.timer) return;
		this.timer = setInterval(this.requestRender, FRAME_MS);
		this.timer.unref();
	}

	render(width: number): string[] {
		const { running, pending, latest } = this.monitor.summary;
		if (!running && !pending) return [];
		const theme = this.theme();
		const counter = `${running} activos · ${pending} en cola`;
		const name = visibleWidth(`◐ Subagentes · ${counter}`) <= width ? "Subagentes · " : "";
		const frame = running ? FRAMES[Math.floor(Date.now() / FRAME_MS) % FRAMES.length]! : "·";
		const line = theme.fg(running ? "accent" : "muted", `${frame} ${name}${counter}`)
			+ (latest ? theme.fg("muted", ` · última: ${latest.agent} · ${latest.activity}`) : "");
		return [surface(theme, line, width)];
	}

	invalidate(): void {}
	dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
