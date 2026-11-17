import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultExtensions, HARNESS_KB_URL } from "../src/tui/defaults.ts";
import { agentDir } from "../src/core/paths.ts";
import { rpc, requestSeenByModel } from "./helpers/foreign-config.ts";
import { exerciseSubagentRuntime } from "./helpers/subagent-runtime.ts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tempDir } from "./helpers/io.ts";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));

test("defaults: subagentes, KB y Claude bridge incluidos como builtins configurables, sin paquetes descargados", async () => {
	const extensions = await defaultExtensions([], {});
	assert.deepEqual(extensions.map((e) => typeof e === "function" ? "" : [e.name, e.builtin]), [["omi-subagents", true], ["omi-claude-bridge", true], ["omi-kb", true]]);
	const kb = extensions[2]!; const servers: unknown[] = [];
	if (typeof kb === "function") throw new Error("expected builtin");
	kb.factory({ on: (_event: string, handler: () => void) => handler(), getSettings: () => ({}), registerMcpServer: (name: string, config: unknown) => servers.push({ name, config }) } as never);
	assert.deepEqual(servers, [{ name: "harness-kb", config: { url: HARNESS_KB_URL, exposure: "deferred", description: "KB de Harness: buscar, leer y guardar documentación de producto y diseño. Requiere login OAuth desde /mcp." } }]);
});

for (const [args, env] of [[ ["--no-mcp"], {} ], [ ["--offline"], {} ], [ [], { PI_OFFLINE: "1" } ], [ [], { PI_OFFLINE: "true" } ]] as const) test(`defaults: no conecta KB con ${JSON.stringify({ args, env })}`, async () => {
	assert.deepEqual((await defaultExtensions(args, env)).map((e) => typeof e === "function" ? "" : e.name), ["omi-subagents", "omi-claude-bridge"]);
});

test("defaults: deshabilitar builtin:mcp no deja registros sin cliente", async () => {
	const kb = (await defaultExtensions([], {}))[2]!;
	if (typeof kb === "function") throw new Error("expected builtin");
	kb.factory({ on: (_event: string, handler: () => void) => handler(), getSettings: () => ({ extensions: ["-builtin:mcp"] }), registerMcpServer: () => assert.fail("MCP deshabilitado") } as never);
});

for (const mode of ["default", "settings", "--no-extensions"] as const) test(`runtime: subagent · ${mode}`, async (t) => {
	const home = await tempDir(t); const dir = agentDir(home); await mkdir(dir, { recursive: true });
	if (mode === "settings") await writeFile(join(dir, "settings.json"), JSON.stringify({ extensions: ["-builtin:omi-subagents"] }));
	const probe = join(home, "probe.ts");
	await writeFile(probe, `export default function(pi) { pi.on("session_start",()=>pi.registerCommand("probe-defaults", {description: JSON.stringify(pi.getAllTools().map(t=>t.name)), handler: async()=>{}})); }`);
	const result = await rpc({ command: process.execPath, args: [bin, ...(mode === "--no-extensions" ? [mode] : []), "--extension", probe], cwd: home, env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "", PI_OFFLINE: "1" } }, { id: "probe", type: "get_commands" }) as { commands: { name: string; description: string }[] };
	const tools = JSON.parse(result.commands.find((c) => c.name === "probe-defaults")!.description) as string[];
	assert.equal(tools.includes("subagent"), mode === "default");
	assert.equal(tools.filter((name) => name === "omi_link_project").length, 1, "OMI no se duplica por MCP");
});

for (const mode of ["default", "settings", "--no-extensions"] as const) test(`runtime: Claude bridge · ${mode}`, async (t) => {
	const home = await tempDir(t); const dir = agentDir(home); await mkdir(dir, { recursive: true });
	const settings = JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4", ...(mode === "settings" ? { extensions: ["-builtin:omi-claude-bridge"] } : {}) });
	await writeFile(join(dir, "settings.json"), settings);
	const executable = join(home, "claude"); await writeFile(executable, "#!/bin/sh\nexit 99\n"); await chmod(executable, 0o700);
	const data = await rpc({ command: process.execPath, args: [bin, "--offline", ...(mode === "--no-extensions" ? [mode] : [])], cwd: home, env: { HOME: home, PATH: `${home}:/usr/bin:/bin`, OMI_HOME: "" } }, { id: "bridge", type: "get_available_models" }) as { models: { provider: string; id: string }[] };
	const models = data.models.filter((model) => model.provider === "claude-bridge");
	assert.equal(models.length > 0, mode === "default");
	assert.equal(new Set(models.map((model) => model.id)).size, models.length);
	const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
	assert.equal(saved.defaultProvider, "openai"); assert.equal(saved.defaultModel, "gpt-5.4");
	assert.equal(saved.packages, undefined, "no instala paquetes en el home al arrancar");
});

test("runtime: conserva una extensión de subagentes del usuario en lugar de duplicarla", async (t) => {
	const home = await tempDir(t); const extension = join(home, "custom-subagent.ts");
	await writeFile(extension, `export default function(pi) {
 pi.registerTool({name:"subagent", label:"custom", description:"USER_SUBAGENT", parameters:{type:"object",properties:{}}, async execute(){return {content:[{type:"text",text:"ok"}],details:{}}}});
 pi.on("session_start",()=>pi.registerCommand("probe-subagent", {description:JSON.stringify(pi.getAllTools().filter(t=>t.name==="subagent").map(t=>t.description)), handler:async()=>{}}));
}`);
	const data = await rpc({ command: process.execPath, args: [bin, "--extension", extension], cwd: home, env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "", PI_OFFLINE: "1" } }, { id: "custom", type: "get_commands" }) as { commands: { name: string; description: string }[] };
	assert.deepEqual(JSON.parse(data.commands.find((c) => c.name === "probe-subagent")!.description), ["USER_SUBAGENT"]);
});

for (const blockRead of [false, true]) test(`runtime: delegación con modelo custom · hook ${blockRead ? "bloquea" : "permite"} read`, async (t) => {
	const home = await tempDir(t);
	await exerciseSubagentRuntime({ command: process.execPath, args: [bin], cwd: home, agent: agentDir(home), env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "" } }, blockRead);
});

test("runtime: mcp.json del usuario reemplaza la KB por defecto sin ser modificado", async (t) => {
	const home = await tempDir(t); const dir = agentDir(home); await mkdir(dir, { recursive: true });
	const methods: string[] = [];
	const server = createServer((request, response) => {
		if (request.method !== "POST") { request.resume(); response.writeHead(405); response.end(); return; }
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", () => {
			const message = JSON.parse(body) as { id?: unknown; method: string }; methods.push(message.method);
			if (message.id === undefined) { response.writeHead(202); response.end(); return; }
			const result = message.method === "initialize"
				? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test-kb", version: "1" } }
				: message.method === "tools/list" ? { tools: [{ name: "kb_probe", description: "KB local del test", inputSchema: { type: "object", properties: {} } }] } : {};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const config = JSON.stringify({ mcpServers: { "harness-kb": { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, exposure: "direct" } }, unrelated: "preservar" });
	await writeFile(join(dir, "mcp.json"), config);
	const body = await requestSeenByModel({ command: process.execPath, args: [bin], cwd: home, agent: dir, env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "", PI_SKIP_VERSION_CHECK: "1" } });
	assert.ok(methods.includes("initialize")); assert.ok(methods.includes("tools/list"));
	assert.ok(body.includes("mcp__harness_kb__kb_probe"), "no cargó el override local de la KB");
	assert.equal(await readFile(join(dir, "mcp.json"), "utf8"), config);
});
