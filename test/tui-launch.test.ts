import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, piAgentDir } from "../src/core/paths.ts";
import { launchTui, type PiMain } from "../src/tui/launch.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { registerCatalogTools } from "../src/tui/tools.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { linkedProject } from "./helpers/project.ts";
import { fakeRunner } from "./helpers/runner.ts";

interface Call {
	args: string[];
	agentDirEnv: string | undefined;
	tools: string[];
}

function fakePi(calls: Call[]): PiMain {
	return async (args, options) => {
		const tools: string[] = [];
		for (const extension of options.extensionFactories ?? []) {
			const factory = typeof extension === "function" ? extension : extension.factory;
			await factory({ registerTool: (tool: { name: string }) => tools.push(tool.name), on: () => {} } as never);
		}
		calls.push({ args, agentDirEnv: process.env.PI_CODING_AGENT_DIR, tools });
	};
}

test("launchTui_usa ~/.omi/agent como configuración global de Pi", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	const code = await launchTui(["--continue"], testIo({ homeDir: home }), { piMain: fakePi(calls), skillsDir: await tempDir(t) });
	assert.equal(code, 0);
	assert.equal(calls[0]?.agentDirEnv, agentDir(home));
	assert.equal((await stat(agentDir(home))).isDirectory(), true);
	assert.deepEqual(calls[0]?.args.slice(-1), ["--continue"]);
});

test("launchTui_precarga las tools de OMI del catálogo", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls), skillsDir: await tempDir(t) });
	assert.deepEqual(calls[0]?.tools, CATALOG.map((tool) => tool.name));
	assert.ok(calls[0]?.tools.includes("omi_link_project"));
});

test("launchTui_pasa a Pi cada skill embebido con --skill", async (t) => {
	const home = await tempDir(t);
	const skills = await tempDir(t);
	for (const name of ["grill", "tdd"]) {
		await mkdir(join(skills, name));
		await writeFile(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
	}
	await writeFile(join(skills, "README.md"), "no es un skill");
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls), skillsDir: skills });
	assert.deepEqual(calls[0]?.args, ["--skill", join(skills, "grill"), "--skill", join(skills, "tdd")]);
});

test("launchTui_ofrece importar Pi antes de arrancar", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "auth.json"), "{}");
	const calls: Call[] = [];
	const io = testIo({ homeDir: home, interactive: true, answers: ["s"] });
	await launchTui([], io, { piMain: fakePi(calls), skillsDir: await tempDir(t) });
	assert.equal(io.prompts.length, 1);
	assert.equal((await stat(join(agentDir(home), "auth.json"))).isFile(), true);
	assert.equal(calls.length, 1);
});

interface RegisteredTool {
	name: string;
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((update: { content: { text: string }[] }) => void) | undefined, context: unknown): Promise<{ content: { text: string }[] }>;
}

function fakeExtensionApi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
	};
	return { pi: pi as never, tools, handlers };
}

function uiContext(answer: boolean) {
	const seen: string[] = [];
	return {
		seen,
		context: {
			hasUI: true,
			ui: {
				confirm: async (_title: string, message: string) => {
					seen.push(message);
					return answer;
				},
			},
		},
	};
}

const stageEnv = { service: "api", environment: "stage", set: [{ name: "A", value: "b" }] };

test("registerCatalogTools_en la TUI confirma con la UI y recuerda la autorización de stage", async (t) => {
	const linked = await linkedProject(t);
	const { pi, tools } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const { seen, context } = uiContext(true);
	const tool = tools.get("omi_env_set");
	assert.ok(tool);
	await tool.execute("1", stageEnv, undefined, undefined, context);
	await tool.execute("2", stageEnv, undefined, undefined, context);
	assert.equal(seen.length, 1);
	assert.match(seen[0] ?? "", /\+ A=b/);
});

test("registerCatalogTools_sin UI rechaza con el código y el hint legibles para el modelo", async (t) => {
	const linked = await linkedProject(t);
	const { pi, tools } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	await assert.rejects(
		tools.get("omi_env_set")?.execute("1", stageEnv, undefined, undefined, { hasUI: false }) ?? Promise.resolve(),
		/guardrail_confirmation_required/,
	);
	assert.deepEqual(linked.mutations(), []);
});

test("registerCatalogTools_escribir /skill:ship autoriza stage en la sesión", async (t) => {
	const linked = await linkedProject(t);
	const { pi, tools, handlers } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const { seen, context } = uiContext(false);
	handlers.get("input")?.({ type: "input", text: "/skill:ship 1.2.0", source: "interactive" });
	await tools.get("omi_env_set")?.execute("1", stageEnv, undefined, undefined, context);
	assert.equal(seen.length, 0);
	assert.equal(linked.mutations().length, 1);
});

test("registerCatalogTools_un /skill:ship que no viene del humano no autoriza", async (t) => {
	const linked = await linkedProject(t);
	const { pi, tools, handlers } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const { seen, context } = uiContext(false);
	handlers.get("input")?.({ type: "input", text: "/skill:ship", source: "extension" });
	await assert.rejects(tools.get("omi_env_set")?.execute("1", stageEnv, undefined, undefined, context) ?? Promise.resolve(), /guardrail_declined/);
	assert.equal(seen.length, 1);
});

test("registerCatalogTools_ship no autoriza prod", async (t) => {
	const linked = await linkedProject(t);
	const { pi, tools, handlers } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const { seen, context } = uiContext(false);
	handlers.get("input")?.({ type: "input", text: "/skill:ship", source: "interactive" });
	const prodEnv = { ...stageEnv, environment: "prod" };
	await assert.rejects(tools.get("omi_env_set")?.execute("1", prodEnv, undefined, undefined, context) ?? Promise.resolve(), /guardrail_declined/);
	assert.equal(seen.length, 1);
});

test("registerCatalogTools_transmite el progreso como actualización de la tool", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n", "data: dos\n\n");
	const { pi, tools } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const updates: string[] = [];
	await tools.get("omi_logs_tail")?.execute("1", { service: "api", environment: "stage" }, undefined, (update) => updates.push(update.content[0]?.text ?? ""), { hasUI: false });
	assert.deepEqual(updates, ["uno", "uno\ndos"]);
});

test("launchTui_marca la sesión como agéntica para los procesos hijos", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	delete process.env.OMI_AGENT_SESSION;
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls), skillsDir: await tempDir(t) });
	assert.equal(process.env.OMI_AGENT_SESSION, "1");
	delete process.env.OMI_AGENT_SESSION;
});

test("launchTui_en un binario instalado toma skills y assets de ~/.omi/runtime", async (t) => {
	const home = await tempDir(t);
	const runtime = join(home, ".omi/runtime");
	await mkdir(join(runtime, "skills/ship"), { recursive: true });
	await writeFile(join(runtime, "skills/ship/SKILL.md"), "---\nname: ship\ndescription: d\n---\n");
	const calls: Call[] = [];
	const previous = { package: process.env.PI_PACKAGE_DIR, runtime: process.env.OMI_RUNTIME_DIR };
	t.after(() => {
		for (const [name, value] of [["PI_PACKAGE_DIR", previous.package], ["OMI_RUNTIME_DIR", previous.runtime]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls), compiled: true });
	assert.deepEqual(calls[0]?.args, ["--skill", join(runtime, "skills/ship")]);
	assert.equal(process.env.PI_PACKAGE_DIR, runtime);
	assert.equal(process.env.OMI_RUNTIME_DIR, runtime);
});

test("launchTui_en desarrollo ignora una instalación vieja en ~/.omi/runtime", async (t) => {
	const home = await tempDir(t);
	await mkdir(join(home, ".omi/runtime/skills/viejo"), { recursive: true });
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls), compiled: false });
	assert.ok(!calls[0]?.args.some((arg) => arg.includes(".omi/runtime")));
});
