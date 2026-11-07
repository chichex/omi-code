import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, piAgentDir } from "../src/core/paths.ts";
import { launchTui, type PiMain } from "../src/tui/launch.ts";
import { CATALOG } from "../src/tools/catalog.ts";
import { tempDir, testIo } from "./helpers/io.ts";

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
			await factory({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
		}
		calls.push({ args, agentDirEnv: process.env.PI_CODING_AGENT_DIR, tools });
	};
}

for (const exitCode of [1, 2]) {
	test(`launchTui conserva el código ${exitCode} devuelto por Pi`, async (t) => {
		const previous = process.exitCode;
		t.after(() => { process.exitCode = previous; });
		const home = await tempDir(t);
		const result = await launchTui([], testIo({ homeDir: home }), {
			skillsDir: await tempDir(t), piMain: async () => { process.exitCode = exitCode; },
		});
		assert.equal(result, exitCode);
	});
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
