// Sin Foundations, el harness ofrece armarlo y lo guarda en la KB sólo con el sí. Nunca la KB real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseFoundations, foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, trustPath } from "../src/harness/foundations-trust.ts";
import { shouldOfferFoundations, FOUNDATIONS_OFFER } from "../src/tui/development-foundations-setup.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { createKbClient } from "../src/tui/kb-client.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb, mockKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
import { KEYS, typed } from "./helpers/questions.ts";

process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "omi-kb-agent-"));
const REPO = "test/repo";
const HUMAN = "# Perillas de repo\n\nTono: formal.\n\n```json\n{ \"otra\": \"perilla\" }\n```\n";
const block = (comandos: string[] = ["node test.cjs"]): FoundationsBlock => ({ version: 1, repo: REPO, comandos, politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" } });
const saves = (kb: { calls: { tool: string }[] }) => kb.calls.filter((c) => c.tool === "guardar").length;
async function fixture(t: TestContext, options: { products?: string[]; body?: string | null } = {}) {
	const kb = memoryKb({ products: options.products ?? ["repo"] });
	if (options.body !== null) kb.perillas("repo", options.body ?? HUMAN);
	const f = await developmentFixture(t, { kb });
	return Object.assign(f, { kb });
}
// Las teclas de cada tanda, en orden: la oferta y, al armar, comandos, políticas y resumen.
const batches = (...keys: string[][]) => () => keys.shift();
const BUILD = ["1"];
const KEY = (f: { kb: { url: string } }) => ({ kbUrl: f.kb.url, product: "repo", repo: REPO });
const NODE_TEST = [KEYS.space, ...typed("node test.cjs"), KEYS.enter, KEYS.enter];
const ALL_ASK = ["1", "1", "1", "1", KEYS.enter];
// El sí sensible: el número sólo lleva el cursor, Enter guarda.
const SAVE = ["1", KEYS.enter];

test("foundations_setup: la oferta es una pregunta con «Armar» recomendada y lo que pasa con cada opción", async (t) => {
	const f = await fixture(t); await f.start();
	assert.equal(f.selects.length, 0, "sin el selector de antes");
	assert.equal(f.asked.length, 1);
	// Sin los cortes de línea del ancho de la terminal.
	const offer = f.asked[0]![0]!.replace(/\s+/g, " ");
	assert.match(offer, /Foundations · test\/repo/); assert.match(offer, /¿Armar Foundations para test\/repo\?/);
	assert.match(offer, /comandos que corren sin preguntar y qué puntos piden un sí, en las perillas de repo/);
	assert.match(offer, /1\. Armar Foundations \(Recomendada\)/); assert.match(offer, /se guarda en la KB sólo con tu sí/);
	assert.match(offer, /2\. Ahora no/); assert.match(offer, /No se guarda nada; se vuelve a ofrecer en otra sesión/);
	assert.match(offer, /3\. No ofrecer más para este repo/); assert.match(offer, /registro local/);
	assert.doesNotMatch(offer, /Escribir otra respuesta/, "respuesta cerrada: no hay texto libre");
});

test("foundations_setup: se ofrece una vez por sesión; «Ahora no» y Esc no guardan nada", async (t) => {
	for (const keys of [["2"], [KEYS.esc]]) {
		const f = await fixture(t); f.uiControl.questions = batches(keys);
		await f.start();
		assert.equal(f.asked.length, 1, JSON.stringify(keys));
		assert.equal(await readTrust(foundationsDir(f.home), KEY(f)), undefined, "nada en el registro local");
		await f.attach(); await f.command("resume"); await f.start();
		assert.equal(f.asked.length, 1, "no se vuelve a ofrecer en la misma sesión");
		assert.equal(saves(f.kb), 0);
	}
});

test("foundations_setup: «No ofrecer más» queda registrado y no vuelve", async (t) => {
	const f = await fixture(t); f.uiControl.questions = batches(["3"]);
	await f.start();
	assert.equal(f.asked.length, 1);
	const record = await readTrust(foundationsDir(f.home), KEY(f));
	assert.equal(record?.offerDeclined, true); assert.equal(record?.accepted, null);
	const pin = { origin: "strict" as const, block: null, hash: null, docId: null, author: null, date: null, notice: "", reading: { kind: "missing" as const, key: { kbUrl: f.kb.url, product: "repo", repo: REPO }, perillas: null } };
	assert.equal(shouldOfferFoundations(pin, record, true), false);
	assert.equal(shouldOfferFoundations(pin, undefined, true), true);
	assert.equal(shouldOfferFoundations(pin, undefined, false), false, "sin UI no se ofrece");
	assert.equal(shouldOfferFoundations({ ...pin, reading: { kind: "none", reason: "" } }, undefined, true), false);
	assert.equal(saves(f.kb), 0);
});

test("foundations_setup: el sí guarda una vez, conserva el resto de las perillas y vale en la sesión", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = batches(BUILD, NODE_TEST, ALL_ASK, [KEYS.pageDown, KEYS.pageDown, ...SAVE]);
	await f.start();
	assert.equal(f.editors.length, 0, "sin editor de JSON");
	assert.equal(f.asked.length, 4);
	assert.equal(saves(f.kb), 1);
	const saved = f.kb.documents.at(-1)!;
	assert.ok(saved.cuerpo.startsWith(HUMAN), "el resto del documento queda byte por byte");
	const parsed = parseFoundations(saved.cuerpo, REPO);
	assert.equal(parsed.status === "valid" && parsed.hash, foundationsHash(block()));
	const summary = f.asked[3]!.join("\n");
	assert.match(summary, /¿Guardar Foundations en la KB\?/); assert.match(summary, /\+ node test\.cjs/);
	assert.match(summary, /Se guarda en la KB, producto repo/);
	assert.equal((await readTrust(foundationsDir(f.home), { kbUrl: f.kb.url, product: "repo", repo: REPO }))?.accepted?.docId, saved.id);
	await f.command("status");
	assert.match(f.messages.at(-1)!, /Foundations: KB · revisión/);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" });
	assert.equal(f.prompts.filter((p) => p === "Autorizar comando del proyecto").length, 0, "el catálogo nuevo vale en esta sesión");
});

test("foundations_setup: sin perillas crea el documento del producto", async (t) => {
	const f = await fixture(t, { body: null }); f.uiControl.questions = batches(BUILD, [KEYS.enter], ALL_ASK, SAVE);
	await f.start();
	assert.equal(saves(f.kb), 1);
	assert.ok(f.kb.documents.at(-1)!.cuerpo.startsWith("# Perillas de repo\n\n## Foundations de omi · test/repo\n"));
});

test("foundations_setup: un comando libre inválido vuelve al texto con el motivo", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = batches(BUILD, [KEYS.space, ...typed("node test.cjs"), KEYS.newLine, ...typed("  npm x"), KEYS.enter, KEYS.esc, ...NODE_TEST], ALL_ASK, SAVE);
	await f.start();
	assert.ok(f.asked[1]!.some((screen) => /Línea 2: un comando tiene espacios al borde/.test(screen)), "muestra el motivo");
	assert.equal(saves(f.kb), 1);
	const parsed = parseFoundations(f.kb.documents.at(-1)!.cuerpo, REPO);
	assert.deepEqual(parsed.status === "valid" && parsed.block.comandos, ["node test.cjs"]);
});

test("foundations_setup: «Cancelar» o Esc en el resumen, o Esc en una pregunta, no guardan", async (t) => {
	for (const keys of [[NODE_TEST, ALL_ASK, ["3", KEYS.enter]], [NODE_TEST, ALL_ASK, [KEYS.esc]], [NODE_TEST, [KEYS.esc]], [[KEYS.esc]]]) {
		const f = await fixture(t); f.uiControl.questions = batches(BUILD, ...keys);
		await f.start();
		assert.equal(saves(f.kb), 0, JSON.stringify(keys));
		assert.equal(f.asked.length, keys.length + 1);
	}
});

test("foundations_setup: en el resumen un número sólo mueve el cursor; guarda recién con Enter", async (t) => {
	const f = await fixture(t); f.uiControl.questions = batches(BUILD, NODE_TEST, ALL_ASK, ["1"]);
	await f.start();
	assert.equal(saves(f.kb), 0, "un «1» suelto no guarda en la KB");
	assert.match(f.asked[3]!.at(-1)!, /› 1\. Guardar en la KB/, "el cursor quedó en Guardar");
	assert.match(f.asked[3]!.at(-1)!, /1–3 moverse · Enter confirmar/, "la ayuda lo dice");
});

test("foundations_setup: «Cambiar respuestas» vuelve a las preguntas con lo elegido y guarda lo nuevo", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = batches(BUILD, [KEYS.enter], ALL_ASK, ["2", KEYS.enter], NODE_TEST, [KEYS.enter, KEYS.enter], SAVE);
	await f.start();
	assert.equal(f.asked.length, 7);
	assert.match(f.asked[5]![0]!, /■ Arranque/, "las políticas vuelven respondidas");
	assert.equal(saves(f.kb), 1);
	const parsed = parseFoundations(f.kb.documents.at(-1)!.cuerpo, REPO);
	assert.equal(parsed.status === "valid" && parsed.hash, foundationsHash(block()));
});

test("foundations_setup: los comandos detectados del repo son opciones a marcar, con su origen", async (t) => {
	const f = await fixture(t);
	await f.write("package.json", JSON.stringify({ scripts: { test: "node test.cjs", deploy: "x" } })); await f.write("package-lock.json", "{}");
	for (const args of [["add", "."], ["commit", "-m", "chore: scripts"]]) execFileSync("git", args, { cwd: f.checkout.root, stdio: "ignore" });
	await f.attach(); f.uiControl.questions = batches(BUILD, ["2", KEYS.enter], ALL_ASK, SAVE);
	await f.start();
	const screen = f.asked[1]![0]!;
	assert.match(screen, /1\. \[ \] npm ci/); assert.match(screen, /Instala las dependencias según package-lock\.json/);
	assert.match(screen, /2\. \[ \] npm test/); assert.match(screen, /Script «test» de package\.json/);
	assert.doesNotMatch(screen, /deploy/);
	const parsed = parseFoundations(f.kb.documents.at(-1)!.cuerpo, REPO);
	assert.deepEqual(parsed.status === "valid" && parsed.block.comandos, ["npm test"]);
});

test("foundations_setup: sin la TUI interactiva (RPC) no se ofrece", async (t) => {
	const f = await fixture(t); Reflect.set(f.context, "mode", "rpc"); f.uiControl.questions = batches(BUILD);
	await f.start();
	assert.equal(f.selects.length, 0); assert.equal(f.asked.length, 0); assert.equal(saves(f.kb), 0);
});

test("foundations_setup: si las perillas cambian durante el diálogo no se guarda", async (t) => {
	const f = await fixture(t); f.uiControl.questions = batches(BUILD, NODE_TEST, ALL_ASK, SAVE);
	let searches = 0;
	f.kb.hook = (tool) => { if (tool === "buscar" && ++searches === 3) f.kb.perillas("repo", "Otra persona guardó."); };
	await f.start();
	assert.equal(saves(f.kb), 0);
	assert.ok(f.messages.some((m) => /cambiaron/.test(m)));
});

test("foundations_setup: un producto fuera de mis_productos no se ofrece ni se guarda", async (t) => {
	const f = await fixture(t, { products: ["otro"] }); f.uiControl.questions = batches(BUILD);
	await f.start();
	assert.equal(f.selects.length, 0); assert.equal(f.asked.length, 0); assert.equal(saves(f.kb), 0);
});

async function save(kb: MemoryKb | Awaited<ReturnType<typeof createHttpKb>>, trustDir: string) {
	const key = { kbUrl: kb.url, product: "repo", repo: REPO }; const signal = AbortSignal.timeout(5000);
	const prepared = await prepareFoundationsSave(kb, key, block(), signal);
	return commitFoundationsSave(kb, key, block(), prepared, { trustDir, now: () => "2026-11-18T04:00:00Z", signal });
}
test("foundations_setup: una respuesta perdida se reintenta con la misma clave y deja un solo documento", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", HUMAN);
	let first = true; kb.hook = (tool) => { if (tool === "guardar" && first) { first = false; return "drop"; } };
	const pin = await save(kb, foundationsDir(await tempDir(t)));
	const claves = kb.calls.filter((c) => c.tool === "guardar").map((c) => c.args.clave);
	assert.equal(claves.length, 2); assert.equal(claves[0], claves[1]);
	assert.equal(kb.documents.filter((d) => d.cuerpo.includes("omi-foundations")).length, 1);
	assert.equal(pin.origin, "kb");
});

// La clave es determinista (repo, perillas previas y cuerpo): reintentar no necesita nada guardado en disco.
test("foundations_setup: un guardado que falla no deja nada en el registro, y uno exitoso no guarda la clave", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", HUMAN);
	const dir = foundationsDir(await tempDir(t)); const key = { kbUrl: kb.url, product: "repo", repo: REPO };
	kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(save(kb, dir), /KB no disponible/);
	assert.equal(await readTrust(dir, key), undefined, "nada aceptado ni pendiente");
	kb.hook = () => {};
	await save(kb, dir);
	const stored: unknown = JSON.parse(await readFile(trustPath(dir, key), "utf8"));
	assert.deepEqual(Object.keys(stored && typeof stored === "object" ? stored : {}).sort(), ["accepted", "kbUrl", "offerDeclined", "product", "repo", "version"]);
});

// Mismo camino con el MCP real de Pi por HTTP: transporte, clave y error de la respuesta.
async function createHttpKb(t: TestContext) {
	const kb = await mockKb(t, { products: ["repo"] }); kb.perillas("repo", HUMAN);
	const client = createKbClient({ url: kb.url, agentDir: await tempDir(t), enabled: true });
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>(); const tools = new Map<string, ToolDefinition>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool: (d: ToolDefinition) => { tools.set(d.name, d); }, registerToolRenderer: () => {}, registerCommand: () => {}, registerMcpServer: () => {},
		getMcpServers: () => [{ name: "harness-kb", config: { url: kb.url, exposure: "deferred" }, extensionPath: "omi-kb" }], getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
	const ctx = { cwd: await tempDir(t), modelRegistry: {}, hasUI: false, isProjectTrusted: () => true, ui: { notify: () => {} } };
	await client.extension().factory(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	t.after(async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx); });
	assert.deepEqual(await client.ready(ctx.cwd, AbortSignal.timeout(5000)), { ready: true });
	return Object.assign(client, { mock: kb });
}
test("foundations_setup: por HTTP conserva el resto y recupera una respuesta perdida", async (t) => {
	const kb = await createHttpKb(t);
	let first = true; kb.mock.hook = (tool) => { if (tool === "guardar" && first) { first = false; return "drop"; } };
	const pin = await save(kb, foundationsDir(await tempDir(t)));
	const saved = kb.mock.documents.filter((d) => d.cuerpo.includes("omi-foundations"));
	assert.equal(saved.length, 1); assert.ok(saved[0]!.cuerpo.startsWith(HUMAN));
	assert.equal(pin.docId, saved[0]!.id);
	assert.equal(FOUNDATIONS_OFFER.length, 3);
});
