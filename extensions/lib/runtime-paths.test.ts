// Las rutas del proceso se leen al usarse: `launch.ts` setea el entorno después de importar.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { piAgentDir, runtimeAssetDir } from "./runtime-paths.ts";

test("piAgentDir_usa PI_CODING_AGENT_DIR y cae en ~/.pi/agent sin la variable", () => {
	assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/home/u/.omi/agent" }), "/home/u/.omi/agent");
	assert.equal(piAgentDir({}), join(homedir(), ".pi", "agent"));
});

test("piAgentDir_lee el entorno en cada llamada, no al importar", (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	process.env.PI_CODING_AGENT_DIR = "/a";
	assert.equal(piAgentDir(), "/a");
	process.env.PI_CODING_AGENT_DIR = "/b";
	assert.equal(piAgentDir(), "/b");
});

test("runtimeAssetDir_usa OMI_RUNTIME_DIR y sin la variable devuelve el fallback", () => {
	assert.equal(runtimeAssetDir("agents", "/fallback", { OMI_RUNTIME_DIR: "/opt/omi" }), "/opt/omi/agents");
	assert.equal(runtimeAssetDir("agents", "/fallback", {}), "/fallback");
	assert.equal(runtimeAssetDir("agents", "/fallback", { OMI_RUNTIME_DIR: "" }), "/fallback");
});
