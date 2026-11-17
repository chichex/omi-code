import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { rpc } from "./helpers/foreign-config.ts";
import { tempDir } from "./helpers/io.ts";

for (const success of [true, false]) test(`rpc helper: espera el cierre real antes de ${success ? "resolver" : "rechazar"}`, async (t) => {
	const home = await tempDir(t); const marker = join(home, "shutdown-complete"); const script = join(home, "fake-rpc.mjs");
	await writeFile(script, `import {writeFileSync} from "node:fs";
process.on("SIGTERM", () => setTimeout(() => {writeFileSync(${JSON.stringify(marker)}, "done"); process.exit(0);}, 100));
process.stdin.once("data", (data) => {
 const request=JSON.parse(data.toString());
 console.log(JSON.stringify({type:"response",id:request.id,success:${success},data:{observed:true},error:"SYNTHETIC_RPC_FAILURE"}));
});
`);
	const observed = await rpc({ command: process.execPath, args: [script], cwd: home, env: {} }, { id: "test", type: "probe" }).then(
		(data) => ({ data, error: undefined, closed: existsSync(marker) }),
		(error: unknown) => ({ data: undefined, error, closed: existsSync(marker) }),
	);
	// Esperar la escritura final también en rojo: el test no deja hijos escribiendo al limpiar su HOME.
	for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(10);
	assert.equal(await readFile(marker, "utf8"), "done");
	assert.equal(observed.closed, true, "rpc() no devuelve el control mientras el hijo sigue cerrándose");
	if (success) { assert.equal(observed.error, undefined); assert.deepEqual(observed.data, { observed: true }); }
	else { assert.ok(observed.error instanceof Error); assert.equal(observed.error.message, "SYNTHETIC_RPC_FAILURE"); }
});

test("rpc helper: un hijo que sale sin responder rechaza con su salida y no deja un timeout pendiente", async (t) => {
	const home = await tempDir(t); const script = join(home, "early-exit.mjs");
	await writeFile(script, 'process.stderr.write("SYNTHETIC_EARLY_EXIT"); process.exit(7);');
	await assert.rejects(rpc({ command: process.execPath, args: [script], cwd: home, env: {} }, { id: "test", type: "probe" }), /RPC terminó sin responder \(7\): SYNTHETIC_EARLY_EXIT/);
});

test("rpc helper: conserva el error de spawn y cierra los streams antes de rechazar", async (t) => {
	const home = await tempDir(t);
	await assert.rejects(rpc({ command: join(home, "missing-command"), cwd: home, env: {} }, { id: "test", type: "probe" }), { code: "ENOENT" });
});
