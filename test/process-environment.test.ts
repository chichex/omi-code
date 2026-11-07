import assert from "node:assert/strict";
import { test } from "node:test";
import { processRunner } from "../src/core/exec.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimeShellExtension } from "../src/tui/runtime-shell.ts";
import { tempDir, testIo } from "./helpers/io.ts";

test("los comandos externos no heredan las rutas privadas del runtime instalado", async (t) => {
	const values = { PI_PACKAGE_DIR: "/installed/pi", OMI_RUNTIME_DIR: "/installed/omi", OMI_AGENT_SESSION: "1", PI_CODING_AGENT_DIR: "/custom/agent" };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	Object.assign(process.env, values);
	const result = await processRunner.run(process.execPath, ["-e", 'console.log(JSON.stringify({pi:process.env.PI_PACKAGE_DIR,runtime:process.env.OMI_RUNTIME_DIR,agent:process.env.OMI_AGENT_SESSION,config:process.env.PI_CODING_AGENT_DIR}))']);
	assert.equal(result.code, 0);
	assert.deepEqual(JSON.parse(result.stdout), { agent: "1", config: "/custom/agent" });
	assert.equal(process.env.PI_PACKAGE_DIR, "/installed/pi", "el host conserva sus assets");
});

test("la tool bash nativa conserva su contrato pero no contamina el proceso ejecutado", async (t) => {
	const home = await tempDir(t);
	const extension = await runtimeShellExtension(testIo({ homeDir: home, cwd: home }));
	const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
	const factory = typeof extension === "function" ? extension : extension.factory;
	await factory({ registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool), on() {} } as never);
	const bash = tools.find((tool) => tool.name === "bash");
	assert.ok(bash);
	const previous = { pi: process.env.PI_PACKAGE_DIR, runtime: process.env.OMI_RUNTIME_DIR };
	t.after(() => { for (const [key, value] of [["PI_PACKAGE_DIR", previous.pi], ["OMI_RUNTIME_DIR", previous.runtime]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	process.env.PI_PACKAGE_DIR = "/installed/pi";
	process.env.OMI_RUNTIME_DIR = "/installed/omi";
	const result = await bash.execute("1", { command: 'printf "%s|%s" "${PI_PACKAGE_DIR-unset}" "${OMI_RUNTIME_DIR-unset}"' }, undefined, undefined,
		{ cwd: home, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as never);
	assert.equal(result.content.map((part) => part.type === "text" ? part.text : "").join(""), "unset|unset");
});
