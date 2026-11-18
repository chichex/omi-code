// Sin Foundations, el harness ofrece armarlo y lo guarda en la KB sólo con el sí. Nunca la KB real.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseFoundations, foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust } from "../src/harness/foundations-trust.ts";
import { commitFoundationsSave, prepareFoundationsSave, shouldOfferFoundations, FOUNDATIONS_OFFER } from "../src/tui/development-foundations-setup.ts";
import { createKbClient } from "../src/tui/kb-client.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb, mockKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";

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
const choose = (option: string) => (_title: string, options: string[]) => options.find((o) => o.startsWith(option));

test("foundations_setup: se ofrece una vez por sesión y «Ahora no» no guarda nada", async (t) => {
	const f = await fixture(t); await f.start();
	assert.equal(f.selects.length, 1);
	assert.match(f.selects[0]!.title, /Foundations/);
	assert.deepEqual(f.selects[0]!.options.map((o) => o.split(" ")[0]), ["Armar", "Ahora", "No"]);
	await f.attach(); await f.command("resume"); await f.start();
	assert.equal(f.selects.length, 1, "no se vuelve a ofrecer en la misma sesión");
	assert.equal(saves(f.kb), 0);
});

test("foundations_setup: «No ofrecer más» queda registrado y no vuelve", async (t) => {
	const f = await fixture(t); f.uiControl.select = choose("No ofrecer");
	await f.start();
	const record = await readTrust(foundationsDir(f.home), { kbUrl: f.kb.url, product: "repo", repo: REPO });
	assert.equal(record?.offerDeclined, true); assert.equal(record?.accepted, null);
	const pin = { origin: "strict" as const, block: null, hash: null, docId: null, author: null, date: null, notice: "", reading: { kind: "missing" as const, key: { kbUrl: f.kb.url, product: "repo", repo: REPO }, perillas: null } };
	assert.equal(shouldOfferFoundations(pin, record, true), false);
	assert.equal(shouldOfferFoundations(pin, undefined, true), true);
	assert.equal(shouldOfferFoundations(pin, undefined, false), false, "sin UI no se ofrece");
	assert.equal(shouldOfferFoundations({ ...pin, reading: { kind: "none", reason: "" } }, undefined, true), false);
	assert.equal(saves(f.kb), 0);
});

test("foundations_setup: el sí guarda una vez, conserva el resto de las perillas y vale en la sesión", async (t) => {
	const f = await fixture(t); f.uiControl.select = choose("Armar");
	f.uiControl.editor = () => JSON.stringify(block());
	await f.start();
	assert.equal(saves(f.kb), 1);
	const saved = f.kb.documents.at(-1)!;
	assert.ok(saved.cuerpo.startsWith(HUMAN), "el resto del documento queda byte por byte");
	const parsed = parseFoundations(saved.cuerpo, REPO);
	assert.equal(parsed.status === "valid" && parsed.hash, foundationsHash(block()));
	assert.match(f.confirmationDetails.find((d) => d.includes("Se guarda en la KB"))!, /producto repo/);
	assert.equal((await readTrust(foundationsDir(f.home), { kbUrl: f.kb.url, product: "repo", repo: REPO }))?.accepted?.docId, saved.id);
	await f.command("status");
	assert.match(f.messages.at(-1)!, /Foundations: KB · revisión/);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" });
	assert.equal(f.prompts.filter((p) => p === "Autorizar comando del proyecto").length, 0, "el catálogo nuevo vale en esta sesión");
});

test("foundations_setup: sin perillas crea el documento del producto", async (t) => {
	const f = await fixture(t, { body: null }); f.uiControl.select = choose("Armar"); f.uiControl.editor = () => JSON.stringify(block([]));
	await f.start();
	assert.equal(saves(f.kb), 1);
	assert.ok(f.kb.documents.at(-1)!.cuerpo.startsWith("# Perillas de repo\n\n## Foundations de omi · test/repo\n"));
});

test("foundations_setup: un texto inválido vuelve al editor con el motivo", async (t) => {
	const f = await fixture(t); f.uiControl.select = choose("Armar");
	const answers = ["{ roto", JSON.stringify({ ...block(), repo: "acme/otro" }), JSON.stringify(block())];
	f.uiControl.editor = () => answers.shift();
	await f.start();
	assert.equal(f.editors.length, 3); assert.equal(f.editors[1], "{ roto", "vuelve con lo que escribió");
	assert.ok(f.messages.some((m) => /no es JSON válido/.test(m)));
	assert.equal(saves(f.kb), 1);
});

test("foundations_setup: un no en la confirmación no guarda", async (t) => {
	const f = await fixture(t); f.uiControl.select = choose("Armar");
	const original = f.remote.confirmations;
	f.uiControl.editor = () => { f.remote.confirmations = false; return JSON.stringify(block()); };
	await f.start();
	f.remote.confirmations = original;
	assert.equal(saves(f.kb), 0);
});

test("foundations_setup: si las perillas cambian durante el diálogo no se guarda", async (t) => {
	const f = await fixture(t); f.uiControl.select = choose("Armar"); f.uiControl.editor = () => JSON.stringify(block());
	let searches = 0;
	f.kb.hook = (tool) => { if (tool === "buscar" && ++searches === 3) f.kb.perillas("repo", "Otra persona guardó."); };
	await f.start();
	assert.equal(saves(f.kb), 0);
	assert.ok(f.messages.some((m) => /cambiaron/.test(m)));
});

test("foundations_setup: un producto fuera de mis_productos no se ofrece ni se guarda", async (t) => {
	const f = await fixture(t, { products: ["otro"] }); f.uiControl.select = choose("Armar");
	await f.start();
	assert.equal(f.selects.length, 0); assert.equal(saves(f.kb), 0);
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
