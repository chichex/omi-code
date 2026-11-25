import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";

const exec = promisify(execFile);
const probe = fileURLToPath(new URL("./helpers/startup-setup-offer.ts", import.meta.url));
const noNetwork = fileURLToPath(new URL("./helpers/no-network.ts", import.meta.url));

async function offered(home: string, repo = "test/repo"): Promise<number> {
	const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
	const { stdout } = await exec(process.execPath, ["--import", noNetwork, probe, repo], { env: { ...env, OMI_HOME: home }, timeout: 45000 });
	const result = /^SETUP_OFFER=(\d+)$/m.exec(stdout);
	assert.ok(result, stdout);
	return Number(result[1]);
}

test("setup_offers: dos procesos compiten por una oferta, Esc no la reabre y otro owner sí puede verla", async (t) => {
	const home = await tempDir(t);
	const together = await Promise.all([offered(home), offered(home)]);
	assert.deepEqual(together.sort(), [0, 1], "a lo sumo uno arranca el diálogo con el mismo agent y la misma identidad");
	assert.equal(await offered(home), 0, "un tercer proceso no repite la oferta tras Esc");
	assert.equal(await offered(home, "otro/repo"), 1, "otro repo con el mismo producto conserva su turno");
});
