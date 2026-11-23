// Espera de un trabajo largo del arranque: qué se espera, cuánto lleva y cómo cancelarlo, en castellano.
// No usa BorderedLoader de Pi: agrega su propio aviso en inglés, que duplicaba el nuestro.
import { CancellableLoader, Container, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const border = (theme: Theme): Component => ({ render: (width) => [theme.fg("border", "─".repeat(Math.max(1, width)))], invalidate: () => {} });
const label = (title: string, elapsedMs: number) => `${title} · ${Math.max(0, Math.floor(elapsedMs / 1000))} s`;

export class WaitingLoader extends Container {
	private readonly loader: CancellableLoader;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly started: number;
	private readonly tui: TUI;
	private readonly title: string;
	private readonly now: () => number;
	constructor(tui: TUI, theme: Theme, title: string, now: () => number = Date.now) {
		super();
		this.tui = tui; this.title = title; this.now = now; this.started = now();
		this.loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), label(title, 0));
		for (const child of [border(theme), this.loader, new Spacer(1), new Text(theme.fg("dim", "Esc cancela"), 1, 0), new Spacer(1), border(theme)]) this.addChild(child);
		this.timer = setInterval(() => this.tick(), 1000);
	}
	get signal(): AbortSignal { return this.loader.signal; }
	set onAbort(callback: () => void) { this.loader.onAbort = callback; }
	/** Actualiza el tiempo transcurrido; el intervalo lo llama cada segundo. */
	tick(): void { this.loader.setMessage(label(this.title, this.now() - this.started)); this.tui.requestRender(); }
	handleInput(data: string): void { this.loader.handleInput(data); }
	dispose(): void { clearInterval(this.timer); this.loader.dispose(); }
}

/** Muestra un trabajo largo con opción de cancelar; undefined si la persona canceló. */
export type WaitLoader = <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
export const borderedLoader: WaitLoader = async <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
	let failure: unknown; let value: T | undefined;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const loader = new WaitingLoader(tui, theme, title);
		let finished = false; const finish = () => { if (!finished) { finished = true; done(); } };
		loader.onAbort = finish;
		work(loader.signal).then((result) => { if (!loader.signal.aborted) value = result; finish(); }, (error) => { if (!loader.signal.aborted) failure = error; finish(); });
		return loader;
	}, { overlay: true });
	if (failure) throw failure;
	return value;
};
