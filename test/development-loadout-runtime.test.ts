// Pi real (#47): cada request deja en el transcript las tools que declaró, y retomar, recargar o moverse
// en el árbol restaura las últimas. Con el harness activo ésas son las restringidas, no las de la persona.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, parseArgs, SessionManager, SettingsManager, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { codemodeDefaultExtension } from "../src/tui/defaults.ts";
import { developmentHarnessExtension } from "../src/tui/development.ts";
import { issueDevelopmentTicket } from "../src/tui/development-tickets.ts";
import { developmentFixture } from "./helpers/development.ts";
import { testIo } from "./helpers/io.ts";

const sorted = (names: readonly string[]) => [...names].sort();
// Las que el harness quita y la persona tiene que recuperar al salir.
const WITHHELD = ["bash", "edit", "write", "codemode"];

function reply(): string {
	const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	return `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

async function harnessRuntime(t: TestContext) {
	const f = await developmentFixture(t);
	// Las tools que declaró cada request al modelo.
	const requests: string[][] = [];
	const server = createServer((request, response) => {
		let body = ""; request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			requests.push(((JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools ?? []).map((tool) => tool.function.name));
			response.writeHead(200, { "content-type": "text/event-stream" }); response.end(reply());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const agentDir = join(f.home, ".omi/agent"); await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } } }));
	const notices: string[] = [];
	const ui = {
		select: async () => undefined, confirm: async () => true, input: async () => undefined, editor: async () => undefined, custom: async () => undefined, notify: (message: string) => { notices.push(message); },
		onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {}, setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
		pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", addAutocompleteProvider: () => {}, setEditorComponent: () => {}, getEditorComponent: () => undefined,
		getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false }), getToolsExpanded: () => false, setToolsExpanded: () => {},
	} as unknown as ExtensionUIContext;
	// Como `omi`: los flags llegan a Pi y a las extensiones; codemode es el builtin de Pi y OMI lo activa por defecto.
	const open = async (manager: SessionManager, args: string[] = [], settings: { extensions?: readonly string[] } = {}): Promise<AgentSession> => {
		const cwd = f.checkout.root; const settingsManager = SettingsManager.inMemory({ defaultProvider: "mock", defaultModel: "m", ...(settings.extensions ? { extensions: [...settings.extensions] } : {}) });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true }, await codemodeDefaultExtension(args), developmentHarnessExtension(testIo({ homeDir: f.home, cwd }), args, { runner: f.runner })] });
		await resourceLoader.reload();
		const cli = parseArgs(args);
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: manager, ...(cli.tools ? { tools: cli.tools } : {}), ...(cli.excludeTools ? { excludeTools: cli.excludeTools } : {}) });
		t.after(() => session.dispose());
		await session.bindExtensions({ uiContext: ui });
		return session;
	};
	// El comando despacha un request aparte (el arranque del harness): se espera a que termine.
	const run = async (session: AgentSession, text: string) => {
		const expected = requests.length + 1; await session.prompt(text);
		for (let tries = 0; requests.length < expected && tries < 500; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
		await session.waitForIdle(); assert.equal(requests.length, expected, `sin request: ${notices.join(" | ")}`);
	};
	const begin = async (session: AgentSession) => {
		await run(session, `/omi-work begin ${issueDevelopmentTicket({ kind: "start", sessionFile: f.manager.getSessionFile()!, issue: 42 })}`);
		// Precondición del bug: Pi declaró al modelo, y guardó en el transcript, el loadout restringido.
		for (const name of WITHHELD) assert.ok(!requests.at(-1)!.includes(name), `el harness declaró ${name}`);
	};
	const stop = async (session: AgentSession) => { await session.prompt("/omi-work stop"); assert.match(notices.at(-1) ?? "", /Sin harness activo/); };
	const resume = () => open(SessionManager.open(f.manager.getSessionFile()!));
	return { f, requests, open, run, begin, stop, resume };
}

async function started(t: TestContext) {
	const r = await harnessRuntime(t);
	const first = await r.open(r.f.manager); const normal = first.getActiveToolNames();
	for (const name of ["read", ...WITHHELD]) assert.ok(normal.includes(name), `el chat normal ofrece ${name}`);
	await r.begin(first);
	return { ...r, first, normal };
}

test("harness real · retomar con el harness activo y salir devuelve las tools de la persona", { timeout: 30000 }, async (t) => {
	const r = await started(t); r.first.dispose();
	const resumed = await r.resume();
	await r.stop(resumed);
	assert.deepEqual(sorted(resumed.getActiveToolNames()), sorted(r.normal));
});

test("harness real · /reload con el harness activo y salir devuelve las tools de la persona", { timeout: 30000 }, async (t) => {
	const r = await started(t);
	await r.first.reload();
	await r.stop(r.first);
	assert.deepEqual(sorted(r.first.getActiveToolNames()), sorted(r.normal));
});

test("harness real · después de salir, /reload conserva las tools que la persona cambió", { timeout: 30000 }, async (t) => {
	const r = await started(t);
	await r.stop(r.first);
	const chosen = r.normal.filter((name) => name !== "edit"); r.first.setActiveToolsByName(chosen);
	await r.first.reload();
	assert.deepEqual(sorted(r.first.getActiveToolNames()), sorted(chosen));
});

test("harness real · salir, cerrar antes de otro request y retomar no vuelve al loadout restringido", { timeout: 30000 }, async (t) => {
	const r = await started(t);
	await r.stop(r.first); assert.deepEqual(sorted(r.first.getActiveToolNames()), sorted(r.normal));
	r.first.dispose();
	const resumed = await r.resume();
	assert.deepEqual(sorted(resumed.getActiveToolNames()), sorted(r.normal));
});

test("harness real · volver por el árbol a la rama del harness y salir devuelve las tools de la persona", { timeout: 30000 }, async (t) => {
	const r = await harnessRuntime(t);
	const session = await r.open(r.f.manager); const normal = session.getActiveToolNames();
	await r.run(session, "hola"); const beforeHarness = r.f.manager.getLeafId()!;
	await r.begin(session); const harnessLeaf = r.f.manager.getLeafId()!;
	await session.navigateTree(beforeHarness);
	assert.deepEqual(sorted(session.getActiveToolNames()), sorted(normal), "antes del harness, las de la persona");
	await session.navigateTree(harnessLeaf);
	assert.ok(!session.getActiveToolNames().includes("bash"), "la rama del harness vuelve a restringir");
	await r.stop(session);
	assert.deepEqual(sorted(session.getActiveToolNames()), sorted(normal));
});

test("harness real · salir, un request normal y retomar conserva lo que la persona eligió después", { timeout: 30000 }, async (t) => {
	const r = await started(t);
	await r.stop(r.first);
	const chosen = r.normal.filter((name) => name !== "edit"); r.first.setActiveToolsByName(chosen);
	await r.run(r.first, "hola"); r.first.dispose();
	const resumed = await r.resume();
	assert.deepEqual(sorted(resumed.getActiveToolNames()), sorted(chosen));
});

test("harness real · moverse por el árbol a una rama con otro loadout deja el de esa rama", { timeout: 30000 }, async (t) => {
	const r = await harnessRuntime(t);
	const session = await r.open(r.f.manager); const normal = session.getActiveToolNames();
	// Declarar primero todas: Pi activa al restaurar las tools de extensión que la rama nunca mencionó.
	await r.run(session, "hola"); session.setActiveToolsByName(["read"]); await r.run(session, "sólo leer"); const readOnly = r.f.manager.getLeafId()!;
	session.setActiveToolsByName(normal); await r.begin(session);
	await session.navigateTree(readOnly);
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
});

test("harness real · retomar con otra lista explícita de --tools y salir deja la nueva", { timeout: 30000 }, async (t) => {
	const r = await harnessRuntime(t);
	const first = await r.open(r.f.manager, ["--tools", "read,bash"]); await r.begin(first); first.dispose();
	const resumed = await r.open(SessionManager.open(r.f.manager.getSessionFile()!), ["--tools", "read,bash,edit"]);
	await r.stop(resumed);
	assert.deepEqual(sorted(resumed.getActiveToolNames()), ["bash", "edit", "read"]);
});

// Lo que la persona elige al volver a abrir prevalece sobre lo guardado, con las reglas de Pi.
for (const [label, args, settings, expected] of [
	["--tools read,bash", ["--tools", "read,bash"], {}, (_normal: string[]) => ["read", "bash"]],
	["--tools -codemode", ["--tools", "-codemode"], {}, (normal: string[]) => normal.filter((name) => name !== "codemode")],
	["--exclude-tools edit", ["--exclude-tools", "edit"], {}, (normal: string[]) => normal.filter((name) => name !== "edit")],
	["extensions: -builtin:codemode", [], { extensions: ["-builtin:codemode"] }, (normal: string[]) => normal.filter((name) => name !== "codemode")],
] as const) test(`harness real · retomar con ${label} y salir respeta la nueva selección`, { timeout: 30000 }, async (t) => {
	const r = await started(t); r.first.dispose();
	const resumed = await r.open(SessionManager.open(r.f.manager.getSessionFile()!), [...args], settings);
	await r.stop(resumed);
	assert.deepEqual(sorted(resumed.getActiveToolNames()), sorted(expected([...r.normal])));
});
