import assert from "node:assert/strict";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, sourcePiAgentDir as piAgentDir } from "../src/core/paths.ts";
import { USER_SKILLS_EXCLUSION } from "../src/tui/isolation.ts";
import { launchTui, type PiMain } from "../src/tui/launch.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { registerCatalogTools } from "../src/tui/tools.ts";
import { tempDir, testIo } from "./helpers/io.ts";
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

test("launchTui configura los diez GPT verificados con 1.050.000 tokens antes de arrancar Pi", async (t) => {
	const home = await tempDir(t);
	await launchTui([], testIo({ homeDir: home }), { piMain: async () => {
		const models = JSON.parse(await readFile(join(agentDir(home), "models.json"), "utf8"));
		assert.deepEqual(models, { providers: { openai: { modelOverrides: longContextDefaults } } });
	} });
});

test("launchTui agrega el default de Sol sin reemplazar configuración de modelos existente", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	const original = { providers: { openai: { baseUrl: "https://proxy.example/v1", modelOverrides: { "gpt-6.1-sol": { maxTokens: 32_000 } } }, local: { models: [{ id: "sol", contextWindow: 8192 }] } } };
	await writeFile(path, JSON.stringify(original));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		providers: { ...original.providers, openai: { ...original.providers.openai, modelOverrides: { ...longContextDefaults, "gpt-6.1-sol": { maxTokens: 32_000, contextWindow: 1_050_000 } } } },
	});
});

test("launchTui no reescribe el archivo si todos los GPT ya tienen un límite explícito", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	const original = ` ${JSON.stringify({ providers: { openai: { modelOverrides: { ...longContextDefaults, "gpt-6.1-sol": { contextWindow: 400_000 } } } } })}\n`;
	await writeFile(path, original);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal(await readFile(path, "utf8"), original);
});

test("launchTui conserva una definición completa de Sol del usuario", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	const others = Object.fromEntries(Object.entries(longContextDefaults).filter(([id]) => id !== "gpt-6.1-sol"));
	const original = JSON.stringify({ providers: { openai: { modelOverrides: others, models: [{ id: "gpt-6.1-sol", contextWindow: 500_000 }] } } });
	await writeFile(path, original);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal(await readFile(path, "utf8"), original);
});

test("launchTui no amplía otros modelos ni copia límites a otros proveedores", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	const overrides = { "gpt-5.4-mini": { contextWindow: 400_000 }, "gpt-5.6-cyber": { contextWindow: 400_000 } };
	const providers = {
		openai: { modelOverrides: overrides },
		"openai-codex": { modelOverrides: { "gpt-6.1-sol": { contextWindow: 500_000 } } },
		anthropic: { modelOverrides: { "claude-haiku-4-5": { contextWindow: 200_000 } } },
		google: { modelOverrides: { "gemini-2.5-pro": { contextWindow: 1_048_576 } } },
	};
	await writeFile(path, JSON.stringify({ providers }));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		providers: { ...providers, openai: { modelOverrides: { ...overrides, ...longContextDefaults } } },
	});
});

test("launchTui completa una instalación que ya tenía el default de Sol y es idempotente", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	await writeFile(path, JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 1_050_000 } } } } }));
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	const text = await readFile(path, "utf8");
	assert.deepEqual(JSON.parse(text), { providers: { openai: { modelOverrides: longContextDefaults } } });
	const before = await stat(path);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal(await readFile(path, "utf8"), text);
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

for (const id of longContextIds) for (const source of ["modelOverrides", "models"]) {
	test(`launchTui respeta ${source} de ${id} y completa los otros nueve`, async (t) => {
		const home = await tempDir(t);
		await mkdir(agentDir(home), { recursive: true });
		const path = join(agentDir(home), "models.json");
		const explicit = { contextWindow: 300_000, maxTokens: 16_000 };
		const openai = source === "models" ? { models: [{ id, ...explicit }] } : { modelOverrides: { [id]: explicit } };
		await writeFile(path, JSON.stringify({ providers: { openai } }));
		await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
		const expected = Object.fromEntries(Object.entries(longContextDefaults).filter(([model]) => model !== id));
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providers: { openai: source === "models"
			? { ...openai, modelOverrides: expected }
			: { modelOverrides: { ...expected, [id]: explicit } } } });
	});
}

for (const original of ['{malformed', 'null', '{"providers": []}', '{"providers":{"openai":{"modelOverrides":false}}}', '{"providers":{"openai":{"modelOverrides":{"gpt-6.1-terra":false}}}}', '{"providers":{"openai":{"models":false,"modelOverrides":{"gpt-6.1-sol":{"contextWindow":1050000}}}}}']) {
	test(`launchTui no modifica models.json inválido: ${original}`, async (t) => {
		const home = await tempDir(t);
		await mkdir(agentDir(home), { recursive: true });
		const path = join(agentDir(home), "models.json");
		await writeFile(path, original);
		await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
		assert.equal(await readFile(path, "utf8"), original);
	});
}

test("launchTui agrega el default en JSON con BOM y comentarios, conservándolos", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	await writeFile(path, '\uFEFF{\n // mis modelos\n "providers": {}\n}\n');
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	const result = await readFile(path, "utf8");
	assert.ok(result.startsWith('\uFEFF'));
	assert.ok(result.includes('// mis modelos'));
	assert.match(result, /"contextWindow": 1050000/);
});

test("launchTui conserva el symlink de models.json y actualiza su destino", async (t) => {
	const home = await tempDir(t);
	await mkdir(agentDir(home), { recursive: true });
	const path = join(agentDir(home), "models.json");
	const target = join(home, "mis-modelos.json");
	await writeFile(target, '{}\n');
	await symlink(target, path);
	await launchTui([], testIo({ homeDir: home }), { piMain: fakePi([]) });
	assert.equal((await lstat(path)).isSymbolicLink(), true);
	assert.equal(JSON.parse(await readFile(target, "utf8")).providers.openai.modelOverrides["gpt-6.1-sol"].contextWindow, 1_050_000);
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
	assert.deepEqual(calls[0]?.extensions, ["omi-tools", "omi-runtime-shell", "omi-herdr", "omi-workspace", "omi-development", "omi-isolated-context", "omi-subagents", "omi-claude-bridge", "omi-kb"]);
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
