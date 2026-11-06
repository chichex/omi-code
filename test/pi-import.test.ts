import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentDir, piAgentDir } from "../src/core/paths.ts";
import { runPiImportOnboarding } from "../src/onboarding/pi-import.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const settings = {
	theme: "dark",
	defaultModel: "claude-opus-5-5",
	packages: ["git:github.com/chichex/skills", "npm:pi-claude-bridge"],
};

async function homeWithPi(t: TestContext): Promise<string> {
	const home = await tempDir(t);
	const pi = piAgentDir(home);
	await mkdir(pi, { recursive: true });
	await writeFile(join(pi, "auth.json"), '{"anthropic":{"key":"sk-falsa"}}', { mode: 0o600 });
	await writeFile(join(pi, "models.json"), '{"providers":{}}', { mode: 0o644 });
	await writeFile(join(pi, "settings.json"), JSON.stringify(settings), { mode: 0o644 });
	return home;
}

async function snapshot(dir: string): Promise<Record<string, { content: string; mtimeMs: number; mode: number }>> {
	const files: Record<string, { content: string; mtimeMs: number; mode: number }> = {};
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		const info = await stat(path);
		files[name] = { content: await readFile(path, "utf8"), mtimeMs: info.mtimeMs, mode: info.mode };
	}
	return files;
}

test("onboarding_importa de Pi sin mutar ~/.pi/agent cuando el usuario acepta", async (t) => {
	const home = await homeWithPi(t);
	const before = await snapshot(piAgentDir(home));
	const io = testIo({ homeDir: home, interactive: true, answers: ["s"] });

	const result = await runPiImportOnboarding(io);

	assert.equal(result.status, "imported");
	assert.deepEqual(result.files, ["auth.json", "models.json", "settings.json"]);
	assert.equal(io.prompts.length, 1);
	const target = agentDir(home);
	assert.equal(await readFile(join(target, "auth.json"), "utf8"), before["auth.json"]?.content);
	assert.equal(await readFile(join(target, "models.json"), "utf8"), before["models.json"]?.content);
	assert.equal((await stat(join(target, "auth.json"))).mode & 0o777, 0o600);
	assert.deepEqual(await snapshot(piAgentDir(home)), before);
});

test("onboarding_quita chichex/skills de packages porque omi ya lo embebe", async (t) => {
	const home = await homeWithPi(t);
	await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["s"] }));
	const imported = JSON.parse(await readFile(join(agentDir(home), "settings.json"), "utf8"));
	assert.deepEqual(imported, { ...settings, packages: ["npm:pi-claude-bridge"] });
});

test("onboarding_importa sólo los archivos que existen en Pi", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "auth.json"), "{}");
	const result = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: [""] }));
	assert.equal(result.status, "imported");
	assert.deepEqual(result.files, ["auth.json"]);
});

test("onboarding_no vuelve a preguntar si el usuario rechazó", async (t) => {
	const home = await homeWithPi(t);
	const first = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["n"] }));
	assert.equal(first.status, "declined");
	await assert.rejects(stat(join(agentDir(home), "auth.json")));

	const io = testIo({ homeDir: home, interactive: true });
	const second = await runPiImportOnboarding(io);
	assert.equal(second.status, "skipped");
	assert.equal(io.prompts.length, 0);
});

test("onboarding_no ofrece nada si ~/.omi/agent ya tiene proveedores", async (t) => {
	for (const existing of ["auth.json", "models.json"]) {
		const home = await homeWithPi(t);
		await mkdir(agentDir(home), { recursive: true });
		await writeFile(join(agentDir(home), existing), "{}");
		const io = testIo({ homeDir: home, interactive: true });
		assert.equal((await runPiImportOnboarding(io)).status, "skipped");
		assert.equal(io.prompts.length, 0);
	}
});

test("onboarding_no ofrece nada si Pi no está configurado", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.equal(io.prompts.length, 0);
});

test("onboarding_no pregunta ni importa en modo no interactivo", async (t) => {
	const home = await homeWithPi(t);
	const io = testIo({ homeDir: home, interactive: false });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.equal(io.prompts.length, 0);
	await assert.rejects(stat(join(agentDir(home), "auth.json")));
});
