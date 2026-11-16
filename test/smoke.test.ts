// Procesos y Pi reales: lo que un doble no puede demostrar.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { CATALOG } from "../src/tools/catalog.ts";
import { omiToolsExtension } from "../src/tui/launch.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));

function rpcLines(args: string[], home: string, input: unknown[]): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", () => {
			resolve(
				output
					.split("\n")
					.filter((line) => line.startsWith("{"))
					.map((line) => JSON.parse(line) as Record<string, unknown>),
			);
		});
		child.stdin.end(input.map((message) => `${JSON.stringify(message)}\n`).join(""));
	});
}

test("omi_arranca el Pi real usando ~/.omi/agent y sin crear ~/.pi", async (t) => {
	const home = await tempDir(t);
	const lines = await rpcLines(["--mode", "rpc", "--no-session"], home, [{ id: "1", type: "get_state" }]);
	const state = lines.find((line) => line.id === "1");
	assert.equal(state?.success, true);
	assert.equal(existsSync(join(home, ".omi", "agent", "auth.json")), true);
	assert.equal(existsSync(join(home, ".pi")), false);
});

for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"]) test(`omi aplica la ventana larga de ${id} en el runtime real de Pi sin red`, async (t) => {
	const home = await tempDir(t);
	const lines = await rpcLines(["--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--model", `openai/${id}`], home, [{ id: "model", type: "get_state" }]);
	const state = lines.find((line) => line.id === "model");
	assert.equal(state?.success, true);
	const data = state?.data as { model?: { provider: string; id: string; contextWindow: number; maxTokens: number; cost: { tiers?: unknown[] } } };
	assert.equal(data.model?.provider, "openai");
	assert.equal(data.model?.id, id);
	assert.equal(data.model?.contextWindow, 1_050_000);
	assert.equal(data.model?.maxTokens, 128_000);
	assert.ok(data.model?.cost.tiers?.length, "conserva las tarifas de contexto largo del catálogo");
});

test("omi mcp_responde JSON-RPC por stdio en un proceso real", async (t) => {
	const home = await tempDir(t);
	const lines = await rpcLines(["mcp"], home, [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
	]);
	assert.equal(lines.length, 2);
	const { tools } = lines.find((line) => line.id === 2)?.result as { tools: { name: string }[] };
	assert.deepEqual(tools.map((tool) => tool.name), CATALOG.map((tool) => tool.name));
});

test("una sesión real de Pi acepta y activa las tools del catálogo", async (t) => {
	const home = await tempDir(t);
	const cwd = await tempDir(t);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(home, "agent"),
		settingsManager,
		extensionFactories: [omiToolsExtension(testIo({ homeDir: home, cwd }))],
		noExtensions: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(home, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	const active = session.getActiveToolNames();
	for (const tool of CATALOG) assert.ok(active.includes(tool.name), tool.name);
});

test("omi --help_no carga Pi: un subcomando determinístico arranca rápido", () => {
	const started = performance.now();
	const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(performance.now() - started < 1_000, "--help tardó más de 1 s");
});
