import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";

const adapter = new URL("../src/tui/claude-bridge.ts", import.meta.url).href;
const pi = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;

for (const auth of ["literal", "command"] as const) for (const customModel of [false, true]) test(`Claude bridge: snapshots seguros sin ejecutable · ${auth} · custom=${customModel}`, async (t) => {
	const home = await tempDir(t); const agent = join(home, "agent"); await mkdir(agent);
	const commandMarker = join(home, "auth-command-executed");
	await writeFile(join(agent, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: join(home, "missing-claude") } }));
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "claude-bridge": {
		apiKey: auth === "literal" ? "not-used" : `!touch '${commandMarker}'; printf not-used`,
		...(customModel ? { api: "claude-bridge", baseUrl: "http://127.0.0.1:1", models: [{ id: "synthetic-model", name: "Synthetic", contextWindow: 1000, maxTokens: 100 }], modelOverrides: { "synthetic-model": { contextWindow: 2000 } } } : {}),
	} } }));
	const script = join(home, "probe.mjs");
	await writeFile(script, `import {writeFileSync,chmodSync,unlinkSync} from "node:fs";
import {ModelRuntime} from ${JSON.stringify(pi)};
import {loadClaudeBridge} from ${JSON.stringify(adapter)};
const runtime = await ModelRuntime.create({authPath:${JSON.stringify(join(agent, "auth.json"))},modelsPath:${JSON.stringify(join(agent, "models.json"))},refreshOnCreate:false});
const snapshots=[];
function observe(phase) { snapshots.push({phase,available:runtime.getAvailableSnapshot().filter(m=>m.provider==="claude-bridge").length}); }
observe("before-factory");
const extensionApi = {
 on() {},
 registerProvider(provider, config) {
  if (typeof provider==="string") runtime.registerProvider(provider,config);
  else runtime.registerNativeProvider(provider);
  observe("synchronous-registration");
 }
};
await (await loadClaudeBridge())(extensionApi);
observe("after-factory");
await runtime.refresh({allowNetwork:false});
observe("after-refresh");
const missingSnapshots=snapshots.slice();
writeFileSync(${JSON.stringify(join(home, "missing-claude"))}, "#!/bin/sh\\nexit 99\\n");
chmodSync(${JSON.stringify(join(home, "missing-claude"))}, 0o700);
await (await loadClaudeBridge())(extensionApi);
const activated=runtime.getAvailableSnapshot().some(m=>m.provider==="claude-bridge");
await runtime.refresh({allowNetwork:false});
unlinkSync(${JSON.stringify(join(home, "missing-claude"))});
await (await loadClaudeBridge())(extensionApi);
const removedBeforeRefresh=runtime.getAvailableSnapshot().filter(m=>m.provider==="claude-bridge").length;
await runtime.refresh({allowNetwork:false});
const removedAfterRefresh=runtime.getAvailableSnapshot().filter(m=>m.provider==="claude-bridge").length;
console.log(JSON.stringify({snapshots:missingSnapshots,activated,removedBeforeRefresh,removedAfterRefresh}));
`);
	const result = spawnSync(process.execPath, [script], { cwd: home, env: { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: "/usr/bin:/bin", PI_OFFLINE: "1", OMI_HOME: "" }, encoding: "utf8", timeout: 20000 });
	assert.equal(result.status, 0, result.stderr);
	const { snapshots, activated, removedBeforeRefresh, removedAfterRefresh } = JSON.parse(result.stdout.trim()) as { snapshots: { phase: string; available: number }[]; activated: boolean; removedBeforeRefresh: number; removedAfterRefresh: number };
	assert.ok(snapshots.length >= 3);
	for (const snapshot of snapshots) assert.equal(snapshot.available, 0, `${snapshot.phase}: la selección no puede depender de qué refresh termine primero`);
	assert.equal(existsSync(commandMarker), false, "verificar disponibilidad no ejecuta comandos de autenticación");
	assert.equal(activated, true, "instalar el ejecutable y recargar registra el catálogo sin cambiar ajustes");
	assert.equal(removedBeforeRefresh, 0, "quitar el CLI y recargar quita modelos aun con el marcador de auth anterior");
	assert.equal(removedAfterRefresh, 0);
});
