import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { WaitingLoader } from "../src/tui/development-loader.ts";
import { fakeTui, KEYS } from "./helpers/questions.ts";

function mount() {
	let now = 1_000; const theme = getThemeByName("dark")!;
	const loader = new WaitingLoader(fakeTui({ columns: 80, rows: 24 }), theme, "Clasificando el pedido con GPT-6.1 Sol", () => now);
	const screen = () => loader.render(80).map(stripTerminalSequences).join("\n");
	return { loader, screen, advance: (ms: number) => { now += ms; loader.tick(); } };
}

test("development_loader dice qué espera, cuánto lleva y cómo cancelar, una sola vez y en castellano", (t) => {
	const f = mount(); t.after(() => f.loader.dispose());
	assert.match(f.screen(), /Clasificando el pedido con GPT-6\.1 Sol · 0 s/);
	f.advance(12_400);
	assert.match(f.screen(), /Clasificando el pedido con GPT-6\.1 Sol · 12 s/);
	assert.equal(f.screen().match(/cancel/gi)?.length, 1, "un solo aviso para cancelar");
	assert.match(f.screen(), /Esc cancela/); assert.doesNotMatch(f.screen(), /escape\/ctrl\+c/);
});

test("development_loader Esc aborta la señal y avisa", (t) => {
	const f = mount(); t.after(() => f.loader.dispose()); let aborted = 0;
	f.loader.onAbort = () => { aborted++; };
	f.loader.handleInput(KEYS.esc);
	assert.equal(f.loader.signal.aborted, true); assert.equal(aborted, 1);
});
