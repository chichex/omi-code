import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { exerciseSubagentBackgroundRuntime } from "./helpers/subagent-background-runtime.ts";

test("subagent background: otro turno antes de terminar, hooks entre turnos, aviso y uso del resultado", { timeout: 30000 }, async (t) => {
	const home = await tempDir(t);
	await exerciseSubagentBackgroundRuntime({ command: process.execPath, args: [fileURLToPath(new URL("../bin/omi.ts", import.meta.url))], cwd: home, agent: join(home, ".omi/agent"), env: { ...process.env, HOME: home, OMI_HOME: "" } });
});
