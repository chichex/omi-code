import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentDir, sourcePiAgentDir as piAgentDir } from "../src/core/paths.ts";
import { childEnvironment } from "../src/core/process-environment.ts";
import { USER_SKILLS_EXCLUSION } from "../src/tui/isolation.ts";
import { launchTui, type PiMain } from "../src/tui/launch.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { registerCatalogTools } from "../src/tui/tools.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { pathWithout } from "./helpers/startup-network.ts";
import { linkedProject } from "./helpers/project.ts";
import { fakeRunner } from "./helpers/runner.ts";

const longContextIds = [
	"gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	"gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra",
];
const longContextDefaults = Object.fromEntries(longContextIds.map((id) => [id, { contextWindow: 1_050_000 }]));

interface Call {
	args: string[];
	agentDirEnv: string | undefined;
	tools: string[];
	extensions: string[];
	hiddenExtensions: string[];
}

function fakePi(calls: Call[]): PiMain {
	return async (args, options) => {
		const tools: string[] = [];
		const names: string[] = []; const hiddenExtensions: string[] = [];
		for (const extension of options.extensionFactories ?? []) {
			if (typeof extension === "function") continue;
			names.push(extension.name);
			if (extension.hidden) hiddenExtensions.push(extension.name);
			if (extension.name !== "omi-tools") continue;
			const { factory } = extension;
			await factory({ registerTool: (tool: { name: string }) => tools.push(tool.name), on: () => {} } as never);
		}
		calls.push({ args, agentDirEnv: process.env.PI_CODING_AGENT_DIR, tools, extensions: names, hiddenExtensions });
	};
}

for (const exitCode of [1, 2]) {
	test(`launchTui conserva el código ${exitCode} devuelto por Pi`, async (t) => {
		const previous = process.exitCode;
		t.after(() => { process.exitCode = previous; });
		const home = await tempDir(t);
		const result = await launchTui([], testIo({ homeDir: home }), {
			piMain: async () => { process.exitCode = exitCode; },
		});
		assert.equal(result, exitCode);
	});
}

test("launchTui_usa ~/.omi/agent como configuración global de Pi", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	const code = await launchTui(["--continue"], testIo({ homeDir: home }), { piMain: fakePi(calls) });
	assert.equal(code, 0);
	assert.equal(calls[0]?.agentDirEnv, agentDir(home));
	assert.equal((await stat(agentDir(home))).isDirectory(), true);
	assert.deepEqual(calls[0]?.args.slice(-1), ["--continue"]);
});

const modelsFile = (home: string) => join(agentDir(home), "models.json");
async function writeModels(home: string, text: string): Promise<string> {
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(modelsFile(home), text);
	return modelsFile(home);
}

test("launchTui no configura ventanas de contexto: un HOME nuevo arranca sin models.json", async (t) => {
	const home = await tempDir(t);
	let existed: boolean | undefined;
	await launchTui([], testIo({ homeDir: home }), { piMain: async () => { existed = await stat(modelsFile(home)).then(() => true, () => false); } });
	assert.equal(existed, false);
});

test("launchTui retira los 1.050.000 tokens que OMI escribía antes de arrancar Pi", async (t) => {
	const home = await tempDir(t);
	const path = await writeModels(home, `${JSON.stringify({ providers: { openai: { modelOverrides: longContextDefaults } } }, null, 2)}\n`);
	let seen: unknown;
	await launchTui([], testIo({ homeDir: home }), { piMain: async () => { seen = JSON.parse(await readFile(path, "utf8")); } });
	assert.deepEqual(seen, { providers: {} });
});

test("launchTui sólo saca esos defaults: conserva lo demás del usuario", async (t) => {
	const home = await tempDir(t);
	const others = Object.fromEntries(Object.entries(longContextDefaults).filter(([id]) => id !== "gpt-6.1-sol" && id !== "gpt-6.1-terra"));
	const original = { providers: {
		openai: { baseUrl: "https://proxy.example/v1", models: [{ id: "gpt-6-sol", contextWindow: 1_050_000 }], modelOverrides: { ...others, "gpt-6.1-sol": { maxTokens: 32_000, contextWindow: 1_050_000 }, "gpt-6.1-terra": { contextWindow: 400_000 }, "gpt-5.4-mini": { contextWindow: 1_050_000 } } },
		"openai-codex": { modelOverrides: { "gpt-6.1-sol": { contextWindow: 1_050_000 } } },
		local: { models: [{ id: "sol", contextWindow: 8192 }] },
	} };
	const path = await writeModels(home, JSON.stringify(original));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providers: {
		...original.providers,
		openai: { baseUrl: "https://proxy.example/v1", models: [{ id: "gpt-6-sol", contextWindow: 1_050_000 }], modelOverrides: { "gpt-6.1-sol": { maxTokens: 32_000 }, "gpt-6.1-terra": { contextWindow: 400_000 }, "gpt-5.4-mini": { contextWindow: 1_050_000 } } },
	} });
});

test("launchTui limpia una sola vez: después respeta 1.050.000 si lo pone la persona", async (t) => {
	const home = await tempDir(t);
	const path = await writeModels(home, JSON.stringify({ providers: { openai: { modelOverrides: longContextDefaults } } }));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	const chosen = JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 1_050_000 } } } } });
	await writeFile(path, chosen);
	const before = await stat(path);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal(await readFile(path, "utf8"), chosen);
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

test("launchTui no toca un models.json sin esos defaults", async (t) => {
	const home = await tempDir(t);
	const original = ` ${JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 400_000 } } } } })}\n`;
	const path = await writeModels(home, original);
	const before = await stat(path);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal(await readFile(path, "utf8"), original);
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

for (const original of ['{malformed', 'null', '{"providers": []}', '{"providers":{"openai":{"modelOverrides":false}}}', '{"providers":{"openai":{"modelOverrides":{"gpt-6.1-terra":false,"gpt-6.1-sol":{"contextWindow":1050000}}}}}', '{"providers":{"openai":{"models":false,"modelOverrides":{"gpt-6.1-sol":{"contextWindow":1050000}}}}}']) {
	test(`launchTui no modifica models.json inválido: ${original}`, async (t) => {
		const home = await tempDir(t);
		const path = await writeModels(home, original);
		await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
		assert.equal(await readFile(path, "utf8"), original);
	});
}

test("launchTui reintenta la limpieza cuando la persona corrige un models.json inválido", async (t) => {
	const home = await tempDir(t);
	const path = await writeModels(home, '{"providers":{"openai":{"modelOverrides":{"gpt-6.1-sol":{"contextWindow":1050000}}}}');
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	await writeFile(path, '{"providers":{"openai":{"modelOverrides":{"gpt-6.1-sol":{"contextWindow":1050000}}}}}');
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providers: {} });
});

test("launchTui retira el default en JSON con BOM y comentarios, conservándolos", async (t) => {
	const home = await tempDir(t);
	const path = await writeModels(home, '\uFEFF{\n // mis modelos\n "providers": { "openai": { "modelOverrides": { "gpt-6.1-sol": { "contextWindow": 1050000 } } } }\n}\n');
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	const result = await readFile(path, "utf8");
	assert.ok(result.startsWith('\uFEFF'));
	assert.ok(result.includes('// mis modelos'));
	assert.doesNotMatch(result, /contextWindow/);
});

test("launchTui conserva el symlink de models.json y limpia su destino", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const target = join(home, "mis-modelos.json");
	await writeFile(target, JSON.stringify({ providers: { openai: { modelOverrides: longContextDefaults } } }));
	await symlink(target, modelsFile(home));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal((await lstat(modelsFile(home))).isSymbolicLink(), true);
	assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { providers: {} });
});

test("launchTui_precarga las tools de OMI del catálogo", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls) });
	assert.deepEqual(calls[0]?.tools, CATALOG.map((tool) => tool.name));
	assert.ok(calls[0]?.tools.includes("omi_link_project"));
});

test("launchTui_una instalación nueva trae OMI, subagentes, Claude bridge y la KB", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls) });
	assert.deepEqual(calls[0]?.extensions, ["omi-tools", "omi-questions", "omi-pr-merge", "omi-runtime-shell", "omi-herdr", "omi-workspace", "omi-codemode", "omi-development", "omi-isolated-context", "omi-subagents", "omi-claude-bridge", "omi-kb", "mcp"]);
	assert.deepEqual(calls[0]?.args, ["--tui-mode", "fullscreen", "--no-context-files"]);
	assert.deepEqual(calls[0]?.hiddenExtensions, calls[0]?.extensions);
});

test("launchTui_classic conserva el modo anterior sin forzar fullscreen", async (t) => {
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: await tempDir(t), env: { OMI_TUI: "classic" } }), { piMain: fakePi(calls) });
	assert.deepEqual(calls[0]?.args, ["--no-context-files"]);
	assert.deepEqual(calls[0]?.hiddenExtensions, []);
});

test("launchTui_no invita a actualizar Pi separado de OMI, sin apagar la red ni persistir ajustes", async (t) => {
	const oldSkip = process.env.PI_SKIP_VERSION_CHECK; const offline = process.env.PI_OFFLINE;
	t.after(() => { if (oldSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK; else process.env.PI_SKIP_VERSION_CHECK = oldSkip; });
	process.env.PI_SKIP_VERSION_CHECK = "valor-anterior";
	const home = await tempDir(t);
	await assert.rejects(launchTui([], testIo({ homeDir: home }), { piMain: async () => {
		assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1"); assert.equal(process.env.PI_OFFLINE, offline);
		throw new Error("prueba de fallo");
	} }), /prueba de fallo/);
	assert.equal(process.env.PI_SKIP_VERSION_CHECK, "valor-anterior");
	delete process.env.PI_SKIP_VERSION_CHECK;
	await launchTui([], testIo({ homeDir: home }), { piMain: async () => { assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1"); } });
	assert.equal(process.env.PI_SKIP_VERSION_CHECK, undefined);
	assert.equal(JSON.parse(await readFile(join(agentDir(home), "settings.json"), "utf8")).quietStartup, undefined);
	await launchTui([], testIo({ homeDir: home, env: { OMI_TUI: "classic" } }), { piMain: async () => { assert.equal(process.env.PI_SKIP_VERSION_CHECK, undefined); } });
});

test("launchTui_apaga la telemetría de Pi en el host aunque el shell la pida, y la devuelve al salir", async (t) => {
	const previous = process.env.PI_TELEMETRY;
	t.after(() => { if (previous === undefined) delete process.env.PI_TELEMETRY; else process.env.PI_TELEMETRY = previous; });
	const home = await tempDir(t);
	for (const user of ["1", undefined]) {
		if (user === undefined) delete process.env.PI_TELEMETRY; else process.env.PI_TELEMETRY = user;
		for (const env of [{}, { OMI_TUI: "classic" }]) {
			await launchTui([], testIo({ homeDir: home, env }), { piMain: async () => {
				assert.equal(process.env.PI_TELEMETRY, "0");
				assert.equal(childEnvironment(process.env).PI_TELEMETRY, user, "los comandos del usuario ven su valor");
			} });
			assert.equal(process.env.PI_TELEMETRY, user);
		}
	}
	process.env.PI_TELEMETRY = "1";
	assert.equal(childEnvironment(process.env).PI_TELEMETRY, "1", "al salir no queda nada fijado por omi");
	await assert.rejects(launchTui([], testIo({ homeDir: home }), { piMain: async () => { throw new Error("prueba de fallo"); } }), /prueba de fallo/);
	assert.equal(process.env.PI_TELEMETRY, "1");
});

test("launchTui_un --tui-mode explícito gana sobre el default de OMI", async (t) => {
	const calls: Call[] = [];
	await launchTui(["--tui-mode", "regular"], testIo({ homeDir: await tempDir(t) }), { piMain: fakePi(calls) });
	const { parseArgs } = await import("@earendil-works/pi-coding-agent");
	assert.equal(parseArgs(calls[0]!.args).tuiMode, "regular");
});

test("launchTui_excluye ~/.agents/skills y arma el contexto él mismo", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls) });
	const settings = JSON.parse(await readFile(join(agentDir(home), "settings.json"), "utf8")) as { skills: string[] };
	assert.deepEqual(settings.skills, [USER_SKILLS_EXCLUSION]);
	assert.ok(calls[0]?.args.includes("--no-context-files"));
	assert.ok(calls[0]?.extensions.includes("omi-isolated-context"));
	assert.ok(!calls[0]?.args.includes("--no-skills"));
});

test("launchTui_vuelve a excluir después de importar los ajustes de Pi", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "settings.json"), '{"theme":"pi"}');
	const calls: Call[] = [];
	await launchTui([], testIo({ homeDir: home, interactive: true, answers: ["s"] }), { piMain: fakePi(calls) });
	assert.deepEqual(JSON.parse(await readFile(join(agentDir(home), "settings.json"), "utf8")), { theme: "pi", skills: [USER_SKILLS_EXCLUSION] });
});

for (const flag of ["--no-context-files", "-nc"]) {
	test(`launchTui_con ${flag} no agrega contexto propio`, async (t) => {
		const calls: Call[] = [];
		await launchTui([flag], testIo({ homeDir: await tempDir(t) }), { piMain: fakePi(calls) });
		assert.ok(!calls[0]?.extensions.includes("omi-isolated-context"));
	});
}

test("launchTui_con ajustes ilegibles avisa y arranca sin skills externos", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "settings.json"), "{ roto");
	const calls: Call[] = [];
	const io = testIo({ homeDir: home });
	await launchTui([], io, { piMain: fakePi(calls) });
	assert.ok(calls[0]?.args.includes("--no-skills"));
	assert.match(io.errors(), /settings\.json/);
	assert.equal(await readFile(join(agentDir(home), "settings.json"), "utf8"), "{ roto");
});

test("launchTui_ofrece importar Pi antes de arrancar", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "auth.json"), "{}");
	const calls: Call[] = [];
	const io = testIo({ homeDir: home, interactive: true, answers: ["s"] });
	await launchTui([], io, { piMain: fakePi(calls) });
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

test("registerCatalogTools_transmite el progreso como actualización de la tool", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n", "data: dos\n\n");
	const { pi, tools } = fakeExtensionApi();
	registerCatalogTools(pi, CATALOG, linked.io(), fakeRunner());
	const updates: string[] = [];
	await tools.get("omi_logs_tail")?.execute("1", { service: "api", environment: "stage" }, undefined, (update) => updates.push(update.content[0]?.text ?? ""), { hasUI: false });
	assert.deepEqual(updates, ["uno", "uno\ndos"]);
});

test("el progreso de una tool tiene una cola acotada en la TUI", async (t) => {
	const { Type } = await import("typebox");
	const { defineTool } = await import("../src/tools/types.ts");
	const { pi, tools } = fakeExtensionApi();
	const tool = defineTool({ name: "progress", label: "progress", description: "progress", parameters: Type.Object({}), run: async (_params, runtime) => {
		for (let i = 0; i < 500; i++) runtime.progress?.(`${i}:` + "x".repeat(200));
		return { text: "done", data: {} };
	} });
	registerCatalogTools(pi, [tool], testIo({ homeDir: await tempDir(t) }), fakeRunner());
	let maxLines = 0;
	let last = "";
	await tools.get("progress")?.execute("1", {}, undefined, (update) => {
		last = update.content[0]?.text ?? "";
		maxLines = Math.max(maxLines, last.split("\n").length);
	}, { hasUI: false });
	assert.ok(maxLines <= 50, `historial reenviado: ${maxLines}`);
	assert.match(last, /499:/);
});

test("registerCatalogTools usa el cwd de la sesión activa después de pasar a un worktree", async (t) => {
	const { Type } = await import("typebox"); const { defineTool } = await import("../src/tools/types.ts");
	const home = await tempDir(t); const worktree = join(home, "issue-42"); const { pi, tools } = fakeExtensionApi();
	registerCatalogTools(pi, [defineTool({ name: "cwd_probe", label: "cwd", description: "cwd", parameters: Type.Object({}), run: async (_params, runtime) => ({ text: runtime.io.cwd, data: {} }) })], testIo({ cwd: home, homeDir: home }));
	const result = await tools.get("cwd_probe")!.execute("1", {}, undefined, undefined, { cwd: worktree, hasUI: false });
	assert.equal(result.content[0]?.text, worktree);
});

test("launchTui_marca la sesión como agéntica para los procesos hijos", async (t) => {
	const home = await tempDir(t);
	const calls: Call[] = [];
	delete process.env.OMI_AGENT_SESSION;
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi(calls) });
	assert.equal(process.env.OMI_AGENT_SESSION, "1");
	delete process.env.OMI_AGENT_SESSION;
});

function restorePackageDir(t: { after(fn: () => void): void }): void {
	const previous = process.env.PI_PACKAGE_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	});
}

test("launchTui_en un binario instalado toma los assets de ~/.omi/runtime", async (t) => {
	restorePackageDir(t);
	const home = await tempDir(t);
	const runtime = join(home, ".omi/runtime");
	await mkdir(join(runtime, "theme"), { recursive: true });
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]), compiled: true });
	assert.equal(process.env.PI_PACKAGE_DIR, runtime);
});

test("launchTui_en desarrollo ignora una instalación vieja en ~/.omi/runtime", async (t) => {
	restorePackageDir(t);
	delete process.env.PI_PACKAGE_DIR;
	const home = await tempDir(t);
	await mkdir(join(home, ".omi/runtime/theme"), { recursive: true });
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]), compiled: false });
	assert.equal(process.env.PI_PACKAGE_DIR, undefined);
});

function restorePath(t: { after(fn: () => void): void }): void {
	const previous = process.env.PATH;
	t.after(() => {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	});
}

/** Un runtime instalado con fd y rg, y un PATH que no los trae (el resto, como git, sigue). */
async function runtimeWithTools(t: TestContext, home: string): Promise<void> {
	await mkdir(join(home, ".omi/runtime/theme"), { recursive: true });
	await mkdir(join(home, ".omi/runtime/bin"));
	for (const name of ["fd", "rg"]) await writeFile(join(home, ".omi/runtime/bin", name), `#!/bin/sh\necho ${name} incluido\n`, { mode: 0o755 });
	process.env.PATH = await pathWithout(["fd", "fdfind", "rg"], process.env.PATH ?? "", await tempDir(t));
}

test("launchTui_en un binario instalado enlaza fd y rg del runtime donde Pi los busca antes de bajarlos", async (t) => {
	restorePackageDir(t);
	restorePath(t);
	const home = await tempDir(t);
	await runtimeWithTools(t, home);
	const seen: string[] = [];
	await launchTui([], testIo({ homeDir: home }), { compiled: true, piMain: async () => {
		for (const name of ["fd", "rg"]) seen.push(await readlink(join(agentDir(home), "bin", name)));
	} });
	assert.deepEqual(seen, [join("..", "..", "runtime", "bin", "fd"), join("..", "..", "runtime", "bin", "rg")]);
	assert.equal(execFileSync(join(agentDir(home), "bin/rg"), { encoding: "utf8" }), "rg incluido\n");
});

test("launchTui_en desarrollo no toca <agent>/bin: Pi sigue con fd y rg del sistema", async (t) => {
	restorePackageDir(t);
	restorePath(t);
	const home = await tempDir(t);
	await runtimeWithTools(t, home);
	await launchTui([], testIo({ homeDir: home }), { compiled: false, piMain: fakePi([]) });
	await assert.rejects(lstat(join(agentDir(home), "bin/fd")), { code: "ENOENT" });
});

test("launchTui_si no puede enlazar fd y rg arranca igual, con un aviso", async (t) => {
	restorePackageDir(t);
	restorePath(t);
	const home = await tempDir(t);
	await runtimeWithTools(t, home);
	// Por ejemplo, <agent>/bin es un archivo: lstat da ENOTDIR y mkdir, EEXIST.
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "bin"), "no es un directorio\n");
	const io = testIo({ homeDir: home });
	const calls: Call[] = [];
	assert.equal(await launchTui([], io, { compiled: true, piMain: fakePi(calls) }), 0);
	assert.equal(calls.length, 1, "Pi arrancó");
	assert.match(io.errors(), /aviso: no se pudieron enlazar fd y rg .*ENOTDIR/);
});
