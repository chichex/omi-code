import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, credentialsPath, omiHome } from "../src/core/paths.ts";
import { resolveRuntime } from "../src/core/runtime.ts";
import { tempDir } from "./helpers/io.ts";

test("OMI_HOME resuelve juntos configuración, credenciales y runtime", async (t) => {
	const home = await tempDir(t);
	const target = join(await tempDir(t), "custom-omi");
	await mkdir(join(target, "runtime/theme"), { recursive: true });
	const previous = process.env.OMI_HOME;
	t.after(() => { if (previous === undefined) delete process.env.OMI_HOME; else process.env.OMI_HOME = previous; });
	process.env.OMI_HOME = target;
	assert.equal(omiHome(home), target);
	assert.equal(agentDir(home), join(target, "agent"));
	assert.equal(credentialsPath(home), join(target, "credentials.json"));
	assert.equal((await resolveRuntime(home, true)).packageDir, join(target, "runtime"));
});

test("un binario instalado infiere su raíz aunque OMI_HOME sólo se usó al instalar", () => {
	assert.equal(omiHome("/home/user", { env: {}, compiled: true, executable: "/opt/custom/bin/omi" }), "/opt/custom");
	assert.equal(omiHome("/home/user", { env: {}, compiled: true, executable: "/opt/custom/runtime/omi" }), "/opt/custom");
	assert.equal(omiHome("/home/user", { env: {}, compiled: false, executable: "/opt/node/bin/node" }), "/home/user/.omi");
});
