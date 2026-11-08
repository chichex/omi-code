// Sesión real de Pi con todas las extensiones embebidas: lo que un doble de `registerTool` no ve.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { CATALOG } from "../src/tools/catalog.ts";
import { embeddedExtensions } from "../src/tui/extensions.ts";
import { omiToolsExtension } from "../src/tui/launch.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const EMBEDDED_TOOLS = [
	"ask_user_question",
	"ask_user_questions",
	"edit",
	"grill_session",
	"launch_grill",
	"launch_sdd_run",
	"persist_sdd_spec",
	"select_github_issue",
	"select_grill_session",
	"subagent",
];

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

async function loadResources(t: TestContext, factories: InlineExtension[], skills: string[] = []) {
	const home = await tempDir(t);
	const cwd = await tempDir(t);
	const settingsManager = SettingsManager.inMemory();
	const agentDir = join(home, "agent");
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: factories,
		additionalSkillPaths: skills,
		noExtensions: true,
		noSkills: true,
	});
	await resourceLoader.reload();
	return { cwd, agentDir, settingsManager, resourceLoader };
}

test("embeddedExtensions_nombra cada extensión una sola vez", () => {
	const names = embeddedExtensions().map((extension) => extension.name);
	assert.equal(names.length, 11);
	assert.equal(new Set(names).size, names.length);
});

test("una sesión real de Pi carga las extensiones embebidas y activa sus tools", async (t) => {
	const resources = await loadResources(t, embeddedExtensions());
	assert.deepEqual(resources.resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: resources.cwd,
		agentDir: resources.agentDir,
		resourceLoader: resources.resourceLoader,
		settingsManager: resources.settingsManager,
		sessionManager: SessionManager.inMemory(resources.cwd),
	});
	t.after(() => session.dispose());
	const active = session.getActiveToolNames();
	for (const tool of EMBEDDED_TOOLS) assert.ok(active.includes(tool), tool);
});

// Pi no falla ante una tool repetida: la última pisa a la anterior. Hay que compararlas por extensión.
test("ninguna tool se registra dos veces entre las extensiones embebidas y el catálogo de OMI", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home, cwd: home });
	const resources = await loadResources(t, [omiToolsExtension(io), ...embeddedExtensions()]);
	const { extensions, errors } = resources.resourceLoader.getExtensions();
	assert.deepEqual(errors, []);
	const owners = new Map<string, string[]>();
	for (const extension of extensions) {
		for (const tool of extension.tools.keys()) owners.set(tool, [...(owners.get(tool) ?? []), extension.path]);
	}
	const repeated = [...owners].filter(([, paths]) => paths.length > 1);
	assert.deepEqual(repeated, []);
	for (const tool of [...EMBEDDED_TOOLS, ...CATALOG.map(({ name }) => name)]) assert.ok(owners.has(tool), tool);
});

test("ningún comando se registra dos veces entre las extensiones embebidas", async (t) => {
	const { resourceLoader } = await loadResources(t, embeddedExtensions());
	const commands = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.commands.keys()]);
	assert.equal(new Set(commands).size, commands.length);
	assert.ok(commands.includes("run"), "/run reemplaza a /chiche-run");
});

test("los skills de skills/ cargan en Pi con el nombre de su carpeta y sin diagnósticos", async (t) => {
	const folders = readdirSync(SKILLS_DIR).sort();
	const { resourceLoader } = await loadResources(t, [], folders.map((name) => join(SKILLS_DIR, name)));
	const { skills, diagnostics } = resourceLoader.getSkills();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(skills.map(({ name }) => name).sort(), folders);
});
