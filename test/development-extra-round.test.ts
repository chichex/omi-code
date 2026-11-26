// /omi-work extra-round con Git real: sólo una persona, en la TUI y con motivo, suma una vuelta con 0 retry.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { updateWorkflow } from "../src/harness/store.ts";
import { developmentFixture } from "./helpers/development.ts";

const KICKOFF = /Continuá el harness de desarrollo activo/;
/** Como #99: la vuelta 3 de 3 (0 retry), pausada. */
async function lastRound(t: TestContext) {
	const f = await developmentFixture(t); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.action({ action: "pause", reason: "La última vuelta no alcanza" });
	const s = await f.state();
	await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1, round: 3 }));
	f.messages.length = 0;
	return f;
}

test("development_extra_round la persona suma una vuelta desde la TUI con motivo y un trabajo pausado no se relanza", async (t) => {
	const f = await lastRound(t);
	f.remote.answer = "Falta cerrar el destino del proveedor";
	await f.command("extra-round");
	assert.equal(f.prompts.at(-1), "Sumar una vuelta", JSON.stringify(f.messages));
	assert.match(f.confirmationDetails.at(-1)!, /Vuelta 3 de 3 → de 4: suma 1 retry\. No borra evidencia, pasos ni aprobación; no acepta riesgos ni corrige nada\. Tope: 10 vueltas\./);
	const state = await f.state();
	assert.equal(state.maxRounds, 4); assert.equal(state.round, 3); assert.equal(state.status, "paused");
	assert.ok(state.history.some((h) => h.activity === "round_added: Falta cerrar el destino del proveedor"));
	assert.ok(f.messages.some((m) => /Vuelta sumada: vuelta 3 de 4, queda 1 retry\. Seguí con \/omi-work resume\./.test(m)), JSON.stringify(f.messages));
	assert.ok(!f.messages.some((m) => KICKOFF.test(m)), "un trabajo pausado no se relanza");
});

test("development_extra_round sin TUI interactiva, con No o sin motivo no se suma nada", async (t) => {
	const f = await lastRound(t);
	for (const mode of [{ mode: "rpc", hasUI: true }, { mode: "print", hasUI: false }]) {
		Object.assign(f.context, mode); f.messages.length = 0;
		await f.command("extra-round");
		assert.ok(f.messages.some((m) => /Sumar una vuelta: requiere la TUI interactiva de OMI; lo decide una persona, no el agente ni un cliente RPC/.test(m)), JSON.stringify(f.messages));
	}
	Object.assign(f.context, { mode: "tui", hasUI: true });
	f.remote.confirmations = false; await f.command("extra-round");
	assert.equal(f.prompts.at(-1), "Sumar una vuelta");
	f.remote.confirmations = true; f.remote.answer = "   "; await f.command("extra-round");
	f.remote.answer = "x".repeat(2001); f.messages.length = 0; await f.command("extra-round");
	assert.ok(f.messages.some((m) => /demasiado largo/.test(m)), JSON.stringify(f.messages));
	assert.equal((await f.state()).maxRounds, 3);
});
