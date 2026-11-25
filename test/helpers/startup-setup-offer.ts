// Proceso independiente de prueba: extensión real, Git temporal y una KB sin Foundations.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { developmentFixture } from "./development.ts";
import { memoryKb } from "./mock-kb.ts";
import { KEYS } from "./questions.ts";

test("sonda de oferta al arrancar", async (t) => {
	assert.ok(process.env.OMI_HOME, "el padre asigna un agent temporal compartido");
	const repo = process.argv[2] ?? "test/repo";
	const kb = memoryKb({ products: ["repo"] }), background: Promise<void>[] = [];
	const f = await developmentFixture(t, { kb, repo, deps: { background: (work) => { background.push(work); } } });
	Reflect.set(f.context, "sessionManager", SessionManager.create(f.checkout.root, join(f.home, "fresh")));
	f.uiControl.questions = () => [KEYS.esc];
	await f.attach(); await f.emit("session_start", { reason: "startup" }); await Promise.all(background);
	for (const [first] of f.asked) assert.match(first ?? "", /Foundations de/);
	assert.equal(kb.calls.filter(call => call.tool === "guardar").length, 0);
	process.stdout.write(`SETUP_OFFER=${f.asked.length}\n`);
});
