// Sin Foundations el harness no pregunta nada: arranca, aprueba, ejecuta y publica solo. Foundations pone
// cada punto en ask; entonces todo sigue preguntando como antes. Git real; GitHub, modelo y KB falsos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { ASK_ALL } from "./helpers/foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import type { Phase } from "../src/harness/model.ts";

const OUTSIDE = "node -e \"process.exit(0)\"";
const OTHER = "node -e \"process.exitCode = 0\"";
type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
async function toPr(f: Fixture) {
	await f.action({ action: "step", id: "C1" });
	await f.invoke("omi_workflow_check", { kind: "setup", command: OTHER });
	await f.write("test.cjs", "require(\"node:assert/strict\").equal(require(\"./value.cjs\"), 2);\n");
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	await f.invoke("omi_workflow_lens", { lens: "quality" });
	await f.action({ action: "verified" });
}
const nothingAsked = (f: Fixture) => {
	assert.deepEqual(f.prompts, [], "ningún confirm, revisión ni permiso");
	assert.equal(f.reviews(), 0, "no abre la revisión de la receta");
	assert.deepEqual(f.selects, [], "ningún selector de permiso");
	assert.deepEqual(f.asked, [], "ninguna tanda de preguntas: tampoco la oferta de armar Foundations");
};

test("autonomía: sin Foundations el harness va del arranque al PR draft sin preguntar nada", async (t) => {
	const f = await developmentFixture(t);
	await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OUTSIDE });
	await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	const approved = await f.state();
	assert.equal(approved.phase, "implement"); assert.equal(approved.approval?.by, "foundations");
	await toPr(f); await f.action({ action: "publish" });
	assert.equal((await f.state()).phase, "done");
	nothingAsked(f);
	assert.deepEqual((await f.state()).grants ?? [], [], "sin grants: corre por la política, no por un sí guardado");
	for (const notice of [/Foundations · arranque auto: Empezar el trabajo del issue #42/, /Foundations · receta auto/, /Foundations · push \+ PR draft auto/]) assert.ok(f.messages.some((m) => notice.test(m)), `avisa lo que hizo sin preguntar: ${notice}`);
	const pushes = f.calls.filter((c) => c.command === "git" && c.args.includes("push"));
	assert.ok(pushes.length > 0); assert.ok(!pushes.some((c) => c.args.some((arg) => /^(?:--force.*|-f|\+.*)$/.test(arg))), "nunca fuerza el push");
	assert.ok(!f.calls.some((c) => c.args.includes("merge")), "nunca mergea");
});

test("autonomía: sin UI y sin Foundations aprobar, ejecutar y publicar no exigen confirmación interactiva", async (t) => {
	const f = await developmentFixture(t); await f.start();
	Object.assign(f.context, { mode: "print", hasUI: false });
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OUTSIDE });
	await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await toPr(f); await f.action({ action: "publish" });
	assert.equal((await f.state()).phase, "done");
	nothingAsked(f);
});

test("autonomía: sin Foundations el modelo vuelve a explorar sin pedir confirmación", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	const result = await f.action({ action: "refresh" });
	assert.equal(result.terminate, false, "el turno sigue: no hubo que esperar a nadie");
	const state = await f.state();
	assert.equal(state.phase, "explore"); assert.equal(state.approval, null);
	nothingAsked(f);
	assert.ok(f.messages.some((m) => /Foundations · receta auto: vuelve a explorar sin preguntar/.test(m)));
});

test("autonomía: con Foundations en ask y la KB caída vale la revisión aceptada y cada punto sigue preguntando", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.available = "sin login";
	const f = await developmentFixture(t, { kb, foundations: ASK_ALL });
	await f.start();
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: OUTSIDE });
	await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	f.remote.confirmations = false; await f.action({ action: "refresh" });
	assert.deepEqual(f.prompts, ["Empezar el trabajo del issue #42", "Autorizar comando del proyecto", "Aprobar receta y sincronizar issue", "Volver a explorar"]);
	assert.equal((await f.state()).approval?.by, undefined, "la aprobó la persona");
	await f.command("status");
	assert.match(f.messages.at(-1)!, /Foundations: local/);
	assert.match(f.messages.at(-1)!, /arranque: ask\n  receta: ask\n  push \+ PR draft: ask/);
});

test("autonomía: un pedido nuevo sin Foundations crea el issue y arranca el harness sin preguntar", async (t) => {
	const f = await beginFixture(t); const origin = f.current();
	await f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(f.prompts, []);
	assert.equal(f.remote.created.length, 1);
	assert.notEqual(f.current().manager.getSessionFile(), f.main.getSessionFile(), "cambió a la sesión del worktree");
	assert.ok(origin.notices.some((n) => /Foundations · arranque auto: Crear issue y empezar el trabajo/.test(n)), "avisa lo que hizo");
	assert.equal(f.kickoffs().filter((text) => /Continuá el harness de desarrollo/.test(text)).length, 1, "el harness sigue en Explorar");
});

// La UI hace falta por otra razón: la clasificación se muestra con Esc para cancelar y el trabajo cambia de sesión.
test("autonomía: sin UI empezar sigue fallando antes de tocar nada, aunque arranque sea auto, y dice por qué", async (t) => {
	const f = await beginFixture(t); Object.assign(f.current().ctx, { hasUI: false });
	await assert.rejects(f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" }), /requiere la TUI o RPC: muestra la clasificación \(Esc la cancela\) y cambia a la sesión del worktree/);
	assert.deepEqual(f.prompts, []); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.switches, []); assert.deepEqual(f.calls, []);
});

test("autonomía: con arranque ask un pedido nuevo sigue pidiendo el sí", async (t) => {
	const f = await beginFixture(t, { foundations: { ...ASK_ALL, receta: "auto", push_pr: "auto" } });
	f.remote.confirm = false;
	await f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(f.prompts.map((p) => p.title), ["Crear issue y empezar el trabajo"]);
	assert.deepEqual(f.remote.created, [], "con el no, nada");
});

test("autonomía: las instrucciones del agente no dicen que un permiso humano es obligatorio", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const state = await f.state();
	const phases: Phase[] = ["explore", "decide", "recipe", "diagnose", "spec", "approve", "implement", "verify", "pr", "done", "closed"];
	for (const phase of phases) {
		const text = developmentInstructions({ ...state, phase } as typeof state);
		assert.doesNotMatch(text, /con permiso humano|esperá aprobación humana|pide autorización humana separada|pide permiso a la persona|pide un permiso humano/, phase);
	}
	assert.match(developmentInstructions({ ...state, phase: "approve" }), /Foundations/, "dice quién decide si pregunta");
});

// El #82 puso «Push, PR, …» en outOfScope y frenó en «Abrir PR draft» diciendo que quedaban fuera de la receta.
test("autonomía: el push y el PR draft cierran el flujo; la receta no los excluye y outOfScope no frena publish", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const state = await f.state();
	assert.match(developmentInstructions({ ...state, phase: "recipe" }), /push y el PR draft[^.]*no van en outOfScope/, "la receta no excluye el cierre del flujo");
	assert.match(developmentInstructions({ ...state, phase: "pr" }), /publish es parte de la receta aprobada, aunque outOfScope nombre push o PR/, "un outOfScope que los nombra no frena publish");
});
