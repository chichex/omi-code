// La configuración que ve la pestaña OMI: el harness la calcula al abrir la sesión, cuando la pestaña pide r y después
// de configurar, y avisa por el bus. Git temporal, KB en memoria, sin red.
// Cambio de requisito del dueño (2026-11-23): la pestaña OMI muestra todo directamente, sin apretar f.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CONFIG_EVENT, CONFIG_REFRESH_EVENT, sessionConfigView, type ConfigSnapshot } from "../src/tui/development-config-view.ts";
import { developmentFixture } from "./helpers/development.ts";
import { acceptLifecycleConfig, lifecycleConfig } from "./helpers/lifecycle.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { KEYS } from "./helpers/questions.ts";

const saves = (kb: MemoryKb) => kb.calls.filter((call) => call.tool === "guardar").length;
async function fixture(t: TestContext, options: { args?: readonly string[] } = {}) {
	const kb = memoryKb({ products: ["repo"] });
	const background: Promise<void>[] = [];
	const f = await developmentFixture(t, { kb, ...(options.args ? { args: options.args } : {}), deps: { background: (work) => { background.push(work); } } });
	// La rama base que el wizard del lifecycle lee de origin/HEAD.
	execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: f.checkout.root });
	const file = f.manager.getSessionFile(); assert.ok(file);
	const settled = async () => { for (let seen = -1; seen !== background.length;) { seen = background.length; await Promise.all(background); } };
	/** Lo último que publicó el harness para la pestaña; falla si todavía no hay datos. */
	const snapshot = (): ConfigSnapshot => { const view = sessionConfigView(file); assert.equal(view?.status, "ready"); assert.ok(view?.status === "ready"); return view.snapshot; };
	const item = (id: string) => snapshot().diagnosis.items.find((entry) => entry.id === id);
	return Object.assign(f, { kb, file, settled, snapshot, item });
}

test("config_state: al abrir la sesión publica Foundations, lifecycle y lo que falta, sin preguntar ni escribir la KB", async (t) => {
	const f = await fixture(t); await f.settled();
	assert.equal(f.snapshot().reading.kind, "missing"); assert.equal(f.item("foundations")?.status, "falta");
	assert.equal(f.snapshot().lifecycle?.state.status, "unconfigured"); assert.equal(f.item("lifecycle")?.status, "falta");
	assert.ok(f.busEvents.some(({ name, event }) => name === CONFIG_EVENT && JSON.stringify(event) === JSON.stringify({ sessionFile: f.file })), "avisa a la pestaña por el bus");
	assert.equal(f.asked.length, 0, "mostrar no abre nada"); assert.equal(saves(f.kb), 0);
});

test("config_state: r relee la KB: un lifecycle guardado desde otra terminal aparece sin reabrir la sesión", async (t) => {
	const f = await fixture(t); await f.settled();
	assert.equal(f.snapshot().lifecycle?.state.status, "unconfigured");
	await acceptLifecycleConfig(f.kb, f.home, f.checkout.root, lifecycleConfig("test/repo", (block) => { block.ship = { status: "not-applicable", targets: [] }; }));
	await f.emitBus(CONFIG_REFRESH_EVENT, { sessionFile: join(f.home, "otra-sesion.jsonl") }); await f.settled();
	assert.equal(f.snapshot().lifecycle?.state.status, "unconfigured", "el pedido de otra sesión no la toca");
	const reads = f.kb.calls.length;
	await f.emitBus(CONFIG_REFRESH_EVENT, { sessionFile: f.file }); await f.settled();
	assert.ok(f.kb.calls.length > reads, "r vuelve a leer la KB");
	assert.equal(f.snapshot().lifecycle?.state.status, "not-applicable"); assert.equal(f.item("lifecycle")?.status, "ok");
	assert.equal(saves(f.kb), 0, "releer no escribe la KB");
});

test("config_state: después de guardar con /omi-setup la pestaña ve el lifecycle aceptado y lo postergado", async (t) => {
	const f = await fixture(t); await f.settled();
	const answers: [RegExp, string[]][] = [[/Foundations de/, ["2"]], [/Ship de/, ["3"]], [/Continuidad del lifecycle/, ["1"]], [/Resumen antes de guardar/, ["1", KEYS.enter]]];
	f.uiControl.questions = (screen) => answers.find(([pattern]) => pattern.test(screen))?.[1] ?? [KEYS.esc];
	await f.run("omi-setup"); await f.settled();
	assert.equal(saves(f.kb), 1, "guardó el lifecycle");
	assert.equal(f.snapshot().lifecycle?.state.status, "not-applicable", "la pestaña ve lo recién guardado, no la lectura vieja");
	assert.equal(f.item("foundations")?.status, "postergado", "Más adelante de Foundations también se ve");
	assert.equal(f.item("lifecycle-continuity")?.status, "postergado");
});

test("config_state: sin UI no publica nada; offline, r no consulta la KB y lo que falta se ve igual", async (t) => {
	const rpc = await fixture(t); Reflect.set(rpc.context, "mode", "rpc");
	const manager = SessionManager.create(rpc.checkout.root, join(rpc.home, "sesiones-rpc"));
	manager.appendMessage({ role: "user", content: "hola", timestamp: Date.now() });
	Reflect.set(rpc.context, "sessionManager", manager); await rpc.attach(); await rpc.settled();
	const rpcFile = manager.getSessionFile(); assert.ok(rpcFile);
	assert.equal(sessionConfigView(rpcFile), undefined, "sin pestaña no hay nada que mostrar");
	const offline = await fixture(t, { args: ["--offline"] }); await offline.settled();
	const reads = offline.kb.calls.length;
	await offline.emitBus(CONFIG_REFRESH_EVENT, { sessionFile: offline.file }); await offline.settled();
	assert.equal(offline.kb.calls.length, reads, "offline no se relee la KB");
	assert.equal(offline.snapshot().diagnosis.items.length > 0, true);
});
