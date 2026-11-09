import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../src/core/paths.ts";
import { excludeUserSkills, isolatedContextExtension, projectContextFiles, USER_SKILLS_EXCLUSION } from "../src/tui/isolation.ts";
import { FOREIGN, OWN, requestSeenByModel, seedConfig } from "./helpers/foreign-config.ts";
import { tempDir } from "./helpers/io.ts";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));

function settingsPath(dir: string): string {
	return join(dir, "settings.json");
}

test("excludeUserSkills_crea los ajustes si no existen", async (t) => {
	const dir = await tempDir(t);
	assert.equal(await excludeUserSkills(dir), true);
	assert.deepEqual(JSON.parse(await readFile(settingsPath(dir), "utf8")), { skills: [USER_SKILLS_EXCLUSION] });
});

test("excludeUserSkills_conserva los ajustes y los permisos del usuario", async (t) => {
	const dir = await tempDir(t);
	await writeFile(settingsPath(dir), `﻿${JSON.stringify({ theme: "omi", skills: ["./propios"] })}`, { mode: 0o600 });
	assert.equal(await excludeUserSkills(dir), true);
	assert.deepEqual(JSON.parse(await readFile(settingsPath(dir), "utf8")), { theme: "omi", skills: [USER_SKILLS_EXCLUSION, "./propios"] });
	assert.equal((await stat(settingsPath(dir))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("excludeUserSkills_no reescribe si la exclusión ya está", async (t) => {
	const dir = await tempDir(t);
	const raw = `{"skills":["${USER_SKILLS_EXCLUSION}"]}`;
	await writeFile(settingsPath(dir), raw);
	assert.equal(await excludeUserSkills(dir), true);
	assert.equal(await readFile(settingsPath(dir), "utf8"), raw);
});

for (const [name, raw] of [["JSON roto", "{ roto"], ["un array", "[]"], ["skills inválido", '{"skills":"x"}']] as const) {
	test(`excludeUserSkills_con ${name} falla sin tocar el archivo`, async (t) => {
		const dir = await tempDir(t);
		await writeFile(settingsPath(dir), raw);
		assert.equal(await excludeUserSkills(dir), false);
		assert.equal(await readFile(settingsPath(dir), "utf8"), raw);
	});
}

async function withHome(t: TestContext, home: string): Promise<void> {
	const previous = process.env.HOME;
	t.after(() => { process.env.HOME = previous; });
	process.env.HOME = home;
}

test("la exclusión_Pi real descarta ~/.agents/skills y deja lo propio", async (t) => {
	const home = await tempDir(t);
	await withHome(t, home);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	await mkdir(join(home, "work/repo/.agents/skills/del-repo"), { recursive: true });
	await writeFile(join(home, "work/repo/.agents/skills/del-repo/SKILL.md"), "---\nname: del-repo\ndescription: d\n---\n");
	assert.equal(await excludeUserSkills(agent), true);
	const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.create(cwd, agent, { projectTrusted: true }), noExtensions: true });
	await loader.reload();
	assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name).sort(), ["del-repo", "propio"]);
});

test("la exclusión_+ruta vuelve a habilitar un skill puntual", async (t) => {
	const home = await tempDir(t);
	await withHome(t, home);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	await writeFile(settingsPath(agent), JSON.stringify({ skills: ["+~/.agents/skills/intruso/SKILL.md"] }));
	assert.equal(await excludeUserSkills(agent), true);
	const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.create(cwd, agent, { projectTrusted: true }), noExtensions: true });
	await loader.reload();
	assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name).sort(), ["intruso", "propio"]);
});

test("projectContextFiles_en un repo llega hasta su raíz y conserva ~/.omi/agent", async (t) => {
	const home = await tempDir(t);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	const repo = dirname(cwd);
	const files = [join(agent, "AGENTS.md"), join(home, "AGENTS.md"), join(home, "work/AGENTS.md"), join(repo, "AGENTS.md"), join(cwd, "AGENTS.md")];
	assert.deepEqual(
		projectContextFiles(files.map((path) => ({ path })), cwd, agent).map(({ path }) => path),
		[join(agent, "AGENTS.md"), join(repo, "AGENTS.md"), join(cwd, "AGENTS.md")],
	);
});

test("projectContextFiles_sin repo sólo acepta el directorio actual", async (t) => {
	const root = await tempDir(t);
	const agent = join(root, "omi/agent");
	const cwd = join(root, "a/b");
	await mkdir(cwd, { recursive: true });
	const files = [{ path: join(root, "a/AGENTS.md") }, { path: join(cwd, "AGENTS.md") }, { path: join(cwd, "..x/AGENTS.md") }];
	assert.deepEqual(projectContextFiles(files, cwd, agent).map(({ path }) => path), [join(cwd, "AGENTS.md"), join(cwd, "..x/AGENTS.md")]);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

async function contextHandlers(agent: string): Promise<Record<string, Handler>> {
	const handlers: Record<string, Handler> = {};
	const extension = await isolatedContextExtension(agent);
	assert.ok(typeof extension !== "function");
	await extension.factory({ on: (name: string, handler: Handler) => { handlers[name] = handler; } } as never);
	return handlers;
}

test("isolatedContextExtension_arma el contexto con el cwd de cada corrida", async (t) => {
	const home = await tempDir(t);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	const handlers = await contextHandlers(agent);
	const options = { cwd, contextFiles: [] as { path: string; content: string }[] };
	await handlers.before_agent_start?.({ systemPromptOptions: options }, {});
	assert.deepEqual(options.contextFiles.map(({ content }) => content), [OWN.omiContext, OWN.repoContext, OWN.nestedContext]);
});

test("isolatedContextExtension_muestra en la TUI qué contexto cargó", async (t) => {
	const home = await tempDir(t);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	const handlers = await contextHandlers(agent);
	const notices: string[] = [];
	await handlers.session_start?.({}, { cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /Contexto/);
	assert.ok(notices[0]?.includes(join(cwd, "AGENTS.md")));
	assert.ok(!notices[0]?.includes(join(home, "AGENTS.md")));
});

test("isolatedContextExtension_no avisa sin contexto ni sin UI", async (t) => {
	const empty = await tempDir(t);
	const handlers = await contextHandlers(join(empty, "agent"));
	const notices: string[] = [];
	const ui = { notify: (message: string) => notices.push(message) };
	await handlers.session_start?.({}, { cwd: empty, hasUI: true, ui });
	const home = await tempDir(t);
	const cwd = await seedConfig(home, agentDir(home));
	await (await contextHandlers(agentDir(home))).session_start?.({}, { cwd, hasUI: false, ui });
	assert.deepEqual(notices, []);
});

test("omi real_al modelo sólo le llega lo de ~/.omi y lo del proyecto", async (t) => {
	const home = await tempDir(t);
	const agent = agentDir(home);
	const cwd = await seedConfig(home, agent);
	const body = await requestSeenByModel({
		command: process.execPath, args: [bin], cwd, agent,
		env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "" },
	});
	assert.ok(body.length > 0, "el proveedor no recibió nada");
	for (const mark of Object.values(FOREIGN)) assert.ok(!body.includes(mark), `llegó al modelo: ${mark}`);
	for (const mark of Object.values(OWN)) assert.ok(body.includes(mark), `no llegó al modelo: ${mark}`);
});
