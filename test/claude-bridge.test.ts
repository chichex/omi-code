import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeQueryOptions } from "../src/tui/claude-bridge.ts";
import { agentDir } from "../src/core/paths.ts";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { exerciseClaudeBridgeRuntime } from "./helpers/claude-bridge-runtime.ts";

test("Claude bridge real ejecuta Claude Code del PATH y respeta un ejecutable configurado", async (t) => {
	const home = await tempDir(t);
	await exerciseClaudeBridgeRuntime({ command: process.execPath, args: [fileURLToPath(new URL("../bin/omi.ts", import.meta.url))], cwd: home, agent: agentDir(home), env: { HOME: home, OMI_HOME: "" } });
});

test("Claude bridge real devuelve una respuesta exitosa sin credenciales ni red", async (t) => {
	const home = await tempDir(t);
	await exerciseClaudeBridgeRuntime({ command: process.execPath, args: [fileURLToPath(new URL("../bin/omi.ts", import.meta.url))], cwd: home, agent: agentDir(home), env: { HOME: home, OMI_HOME: "" } }, true);
});

test("Claude bridge usa Claude Code del PATH, no el ejecutable opcional del SDK", () => {
	const options = claudeQueryOptions({ model: "claude-opus-5-5", settingSources: ["user", "project"], env: { HOME: "/tmp/home", PI_PACKAGE_DIR: "/host/runtime", OMI_AGENT_SESSION: "1" } });
	assert.equal(options.pathToClaudeCodeExecutable, "claude");
	assert.deepEqual(options.env, { HOME: "/tmp/home", OMI_AGENT_SESSION: "1" });
	assert.equal(options.model, "claude-opus-5-5");
	assert.deepEqual(options.settingSources, [], "no carga hooks ni configuración ajena al agente OMI");
});

test("Claude bridge respeta un ejecutable propio y no muta opciones ni entorno", () => {
	const original = { pathToClaudeCodeExecutable: "/custom/claude", env: { HOME: "/tmp/home", PI_PACKAGE_DIR: "/host/runtime", CUSTOM: "valor" } };
	const options = claudeQueryOptions(original);
	assert.equal(options.pathToClaudeCodeExecutable, "/custom/claude");
	assert.deepEqual(options.env, { HOME: "/tmp/home", CUSTOM: "valor" });
	assert.equal(original.env.PI_PACKAGE_DIR, "/host/runtime");
});
