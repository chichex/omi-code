import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { claimSetupOffer } from "../src/harness/setup-offers.ts";
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

// Review de #93: una oferta que no llegó a mostrarse se libera, sin abrir un hueco a otro proceso.
test("setup_offers: reclamada nadie más la toma; liberada vuelve a estar libre y liberar otra vez no borra una marca ajena", async (t) => {
	const home = await tempDir(t), key = { kbUrl: "https://kb.example.test/mcp", product: "repo", repo: "test/repo" };
	const claim = () => claimSetupOffer(home, key, "foundations", "foundations:missing");
	const held = claim(); assert.ok(held, "la primera vez se reclama");
	assert.ok(!claim(), "mientras está reclamada, otro proceso no la toma");
	held.release();
	const other = claim(); assert.ok(other, "liberada, la oferta vuelve a estar libre");
	held.release();
	assert.ok(!claim(), "liberar otra vez no borra la marca que tomó otro");
});
