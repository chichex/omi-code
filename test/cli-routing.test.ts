import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { run, type CliDeps } from "../src/cli/main.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function recordingDeps(): CliDeps & { tui: string[][]; mcp: number } {
	const deps = {
		tui: [] as string[][],
		mcp: 0,
		launchTui: async (args: string[]) => {
			deps.tui.push(args);
			return 0;
		},
		serveMcp: async () => {
			deps.mcp += 1;
			return 0;
		},
	};
	return deps;
}

test("omi_sin subcomando abre la TUI y le pasa sus flags", async (t) => {
	const home = await tempDir(t);
	const deps = recordingDeps();
	assert.equal(await run([], testIo({ homeDir: home }), deps), 0);
	assert.equal(await run(["--continue"], testIo({ homeDir: home }), deps), 0);
	assert.deepEqual(deps.tui, [[], ["--continue"]]);
	assert.equal(deps.mcp, 0);
});

test("omi mcp_levanta el servidor sin abrir la TUI", async (t) => {
	const home = await tempDir(t);
	const deps = recordingDeps();
	assert.equal(await run(["mcp"], testIo({ homeDir: home }), deps), 0);
	assert.equal(deps.mcp, 1);
	assert.deepEqual(deps.tui, []);
});

test("omi con un subcomando desconocido_sale con 2 y no abre la TUI", async (t) => {
	const home = await tempDir(t);
	const deps = recordingDeps();
	const io = testIo({ homeDir: home });
	assert.equal(await run(["stauts"], io, deps), 2);
	assert.match(io.errors(), /stauts/);
	assert.deepEqual(deps.tui, []);
});

test("omi --help_lista todos los subcomandos del corte", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["--help"], io, recordingDeps()), 0);
	for (const name of ["login", "logout", "whoami", "init", "status", "env", "resources", "jobs", "publish", "deploy", "promote", "logs", "upgrade", "mcp"]) {
		assert.match(io.output(), new RegExp(`^  ${name}\\b`, "m"), name);
	}
});

test("binario_responde --version y --help en un proceso real", () => {
	const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), pkg.version);
	const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /omi mcp/);
});
