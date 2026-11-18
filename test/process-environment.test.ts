import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { processRunner } from "../src/core/exec.ts";
import { childEnvironment, hideFromHost, overrideInHost } from "../src/core/process-environment.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimeShellExtension } from "../src/tui/runtime-shell.ts";
import { tempDir, testIo } from "./helpers/io.ts";

test("los comandos externos no heredan las rutas privadas del runtime instalado", async (t) => {
	const values = { PI_PACKAGE_DIR: "/installed/pi", OMI_AGENT_SESSION: "1", PI_CODING_AGENT_DIR: "/custom/agent" };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	Object.assign(process.env, values);
	const result = await processRunner.run(process.execPath, ["-e", 'console.log(JSON.stringify({pi:process.env.PI_PACKAGE_DIR,agent:process.env.OMI_AGENT_SESSION,config:process.env.PI_CODING_AGENT_DIR}))']);
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
	const previous = process.env.PI_PACKAGE_DIR;
	t.after(() => { if (previous === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previous; });
	process.env.PI_PACKAGE_DIR = "/installed/pi";
	const result = await bash.execute("1", { command: 'printf "%s" "${PI_PACKAGE_DIR-unset}"' }, undefined, undefined,
		{ cwd: home, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as never);
	assert.equal(result.content.map((part) => part.type === "text" ? part.text : "").join(""), "unset");
});

test("la tool bash usa el cwd de la sesión reemplazada, no el cwd del arranque", async (t) => {
	const home = await tempDir(t); const worktree = join(home, "issue-42"); await mkdir(worktree);
	const extension = await runtimeShellExtension(testIo({ homeDir: home, cwd: home }));
	const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
	const factory = typeof extension === "function" ? extension : extension.factory;
	await factory({ registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool), on() {} } as never);
	const result = await tools.find((tool) => tool.name === "bash")!.execute("1", { command: "pwd" }, undefined, undefined,
		{ cwd: worktree, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as never);
	assert.equal(result.content.map((part) => part.type === "text" ? part.text : "").join("").trim(), worktree);
});

test("hideFromHost_saca la variable del host y se la devuelve a los hijos", (t) => {
	t.after(() => { delete process.env.OMI_TEST_OCULTA; });
	process.env.OMI_TEST_OCULTA = "valor";
	hideFromHost(["OMI_TEST_OCULTA", "OMI_TEST_INEXISTENTE"]);
	assert.equal(process.env.OMI_TEST_OCULTA, undefined);
	const child = childEnvironment(process.env);
	assert.equal(child.OMI_TEST_OCULTA, "valor");
	assert.ok(!("OMI_TEST_INEXISTENTE" in child));
});

test("overrideInHost_restaurar dos veces o fuera de orden no pierde el valor del usuario", (t) => {
	t.after(() => { delete process.env.OMI_TEST_FIJADA; });
	process.env.OMI_TEST_FIJADA = "usuario";
	const first = overrideInHost("OMI_TEST_FIJADA", "host");
	const second = overrideInHost("OMI_TEST_FIJADA", "host");
	first(); first();
	assert.equal(process.env.OMI_TEST_FIJADA, "host", "la segunda sigue vigente");
	assert.equal(childEnvironment(process.env).OMI_TEST_FIJADA, "usuario");
	second(); second();
	assert.equal(process.env.OMI_TEST_FIJADA, "usuario");
	assert.equal(childEnvironment(process.env).OMI_TEST_FIJADA, "usuario");
	const third = overrideInHost("OMI_TEST_FIJADA", "host");
	third();
	process.env.OMI_TEST_FIJADA = "después";
	third();
	assert.equal(process.env.OMI_TEST_FIJADA, "después", "un restore ya usado no vuelve a tocar el entorno");
});
