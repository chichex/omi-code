import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { agentDir } from "../src/core/paths.ts";
import { rpc } from "./helpers/foreign-config.ts";
import { tempDir } from "./helpers/io.ts";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));

for (const installation of ["missing", "path", "configured", "invalid-configured"] as const) {
	test(`Claude bridge: disponibilidad local del ejecutable · ${installation}`, async (t) => {
		const home = await tempDir(t); const agent = agentDir(home); const directory = join(home, "bin");
		await mkdir(agent, { recursive: true }); await mkdir(directory);
		const executable = join(directory, installation === "configured" ? "custom claude" : "claude");
		if (installation === "path" || installation === "configured") {
			await writeFile(executable, "#!/bin/sh\nexit 99\n"); await chmod(executable, 0o700);
		}
		if (installation === "configured" || installation === "invalid-configured") {
			await writeFile(join(agent, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: executable } }));
		}
		const probe = join(home, "probe.ts");
		await writeFile(probe, `export default function(pi) {
 pi.on("session_start", (_event, ctx) => pi.registerCommand("bridge-probe", {
  description: JSON.stringify({ authenticated: ctx.modelRegistry.hasConfiguredAuth({provider:"claude-bridge"}), catalog: ctx.modelRegistry.getAll().some(m=>m.provider==="claude-bridge") }), handler: async()=>{}
 }));
}`);
		const omi = { command: process.execPath, args: [bin, "--offline", "--extension", probe], cwd: home, env: { HOME: home, OMI_HOME: "", PATH: `${directory}:/usr/bin:/bin` } };
		const available = installation === "path" || installation === "configured";
		const state = await rpc(omi, { id: "state", type: "get_state" }) as { model?: { provider: string } };
		if (available) assert.equal(state.model?.provider, "claude-bridge");
		else {
			// Pi usa un modelo centinela unknown aun sin proveedores: conservar el estado limpio anterior.
			const baseline = await rpc({ ...omi, args: [bin, "--offline", "--no-extensions"] }, { id: "baseline", type: "get_state" }) as { model?: unknown };
			assert.deepEqual(state.model, baseline.model, "sin ejecutable conserva el arranque sin modelo utilizable");
			assert.notEqual(state.model?.provider, "claude-bridge");
		}
		const models = await rpc(omi, { id: "models", type: "get_available_models" }) as { models: { provider: string }[] };
		assert.equal(models.models.some((model) => model.provider === "claude-bridge"), available);
		const commands = await rpc(omi, { id: "probe", type: "get_commands" }) as { commands: { name: string; description: string }[] };
		const metadata = JSON.parse(commands.commands.find((command) => command.name === "bridge-probe")!.description);
		assert.deepEqual(metadata, { authenticated: available, catalog: true }, "el builtin conserva catálogo sin fabricar disponibilidad");
	});
}

for (const apiKey of ["not-used", "!printf synthetic-test-key"]) test("Claude bridge: un apiKey explícito en models.json no lo vuelve disponible sin ejecutable", async (t) => {
	const home = await tempDir(t); const agent = agentDir(home); await mkdir(agent, { recursive: true });
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "claude-bridge": { apiKey } } }));
	const omi = { command: process.execPath, args: [bin, "--offline"], cwd: home, env: { HOME: home, OMI_HOME: "", PATH: "/usr/bin:/bin" } };
	const state = await rpc(omi, { id: "state", type: "get_state" }) as { model: { provider: string } };
	assert.notEqual(state.model.provider, "claude-bridge");
	const models = await rpc(omi, { id: "models", type: "get_available_models" }) as { models: unknown[] };
	assert.deepEqual(models.models, []);
});

test("Claude bridge: opt-out no impone requisitos al proveedor personalizado del usuario", async (t) => {
	const home = await tempDir(t); const agent = agentDir(home); await mkdir(agent, { recursive: true });
	await writeFile(join(agent, "settings.json"), JSON.stringify({ extensions: ["-builtin:omi-claude-bridge"] }));
	const extension = join(home, "custom-provider.ts");
	await writeFile(extension, `export default function(pi) { pi.registerProvider("claude-bridge", {
 baseUrl:"http://127.0.0.1:1",api:"openai-completions",apiKey:"synthetic-test-key",
 models:[{id:"custom",name:"Custom",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:100}]
}); }`);
	const state = await rpc({ command: process.execPath, args: [bin, "--offline", "--extension", extension, "--provider", "claude-bridge", "--model", "custom"], cwd: home, env: { HOME: home, OMI_HOME: "", PATH: "/usr/bin:/bin" } }, { id: "state", type: "get_state" }) as { model: { provider: string; id: string } };
	assert.equal(state.model.provider, "claude-bridge"); assert.equal(state.model.id, "custom");
});

test("Claude bridge: no reemplaza el modelo predeterminado autenticado del usuario", async (t) => {
	const home = await tempDir(t); const agent = agentDir(home); await mkdir(agent, { recursive: true });
	const executable = join(home, "claude"); await writeFile(executable, "#!/bin/sh\nexit 99\n"); await chmod(executable, 0o700);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4" }));
	await writeFile(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "synthetic-test-key" } }));
	const state = await rpc({ command: process.execPath, args: [bin, "--offline"], cwd: home, env: { HOME: home, OMI_HOME: "", PATH: `${home}:/usr/bin:/bin` } }, { id: "state", type: "get_state" }) as { model: { provider: string; id: string } };
	assert.equal(state.model.provider, "openai"); assert.equal(state.model.id, "gpt-5.4");
});

test("Claude bridge: selección explícita sin ejecutable explica instalación, login y configuración OMI", async (t) => {
	const home = await tempDir(t);
	for (const selection of [["--provider", "claude-bridge", "--model", "claude-opus-5-5"], ["--model", "claude-bridge/claude-opus-5-5"], ["--provider", "CLAUDE-BRIDGE", "--model", "claude-opus-5-5"], ["--model", " CLAUDE-BRIDGE/claude-opus-5-5 "]]) {
		const result = spawnSync(process.execPath, [bin, "--offline", "--no-session", ...selection, "-p", "hola"], {
			cwd: home, env: { HOME: home, OMI_HOME: "", PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 20000,
		});
		assert.equal(result.status, 1, result.stderr);
		const output = result.stdout + result.stderr;
		assert.match(output, /Claude Code/); assert.match(output, /claude auth login/);
		assert.match(output, /provider\.pathToClaudeCodeExecutable/); assert.match(output, /claude-bridge\.json/);
		assert.doesNotMatch(output, /native binary not found|No API key/);
	}
});
