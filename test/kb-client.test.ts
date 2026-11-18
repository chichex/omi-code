// Lectura de la KB desde el host con el MCP real de Pi. Depende de internos de Pi: si un bump los rompe, esto falla.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { DefaultResourceLoader, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKbClient, type KbClient } from "../src/tui/kb-client.ts";
import { mockKb, type MockKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";

// Pi resuelve mcp-auth.json, mcp.log y mcp.json en cada llamada: nunca el ~/.pi real.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "omi-kb-agent-"));
const signal = () => AbortSignal.timeout(5000);
type Handler = (event: unknown, ctx: unknown) => unknown;

async function host(t: TestContext, kb: MockKb | undefined, options: { enabled?: boolean; readyTimeoutMs?: number; agentDir?: string; run?: boolean } = {}) {
	const agentDir = options.agentDir ?? await tempDir(t); const cwd = await tempDir(t);
	const client = createKbClient({ url: kb?.url ?? "http://127.0.0.1:9/mcp", agentDir, enabled: options.enabled ?? true, readyTimeoutMs: options.readyTimeoutMs ?? 3000 });
	const handlers = new Map<string, Handler[]>(); const tools = new Map<string, ToolDefinition>(); const notices: string[] = []; let active: string[] = [];
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); }, registerToolRenderer: () => {}, registerCommand: () => {}, registerMcpServer: () => {},
		getMcpServers: () => kb ? [{ name: "harness-kb", config: { url: kb.url, exposure: "deferred", description: "KB" }, extensionPath: "omi-kb" }] : [],
		getAllTools: () => [...tools.values()].map((d) => ({ name: d.name, exposure: d.exposure ?? "direct" })), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	const ctx = { cwd, modelRegistry: {}, hasUI: false, isProjectTrusted: () => true, ui: { notify: (message: string) => notices.push(message) } };
	const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" }, ctx); };
	if (options.run !== false) {
		const extension = client.extension();
		await extension.factory(pi);
		await emit("session_start");
		t.after(() => emit("session_shutdown"));
	}
	return { client, tools, handlers, cwd, agentDir, notices, emit, pi, ctx };
}

test("kb_client: el host lee las perillas vigentes sin el modelo ni el ctx de una tool", async (t) => {
	const kb = await mockKb(t); kb.perillas("omi-code", "viejas"); const current = kb.perillas("omi-code", "# Perillas\n\nvigentes");
	const { client, cwd } = await host(t, kb);
	assert.deepEqual(await client.ready(cwd, signal()), { ready: true });
	assert.deepEqual(await client.products(signal()), ["omi-code"]);
	const doc = await client.currentPerillas("omi-code", signal());
	assert.equal(doc?.id, current.id); assert.equal(doc?.cuerpo, "# Perillas\n\nvigentes"); assert.equal(doc?.autor, "ana@example.test");
	assert.equal(await client.currentPerillas("omi", signal()), null);
	for (const method of ["initialize", "tools/list", "tools/call"]) assert.ok(kb.methods.includes(method), `falta ${method}`);
	assert.deepEqual(kb.calls.find((c) => c.tool === "buscar")?.args, { producto: "omi-code", tipo: "perillas", consulta: "", limite: 1 });
});

test("kb_client: guardar usa la clave y repetirla recupera el original", async (t) => {
	const kb = await mockKb(t); const { client, cwd } = await host(t, kb);
	await client.ready(cwd, signal());
	const input = { product: "omi-code", titulo: "Perillas de omi-code", cuerpo: "cuerpo", clave: "omi-foundations|x|none|abc" };
	const first = await client.save(input, signal());
	assert.deepEqual(await client.save(input, signal()), first);
	assert.equal(kb.documents.length, 1);
	assert.deepEqual(kb.calls.filter((c) => c.tool === "guardar").map((c) => c.args), [1, 2].map(() => ({ producto: "omi-code", tipo: "perillas", titulo: "Perillas de omi-code", cuerpo: "cuerpo", clave: "omi-foundations|x|none|abc" })));
	assert.equal((await client.read(first.id, signal())).cuerpo, "cuerpo");
});

test("kb_client: sin login (401) da no disponible dentro del tope y sin llamar tools", async (t) => {
	const kb = await mockKb(t); kb.unauthorized = true;
	const { client, cwd } = await host(t, kb, { readyTimeoutMs: 400 });
	const started = Date.now();
	const result = await client.ready(cwd, signal());
	assert.equal(result.ready, false);
	assert.ok(Date.now() - started < 3000);
	assert.equal(kb.calls.length, 0);
	await assert.rejects(client.products(signal()), /KB no disponible/);
});

test("kb_client: isError, JSON inválido o un documento de otro producto cuentan como error", async (t) => {
	const kb = await mockKb(t); const doc = kb.perillas("omi-code", "x"); const { client, cwd } = await host(t, kb);
	await client.ready(cwd, signal());
	kb.hook = (tool) => tool === "mis_productos" ? "error" : undefined;
	await assert.rejects(client.products(signal()), /KB/);
	kb.hook = (tool) => tool === "buscar" ? "invalid" : undefined;
	await assert.rejects(client.currentPerillas("omi-code", signal()), /KB/);
	kb.hook = (tool) => { if (tool === "leer") doc.producto = "otro"; };
	await assert.rejects(client.currentPerillas("omi-code", signal()), /otro producto/);
});

for (const where of ["global", "proyecto"] as const) for (const name of ["harness-kb", "harness_kb"]) test(`kb_client: ${name} redefinido en el mcp.json ${where} deja la KB sin usar`, async (t) => {
	const kb = await mockKb(t); const agentDir = await tempDir(t);
	const { client, cwd } = await host(t, kb, { agentDir });
	const file = where === "global" ? join(agentDir, "mcp.json") : join(cwd, ".pi", "mcp.json");
	await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ mcpServers: { [name]: { url: "https://otra.example.test/mcp" } } }));
	const result = await client.ready(cwd, signal());
	assert.equal(result.ready, false); assert.match(result.ready ? "" : result.reason, /redefin/);
	await writeFile(file, "{ roto");
	assert.equal((await client.ready(cwd, signal())).ready, false);
});

test("kb_client: un mcp.json con otros servidores no molesta", async (t) => {
	const kb = await mockKb(t); const agentDir = await tempDir(t);
	await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.test/mcp" } } }));
	const { client, cwd } = await host(t, kb, { agentDir });
	assert.deepEqual(await client.ready(cwd, signal()), { ready: true });
});

test("kb_client: un hook tool_call que bloquea guardar no frena al host", async (t) => {
	const kb = await mockKb(t); const { client, cwd, handlers } = await host(t, kb);
	await client.ready(cwd, signal());
	const before = handlers.get("tool_call")?.length ?? 0; let hooked = 0;
	handlers.set("tool_call", [...(handlers.get("tool_call") ?? []), () => { hooked++; return { block: true, reason: "bloqueado" }; }]);
	await client.save({ product: "omi-code", titulo: "t", cuerpo: "c", clave: "k" }, signal());
	assert.equal(hooked, 0); assert.equal(kb.documents.length, 1); assert.ok(before >= 0);
});

test("kb_client: desactivado o sin extensión cargada da no disponible al instante", async (t) => {
	const kb = await mockKb(t);
	const off = await host(t, kb, { enabled: false });
	assert.equal((await off.client.ready(off.cwd, signal())).ready, false);
	const detached = await host(t, kb, { run: false });
	const started = Date.now();
	assert.equal((await detached.client.ready(detached.cwd, signal())).ready, false);
	assert.ok(Date.now() - started < 1000);
	assert.equal(kb.calls.length, 0);
});

test("kb_client: recargar la extensión descarta las definiciones anteriores", async (t) => {
	const kb = await mockKb(t); const first = await host(t, kb);
	await first.client.ready(first.cwd, signal());
	await first.emit("session_shutdown");
	const extension = first.client.extension(); await extension.factory(first.pi);
	assert.equal((await createKbClientReady(first.client, first.cwd, 300)).ready, false, "una definición de la instancia vieja no se usa");
	await first.emit("session_start");
	assert.deepEqual(await first.client.ready(first.cwd, signal()), { ready: true });
});
const createKbClientReady = (client: KbClient, cwd: string, ms: number) => client.ready(cwd, AbortSignal.timeout(ms));

test("kb_client: el builtin mcp de OMI reemplaza al de Pi por nombre y -builtin:mcp lo apaga", async (t) => {
	const kb = await mockKb(t); const agentDir = await tempDir(t); const cwd = await tempDir(t);
	const client = createKbClient({ url: kb.url, agentDir, enabled: true });
	let piBuiltin = 0;
	const factories = [{ name: "mcp", builtin: true, replaceable: true, factory: () => { piBuiltin++; } }, client.extension()];
	const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(piBuiltin, 0, "corrió el builtin de Pi en lugar del de OMI");
	const mcp = loaded.extensions.find((e) => e.path === "builtin:mcp");
	assert.ok(mcp?.commands.has("mcp"), "el MCP real de Pi no se registró a través del Proxy");
	const disabled = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [client.extension()], disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await disabled.reload();
	assert.equal(disabled.getExtensions().extensions.some((e) => e.path === "builtin:mcp"), false);
});

// Pi arma los builtins como [...builtInExtensions, ...extensionFactories]: el de OMI va después y gana por nombre.
test("kb_client: Pi sigue poniendo los builtins propios antes que los de OMI", async () => {
	const main = await readFile(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "main.js"), "utf8");
	assert.match(main, /\[\.\.\.builtInExtensions, \.\.\.\(options\?\.extensionFactories \?\? \[\]\)\]/);
});

test("kb_client: sin un directorio de configuración absoluto no se usa la KB", async (t) => {
	const kb = await mockKb(t); const { client, cwd } = await host(t, kb, { agentDir: "" });
	const result = await client.ready(cwd, signal());
	assert.equal(result.ready, false); assert.match(result.ready ? "" : result.reason, /directorio/);
});
