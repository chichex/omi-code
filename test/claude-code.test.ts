import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCodeAvailable, configuredClaudeCode } from "../src/tui/claude-code.ts";
import { tempDir } from "./helpers/io.ts";

test("Claude Code: sólo archivos ejecutables, no directorios ni archivos sin permisos", async (t) => {
	const home = await tempDir(t); const executable = join(home, "claude");
	const env = { PATH: home };
	assert.equal(claudeCodeAvailable("claude", env), false);
	await mkdir(join(home, "directory"));
	assert.equal(claudeCodeAvailable(join(home, "directory"), env), false);
	await writeFile(executable, "#!/bin/sh\nexit 99\n", { mode: 0o600 });
	assert.equal(claudeCodeAvailable("claude", env), false);
	await chmod(executable, 0o700);
	assert.equal(claudeCodeAvailable("claude", env), true);
	assert.equal(claudeCodeAvailable(executable, {}), true);
	assert.equal(claudeCodeAvailable(join(home, "missing claude"), env), false, "un override inválido no cae al PATH válido");
});

test("Claude Code: lee sólo la ruta del config global indicado, conserva espacios y default", async (t) => {
	const home = await tempDir(t);
	assert.equal(configuredClaudeCode(home), "claude");
	for (const invalid of ["{invalid", "null", "[]", '{"provider":null}', '{"provider":{"pathToClaudeCodeExecutable":42}}']) {
		await writeFile(join(home, "claude-bridge.json"), invalid);
		assert.equal(configuredClaudeCode(home), "claude");
	}
	const executable = join(home, "custom claude");
	await writeFile(join(home, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: executable } }));
	assert.equal(configuredClaudeCode(home), executable);
});
