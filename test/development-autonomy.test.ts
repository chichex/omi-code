// Sin Foundations el harness no pregunta nada: arranca, aprueba, ejecuta y publica solo. Foundations pone
// cada punto en ask; entonces todo sigue preguntando como antes. Git real; GitHub, modelo y KB falsos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { ASK_ALL } from "./helpers/foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import { createWorkflow, transition, type WorkflowEvent } from "../src/harness/state.ts";
import { sourceHash, type Evidence, type Phase, type Plan, type Review, type Workflow } from "../src/harness/model.ts";

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

// #99 gastó 2 de 3 retry en fixtures propios que recién vio npm test en Verificar, y #98 pausó con un retry disponible
// porque la guía decía «a la tercera frená» (2026-11-26).
test("autonomía: un D o gate rojo se corrige con amend; retry queda para security, y la suite corre antes del último commit", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const state = await f.state();
	const verify = developmentInstructions({ ...state, phase: "verify" });
	assert.match(verify, /Si falla un D o un gate, corregilo con amend/);
	assert.match(verify, /retry gasta una vuelta: es para un blocker de security o para un D o gate rojo cuando ya no quedan amend/);
	assert.match(verify, /OMI rechaza retry mientras un amend alcance/);
	assert.doesNotMatch(verify, /Si falla un D, un gate o el lente de seguridad, usá retry/);
	assert.doesNotMatch(verify, /o security marca un blocker, usá retry/);
	assert.doesNotMatch(verify, /a la tercera frená/, "el código permite la vuelta que la guía mandaba frenar");
	assert.match(verify, /interrupted[^.]*no es un rojo/);
	assert.match(verify, /OMI rechaza amend y retry por eso\. Cortado con el tope de 1800 s, más tiempo no hay: ahí cuenta como rojo y pide retry/, "la regla de retry del reducer");
	assert.match(verify, /vale la última corrida de cada check sobre este contenido: no hace falta amend ni retry/);
	assert.match(verify, /dos veces seguidas por la misma señal \(exit 128 o más\) sobre este contenido, es un crash del cambio: cuenta como rojo y se corrige con amend/, "un crash repetido, como en el reducer");
	assert.match(developmentInstructions({ ...state, phase: "implement" }), /Antes del commit del último C, corré con kind setup los gates/);
});

/** Un trabajo en Verificar sobre el contenido A, armado con el reducer real: un D (D1) y el lente quality. */
function verifyingGates() {
	const at = "2026-11-26T00:00:00Z"; let ids = 0;
	const send = (s: Workflow, event: WorkflowEvent) => transition(s, event, at);
	const run = (kind: Evidence["kind"], fingerprint: string, changes: Partial<Evidence> = {}): Evidence => ({ id: `e${ids++}`, kind, command: "node test.cjs", stepId: null, caseId: kind === "gate" ? null : "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "", fingerprint, head: fingerprint, startedAt: at, finishedAt: at, ...changes });
	const record = (s: Workflow, e: Evidence) => send(s, { type: "evidence", evidence: e });
	const implement = (s: Workflow, id: string, fingerprint: string) => {
		s = record(record(send(s, { type: "step_started", id }), run("red", fingerprint, { stepId: id })), run("green", fingerprint, { stepId: id }));
		return send(s, { type: "step_completed", id, commit: `commit-${id}`, fingerprint });
	};
	const quality = (s: Workflow, fingerprint: string, findings: string[] = []): Workflow => send(s, { type: "reviewed", review: { lens: "quality", fingerprint, verdict: findings.length ? "fail" : "pass", findings, at } satisfies Review });
	const source = { number: 42, title: "Valor", body: "Debe dar 2", url: "https://example.test/42", hash: sourceHash("Valor", "Debe dar 2") };
	const plan: Plan = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Devolver 2", approach: "Corregir el valor", scope: ["valor"], outOfScope: [], cases: [{ id: "D1", description: "Devuelve 2", command: "node test.cjs" }], lenses: ["quality"], executor: { mode: "inline", writers: 0 } };
	let s = send(createWorkflow(source, { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" }, "w", at), { type: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "valor" }], findings: [], approach: "corregir", missingFoundation: [], dependencies: [], disposition: "continue", reason: "listo" } });
	s = send(send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan }), { type: "approved" });
	s = record(implement(s, "C1", "A"), run("verification", "A"));
	const gate = (exitCode: number | null, outcome: Evidence["outcome"] = exitCode === 0 ? "passed" : "failed") => (w: Workflow, fingerprint: string) => record(w, run("gate", fingerprint, { command: "npm test", exitCode, outcome }));
	/** amend desde A y el paso C2 commiteado en B, con D1 verificado sobre B. */
	const amended = (w: Workflow) => record(implement(send(w, { type: "amend", reason: "corregir", fingerprint: "A" }), "C2", "B"), run("verification", "B"));
	return { s, gate, quality, amended, verified: (w: Workflow, fingerprint: string) => send(w, { type: "verified", fingerprint }) };
}

test("autonomía: la regla de gates que dice Verificar es la que aplica el reducer", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const verify = developmentInstructions({ ...(await f.state()), phase: "verify" });
	assert.match(verify, /Cada gate que corriste en la vuelta tiene que pasar: vale su última corrida sobre este contenido o, si no lo repetiste después de un amend, la última que pasó o falló de verdad/);
	assert.match(verify, /Un comando que no existe \(exit 126 o 127\) no cuenta como gate/);
	const { s, gate, quality, amended, verified } = verifyingGates();
	// Un pass sobre A y un amend por un aviso: el gate vale sobre B sin repetirlo.
	const pass = amended(quality(gate(0)(s, "A"), "A", ["value.cjs:1 · nombre poco claro"]));
	assert.equal(verified(quality(pass, "B"), "B").phase, "pr");
	// Un rojo sobre A y un amend: sin repetirlo sobre B, frena.
	const red = amended(gate(1)(quality(s, "A"), "A"));
	assert.throws(() => verified(red, "B"), /gate fallido: npm test/);
	assert.equal(verified(gate(0)(red, "B"), "B").phase, "pr");
	// Un comando ausente nunca corrió: no frena, ni sobre este contenido.
	assert.equal(verified(gate(127)(quality(s, "A"), "A"), "A").phase, "pr");
	assert.equal(verified(gate(126)(quality(s, "A"), "A"), "A").phase, "pr");
	// Una interrumpida sobre este contenido sí frena: hay que volver a correrla.
	assert.throws(() => verified(gate(null, "interrupted")(quality(s, "A"), "A"), "A"), /gate fallido/);
});
