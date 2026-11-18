import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { updateWorkflow } from "../src/harness/store.ts";
import { isApproved, transition } from "../src/harness/state.ts";

type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
async function ready(t: import("node:test").TestContext): Promise<Fixture> {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); return f;
}
function noWrites(f: Fixture): void {
	assert.equal(f.remote.comments.length, 0);
	assert.ok(!f.calls.some((c) => c.command === "gh" && (c.args.includes("POST") || c.args[1] === "edit")));
	assert.ok(!f.calls.some((c) => c.command === "git" && ["commit", "push"].some((a) => c.args.includes(a))));
}
test("approval_flow: TUI usa revisión dedicada y sólo el sí explícito publica/vincula", async (t) => {
	const f = await ready(t); await f.action({ action: "approve" });
	assert.equal(f.reviews(), 1, "TUI no usa confirm genérico para la receta");
	assert.match(f.reviewScreens[0]!, /1\/9 Resumen/); assert.match(f.reviewScreens[0]!, /Objetivo/);
	assert.equal(isApproved(await f.state()), true); assert.match(f.remote.body, /## Harness · #42/); assert.equal(f.remote.comments.length, 0);
	assert.ok(!f.calls.some((c) => c.command === "git" && c.args.includes("push")));
});
for (const kind of ["escape", "ctrl-c", "close", "undefined", "error", "abort"] as const) test(`approval_flow: navegar/Enter/${kind} no aprueba ni publica`, async (t) => {
	const f = await ready(t); const controller = new AbortController();
	f.uiControl.keys = ["5", "\x1b[F", "\r", kind === "ctrl-c" ? "\x03" : "\x1b"];
	if (kind === "close") f.uiControl.close = true;
	if (kind === "undefined") { f.uiControl.undefinedResult = true; f.uiControl.keys = ["\x13"]; }
	if (kind === "error") f.uiControl.error = true;
	if (kind === "abort") { f.uiControl.onReview = async () => { controller.abort(); }; f.uiControl.keys = ["\x13"]; }
	if (kind === "error") await assert.rejects(f.action({ action: "approve" }), /UI fallida/);
	else await f.invoke("omi_workflow", { action: "approve" }, controller.signal);
	assert.equal(f.reviews(), 1); assert.equal((await f.state()).approval, null); noWrites(f);
});
test("approval_flow: volver conserva exploración/respuestas y exige otro sí tras planned", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.readReference();
	await f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor" }], findings: [], approach: "Corregir", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Listo" } });
	await f.action({ action: "inferences", inferences: [{ id: "I1", kind: "what", question: "¿Qué valor?", recommended: "2", confidence: 10, irreversible: false, references: [] }] });
	await f.action({ action: "ask", id: "I1" }); await f.action({ action: "planned", plan: f.plan() });
	const before = await f.state(); f.remote.confirmations = false; await f.action({ action: "approve" });
	await f.action({ action: "planned", plan: { ...f.plan(), objective: "Ajuste de revisión" } });
	const revised = await f.state(); assert.deepEqual(revised.exploration, before.exploration); assert.deepEqual(revised.inferences, before.inferences); assert.equal(revised.approval, null); noWrites(f);
	f.remote.confirmations = true; await f.action({ action: "approve" }); assert.equal(f.reviews(), 2); assert.equal(isApproved(await f.state()), true);
});
for (const change of ["source", "code", "recipe"] as const) test(`approval_flow: ${change} cambia durante la revisión y no se publica/aprueba lo obsoleto`, async (t) => {
	const f = await ready(t);
	f.uiControl.onReview = async () => {
		if (change === "source") f.remote.title = "Pedido cambiado durante revisión";
		if (change === "code") await f.write("value.cjs", "module.exports = 99;\n");
		if (change === "recipe") { const s = await f.state(); await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => transition(saved!, { type: "planned", plan: { ...f.plan(), objective: "Otra receta" } }, "now")); }
	};
	try { await f.action({ action: "approve" }); } catch (error) { assert.match(String(error), /cambi|vigente|revisión|revision|atrasad/i); }
	assert.equal((await f.state()).approval, null); noWrites(f);
});
test("approval_flow: RPC conserva documento completo y decisión humana, sin custom; no UI bloquea", async (t) => {
	const f = await ready(t); Object.assign(f.context, { mode: "rpc" });
	const plan = f.plan(); plan.scope.push("FINAL_RPC_SCOPE"); await f.action({ action: "planned", plan });
	f.remote.confirmations = false; await f.action({ action: "approve" }); assert.equal((await f.state()).approval, null); noWrites(f);
	assert.equal(f.reviews(), 0); assert.match(f.confirmationDetails.at(-1)!, /FINAL_RPC_SCOPE/); assert.match(f.confirmationDetails.at(-1)!, /Objetivo/);
	Object.assign(f.context, { mode: "print", hasUI: false }); await assert.rejects(f.action({ action: "approve" }), /interactiva|UI/); noWrites(f);
	Object.assign(f.context, { mode: "rpc", hasUI: true }); f.remote.confirmations = true; await f.action({ action: "approve" }); assert.equal(isApproved(await f.state()), true);
});
test("approval_flow: tamaño no publicable falla antes de abrir revisión", async (t) => {
	const f = await ready(t); const before = f.reviews();
	const s = await f.state(); await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1, recipe: { ...saved!.recipe!, scope: Array.from({ length: 18 }, () => "x".repeat(3900)) } }));
	await f.attach(); await f.command("resume");
	await assert.rejects(f.action({ action: "approve" }), /grande|límite|GitHub/);
	assert.equal(f.reviews(), before); noWrites(f);
});
