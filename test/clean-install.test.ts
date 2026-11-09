// Lo que promete una instalación: viene vacía, y sólo importar trae cosas, como copia.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { run } from "../src/cli/main.ts";
import { exists } from "../src/core/files.ts";
import { agentDir } from "../src/core/paths.ts";
import { PI_MARKS, rpc, requestSeenByModel, seedPi, type OmiProcess } from "./helpers/foreign-config.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const bin = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));

function omi(home: string, cwd: string, env: NodeJS.ProcessEnv = {}): OmiProcess {
	return { command: process.execPath, args: [bin], cwd, agent: agentDir(home), env: { HOME: home, PATH: process.env.PATH, OMI_HOME: "", PI_OFFLINE: "1", ...env } };
}

async function skillNames(process: OmiProcess): Promise<string[]> {
	const data = await rpc(process, { id: "1", type: "get_commands" }) as { commands: { name: string; source: string }[] };
	return data.commands.filter((command) => command.source === "skill").map((command) => command.name.replace("skill:", "")).sort();
}

test("instalación nueva_no trae ningún skill", async (t) => {
	const home = await tempDir(t);
	assert.deepEqual(await skillNames(omi(home, home)), []);
});

test("instalación nueva_las API keys del shell no le dan un modelo", async (t) => {
	const home = await tempDir(t);
	const data = await rpc(omi(home, home, { GEMINI_API_KEY: "del-shell", OPENAI_API_KEY: "del-shell", AWS_PROFILE: "del-shell" }), { id: "1", type: "get_available_models" }) as { models: unknown[] };
	assert.deepEqual(data.models, []);
});

test("las API keys del shell siguen llegando a los comandos que corre el usuario", async (t) => {
	const home = await tempDir(t);
	const data = await rpc(omi(home, home, { GEMINI_API_KEY: "del-shell" }), { id: "1", type: "bash", command: 'printf "%s" "$GEMINI_API_KEY"' }) as { output: string };
	assert.equal(data.output, "del-shell");
});

test("rechazar la importación no trae nada, aunque Pi tenga de todo", async (t) => {
	const home = await tempDir(t);
	await seedPi(home);
	const io = testIo({ homeDir: home, interactive: true, answers: ["n", "n"] });
	assert.equal(await run(["import", "pi"], io), 0);
	assert.deepEqual(await skillNames(omi(home, home)), []);
});

test("importar duplica: borrás ~/.pi y omi sigue igual", async (t) => {
	const home = await tempDir(t);
	await seedPi(home);
	const io = testIo({ homeDir: home, interactive: true, answers: ["s", "s"] });
	assert.equal(await run(["import", "pi"], io), 0);

	await rm(join(home, ".pi"), { recursive: true });

	assert.deepEqual(await skillNames(omi(home, home)), ["de-paquete", "de-pi", "enlazado", "por-ruta"]);
	const body = await requestSeenByModel(omi(home, home));
	for (const mark of PI_MARKS) assert.ok(body.includes(mark), `no llegó al modelo: ${mark}`);
});

test("importar no se lleva el historial ni las decisiones de Pi", async (t) => {
	const home = await tempDir(t);
	await seedPi(home);
	assert.equal(await run(["import", "pi"], testIo({ homeDir: home, interactive: true, answers: ["s", "s"] })), 0);
	for (const name of ["sessions", "backups", "trust.json", "settings.json.bak-1"]) {
		assert.equal(await exists(join(agentDir(home), name)), false, name);
	}
});
