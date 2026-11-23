// El panel configura v2 sólo con Guardar. Git temporal, KB en memoria o MCP HTTP falso, nunca KB real.
// Arrancar el harness sin Foundations lo ofrece una vez (Configurar ahora o Más adelante); Esc no escribe nada.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLICY, foundationsHash, parseFoundations, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, trustPath } from "../src/harness/foundations-trust.ts";
import { commitFoundationsSave, FoundationsSaveError, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { createKbClient } from "../src/tui/kb-client.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb, mockKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
import { KEYS, typed } from "./helpers/questions.ts";

process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "omi-kb-agent-"));
const HUMAN = '# Perillas de repo\n\nTono: formal.\n\n```json\n{ "otra": "perilla" }\n```\n';
const REPO = "test/repo";
const block = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: REPO, confirmar, politica: { ...STRICT_POLICY } });
/** Sin v2 vigente el panel parte de lo que vale: el default, todo auto. */
const fresh = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: REPO, confirmar, politica: { ...DEFAULT_POLICY } });
const saves = (kb: { calls: { tool: string }[] }) => kb.calls.filter((call) => call.tool === "guardar").length;
const key = (kb: { url: string }) => ({ kbUrl: kb.url, product: "repo", repo: REPO });
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
async function fixture(t: TestContext, body: string | null = HUMAN, products = ["repo"]) {
	const kb = memoryKb({ products }); if (body !== null) kb.perillas("repo", body);
	return Object.assign(await developmentFixture(t, { kb }), { kb });
}
const SAVE = ["\x13", "\x13"];
/** El panel abre en la primera política: tres filas abajo está Reglas de comandos y Enter abre su editor. */
const TO_RULES = [KEYS.down, KEYS.down, KEYS.down, KEYS.enter];

// Cambio de requisito del dueño (2026-11-23): lo que falta configurar se detecta solo y corre Foundations al arrancar.
test("foundations_setup v2: arrancar el harness sin Foundations lo ofrece; Esc no escribe y Más adelante posterga esa revisión", async (t) => {
	for (const body of [HUMAN, null]) {
		const f = await fixture(t, body); f.uiControl.questions = () => [KEYS.esc]; await f.start();
		assert.equal(f.asked.length, 1, "una sola oferta: Esc corta el setup"); const offer = f.asked[0]![0]!;
		assert.match(offer, /Foundations de test\/repo/); assert.match(offer, /Configurar ahora/); assert.match(offer, /Más adelante/); assert.match(offer, /Sin Foundations para test\/repo/);
		assert.equal(f.selects.length, 0); assert.deepEqual(f.prompts, []); assert.equal(f.foundationsScreens.length, 0); assert.equal(saves(f.kb), 0);
		assert.equal(await readTrust(foundationsDir(f.home), key(f.kb)), undefined, "Esc no deja nada en el registro local");
		assert.equal((await f.state()).phase, "explore", "el harness sigue igual");
		const later = await fixture(t, body); later.uiControl.questions = (screen) => /Foundations de/.test(screen) ? ["2"] : [KEYS.esc]; await later.start();
		assert.equal(later.foundationsScreens.length, 0, "Más adelante no abre el panel"); assert.equal(saves(later.kb), 0);
		const stored = await readTrust(foundationsDir(later.home), key(later.kb));
		assert.equal(stored?.accepted, null, "postergar no acepta nada"); assert.equal(stored?.deferred?.revision, "foundations:missing");
	}
});
test("foundations_setup v2: /omi-foundations abre el panel integrado y sólo Guardar persiste/acepta, preservando perillas", async (t) => {
	const f = await fixture(t); f.uiControl.foundations = () => [...TO_RULES, ...typed("git push *"), ...SAVE];
	// Arrancar ofrece el setup (Esc lo corta): /omi-foundations abre el panel directo, sin tandas de preguntas.
	await f.start(); const offered = f.asked.length; await f.run("omi-foundations"); assert.equal(f.asked.length, offered, "no hay wizard de comandos/políticas por pestañas"); assert.equal(f.editors.length, 0);
	assert.equal(f.foundationsScreens.length, 1); assert.equal(saves(f.kb), 1);
	const saved = f.kb.documents.at(-1)!; assert.ok(saved.cuerpo.startsWith(HUMAN));
	const parsed = parseFoundations(saved.cuerpo, REPO); assert.ok(parsed.status === "valid"); assert.deepEqual(parsed.block, fresh(["git push *"]));
	assert.equal((await readTrust(foundationsDir(f.home), key(f.kb)))?.accepted?.docId, saved.id);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node test.cjs" }); assert.ok(!f.prompts.includes("Autorizar comando del proyecto"));
});
test("foundations_setup v2: sin perillas crea documento sólo al guardar y advierte lista vacía", async (t) => {
	const f = await fixture(t, null); f.uiControl.foundations = () => SAVE; await f.start(); await f.command("foundations");
	assert.equal(saves(f.kb), 1); assert.ok(f.kb.documents.at(-1)!.cuerpo.startsWith("# Perillas de repo\n\n## Foundations de omi"));
	assert.match(f.foundationsScreens[0]!.join("\n"), /SIMPLE/);
});
test("foundations_setup v2: errores vuelven al editor con borrador y línea original, no lo recortan", async (t) => {
	const f = await fixture(t);
	f.uiControl.foundations = () => [paste("git push *\n\n npm test"), "\x13", "\x01", "\x1b[3~", ...SAVE]; await f.start(); await f.command("foundations");
	assert.ok(f.foundationsScreens[0]!.some((screen) => /Línea 3/.test(screen))); assert.equal(saves(f.kb), 1);
	const parsed = parseFoundations(f.kb.documents.at(-1)!.cuerpo, REPO); assert.ok(parsed.status === "valid"); assert.deepEqual(parsed.block.confirmar, ["git push *", "npm test"]);
});
test("foundations_setup v2: cancelar editor o volver desde revisión y cancelar no persiste", async (t) => {
	for (const keys of [[KEYS.esc], [...TO_RULES, ...typed("git push *"), "\x13", KEYS.esc, KEYS.esc, KEYS.esc]]) {
		const f = await fixture(t); f.uiControl.foundations = () => keys; await f.start(); await f.command("foundations");
		assert.equal(f.foundationsScreens.length, 1);
		assert.equal(saves(f.kb), 0); assert.equal(await readTrust(foundationsDir(f.home), key(f.kb)), undefined);
	}
});
test("foundations_setup v2: configuración explícita reabre con valores vigentes, sin aceptar ni guardar al abrir", async (t) => {
	const current = block(["git push *"]); const f = await fixture(t, `${HUMAN}\n${renderFoundationsBlock(current)}`); await f.start();
	const accepted = await readTrust(foundationsDir(f.home), key(f.kb)); f.uiControl.foundations = () => [KEYS.esc]; await f.command("foundations");
	assert.equal(saves(f.kb), 0); assert.deepEqual(await readTrust(foundationsDir(f.home), key(f.kb)), accepted); assert.match(f.foundationsScreens[0]![0]!, /git push \*/);
	f.uiControl.foundations = () => [...TO_RULES, "\x15", ...typed("npm publish"), ...SAVE]; await f.command("foundations");
	f.uiControl.foundations = () => [KEYS.esc]; await f.command("foundations");
	assert.match(f.foundationsScreens.at(-1)![0]!, /npm publish/); assert.doesNotMatch(f.foundationsScreens.at(-1)![0]!, /git push \*/); assert.equal(saves(f.kb), 1);
});
test("foundations_setup v2: abrir antes de tener trabajo no crea issue/worktree ni reanuda el modelo", async (t) => {
	const f = await fixture(t); const messages = f.messages.length; f.uiControl.foundations = () => [KEYS.esc]; await f.command("foundations");
	await assert.rejects(f.state(), /Falta estado/); assert.equal(saves(f.kb), 0); assert.equal(f.messages.length, messages); assert.ok(!f.calls.some((call) => call.command === "gh"));
});
test("foundations_setup v2: v1 falla cerrado y sólo guardado explícito reemplaza su bloque sin heredar comandos/auto", async (t) => {
	const legacy = { version: 1, repo: REPO, comandos: ["NO-HEREDAR"], politica: { ...STRICT_POLICY, arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } };
	const original = `${HUMAN}\n\`\`\`omi-foundations\n${JSON.stringify(legacy)}\n\`\`\`\nFin.\n`;
	const f = await fixture(t, original); await f.start(); assert.ok(!f.prompts.includes("Aceptar Foundations")); assert.equal(saves(f.kb), 0);
	f.uiControl.foundations = () => SAVE; await f.command("foundations"); assert.equal(saves(f.kb), 1);
	assert.doesNotMatch(f.foundationsScreens[0]![0]!, /NO-HEREDAR/); const saved = f.kb.documents.at(-1)!;
	assert.ok(saved.cuerpo.startsWith(HUMAN)); assert.ok(saved.cuerpo.endsWith("\nFin.\n"));
	const parsed = parseFoundations(saved.cuerpo, REPO); assert.ok(parsed.status === "valid"); assert.deepEqual(parsed.block, fresh(), "v1 no se hereda: parte del default vigente"); assert.deepEqual((await f.state()).grants ?? [], []);
});
test("foundations_setup v2: cambio de política durante el panel bloquea guardar sobre revisión ajena", async (t) => {
	const f = await fixture(t, renderFoundationsBlock(block(["git push *"]))); await f.start();
	f.uiControl.foundations = () => { f.kb.perillas("repo", renderFoundationsBlock(block(["npm publish"]))); return SAVE; }; await f.command("foundations");
	assert.equal(saves(f.kb), 0); assert.ok(f.messages.some((message) => /cambi|revisi/i.test(message)));
	assert.equal((await readTrust(foundationsDir(f.home), key(f.kb)))?.accepted?.blockHash, foundationsHash(block(["git push *"])));
});
test("foundations_setup v2: RPC y producto sin acceso no ofrecen panel ni aceptan guardado inexistente", async (t) => {
	const rpc = await fixture(t); Reflect.set(rpc.context, "mode", "rpc"); await rpc.start(); await rpc.command("foundations");
	assert.equal(rpc.asked.length, 0); assert.equal(rpc.foundationsScreens.length, 0); assert.equal(saves(rpc.kb), 0);
	const foreign = await fixture(t, HUMAN, ["otro"]); await foreign.start(); await foreign.command("foundations"); assert.equal(foreign.asked.length, 0); assert.equal(saves(foreign.kb), 0);
});

async function save(kb: MemoryKb | Awaited<ReturnType<typeof createHttpKb>>, trustDir: string) {
	const target = key(kb); const signal = AbortSignal.timeout(5000);
	const prepared = await prepareFoundationsSave(kb, target, block(), signal);
	return commitFoundationsSave(kb, target, block(), prepared, { trustDir, now: () => "2026-11-18T04:00:00Z", signal });
}
test("foundations_setup v2: fallo no deja aceptación pendiente; éxito guarda sólo registro v2 sin clave de retry", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", HUMAN); const dir = foundationsDir(await tempDir(t));
	kb.hook = (tool) => tool === "guardar" ? "error" : undefined; await assert.rejects(save(kb, dir), /KB no disponible/); assert.equal(await readTrust(dir, key(kb)), undefined);
	kb.hook = () => {}; await save(kb, dir); const stored: unknown = JSON.parse(await readFile(trustPath(dir, key(kb)), "utf8"));
	assert.deepEqual(Object.keys(stored && typeof stored === "object" ? stored : {}).sort(), ["accepted", "deferred", "kbUrl", "product", "repo", "version"]);
});
// Mantener el transporte real de Pi por HTTP: cambios de versión no pueden simular éxito de persistencia.
async function createHttpKb(t: TestContext) {
	const kb = await mockKb(t, { products: ["repo"] }); kb.perillas("repo", HUMAN);
	const client = createKbClient({ url: kb.url, agentDir: await tempDir(t), enabled: true });
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>(); const tools = new Map<string, ToolDefinition>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); }, registerToolRenderer: () => {}, registerCommand: () => {}, registerMcpServer: () => {},
		getMcpServers: () => [{ name: "harness-kb", config: { url: kb.url, exposure: "deferred" }, extensionPath: "omi-kb" }], getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
	const ctx = { cwd: await tempDir(t), modelRegistry: {}, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} } };
	await client.extension().factory(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
	t.after(async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx); });
	assert.deepEqual(await client.ready(ctx.cwd, AbortSignal.timeout(5000)), { ready: true }); return Object.assign(client, { mock: kb });
}
test("foundations_setup v2: MCP HTTP real conserva bytes y recupera una respuesta perdida sin duplicar", async (t) => {
	const kb = await createHttpKb(t); let first = true;
	kb.mock.hook = (tool) => { if (tool === "guardar" && first) { first = false; return "drop"; } };
	const pin = await save(kb, foundationsDir(await tempDir(t))); const saved = kb.mock.documents.filter((doc) => doc.cuerpo.includes("omi-foundations"));
	assert.equal(saved.length, 1); assert.ok(saved[0]!.cuerpo.startsWith(HUMAN)); assert.equal(pin.docId, saved[0]!.id);
});
// De #63: cada fallo del guardado dice en qué quedó la KB.
test("foundations_setup v2: los fallos del guardado dicen en qué quedó la KB", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", `${HUMAN}\n${renderFoundationsBlock(block())}\n`);
	const target = key(kb); const trustDir = foundationsDir(await tempDir(t)); const now = () => "2026-11-19T00:00:00Z";
	const next = block(["git push *"]); const signal = AbortSignal.timeout(5000);
	const stage = (expected: string) => (error: unknown) => error instanceof FoundationsSaveError && error.stage === expected;
	await assert.rejects(prepareFoundationsSave(kb, target, next, signal, "0".repeat(64)), stage("conflict"));
	const prepared = await prepareFoundationsSave(kb, target, next, signal, foundationsHash(block()));
	kb.perillas("repo", `${HUMAN}\n${renderFoundationsBlock(block(["otro"]))}\n`);
	await assert.rejects(commitFoundationsSave(kb, target, next, prepared, { trustDir, now, signal }), stage("conflict"));
	const fresh = await prepareFoundationsSave(kb, target, next, signal);
	kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(commitFoundationsSave(kb, target, next, fresh, { trustDir, now, signal }), stage("unconfirmed"));
	kb.hook = () => {};
	await assert.rejects(commitFoundationsSave(kb, target, next, fresh, { trustDir, now, signal, writeAcceptance: async () => { throw new Error("disco lleno"); } }), stage("saved"));
});
test("foundations_setup: abrir sólo avisa si la KB tiene un bloque inválido; un bloque v1 abre como sin configurar y Guardar lo reemplaza", async (t) => {
	const legacy = "```omi-foundations\n" + JSON.stringify({ version: 1, repo: REPO, comandos: ["NO-HEREDAR"], politica: { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } }) + "\n```\n";
	for (const [name, body, expected] of [["sin bloque", HUMAN, undefined], ["v1", `${HUMAN}\n${legacy}`, undefined], ["inválido", `${HUMAN}\n\`\`\`omi-foundations\n{ roto\n\`\`\`\n`, /configuración de la KB es inválida/]] as const) {
		const f = await fixture(t, body); f.uiControl.foundations = () => name === "v1" ? SAVE : [KEYS.esc]; await f.start(); await f.command("foundations");
		const screen = f.foundationsScreens[0]!.join("\n");
		assert.doesNotMatch(screen, /\bv[12]\b|obsolet|Abrir no acepta/i, name); assert.doesNotMatch(screen, /NO-HEREDAR/, name);
		if (expected) assert.match(screen, expected, name); else assert.doesNotMatch(screen, /inválid/i, name);
		if (name !== "v1") continue;
		const saved = f.kb.documents.at(-1)!.cuerpo; assert.ok(saved.startsWith(HUMAN)); assert.doesNotMatch(saved, /NO-HEREDAR|"version": 1/);
		assert.deepEqual(parseFoundations(saved, REPO), { status: "valid", block: fresh(), hash: foundationsHash(fresh()), span: (parseFoundations(saved, REPO) as { span: [number, number] }).span });
		assert.doesNotMatch(f.messages.at(-1) ?? "", /\bv2\b/, "el aviso de guardado no habla de versiones");
	}
});
test("foundations_setup: abrir muestra una espera mientras lee la KB; Esc la cancela sin abrir el panel ni guardar", async (t) => {
	const f = await fixture(t); f.uiControl.foundations = () => [KEYS.esc]; await f.start();
	await f.command("foundations");
	assert.deepEqual(f.loaderTitles, ["Leyendo Foundations de la KB"]); assert.equal(f.foundationsScreens.length, 1);
	f.uiControl.cancelLoader = true; await f.command("foundations");
	assert.equal(f.foundationsScreens.length, 1, "cancelar la lectura no abre el panel"); assert.equal(saves(f.kb), 0);
	assert.match(f.messages.at(-1) ?? "", /Lectura de Foundations cancelada/);
});
