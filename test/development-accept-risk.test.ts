// /omi-work accept-risk con Git real y modelo falso: la persona revisa en la TUI los blockers de security que no
// aplican, da el motivo y el trabajo sigue. Nadie más acepta: ni el agente, ni el chat, ni un cliente RPC.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import type { Plan, Workflow } from "../src/harness/model.ts";
import { updateWorkflow } from "../src/harness/store.ts";
import { developmentFixture } from "./helpers/development.ts";
import { acceptRiskDocument } from "../src/tui/development-accept-risk.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash, type Review } from "../src/harness/model.ts";

const SECRET = "value.cjs:1 · expone un secreto";
const KICKOFF = /Continuá el harness de desarrollo activo/;
async function verifying(t: TestContext, lenses: Plan["lenses"] = ["security"]) {
	const f = await developmentFixture(t); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: { ...f.plan(), lenses } }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	return f;
}
/** D1 pasa y security falla con un blocker sobre el contenido commiteado. */
async function insecure(t: TestContext) {
	const f = await verifying(t);
	f.modelControl.reply = () => JSON.stringify({ verdict: "fail", findings: [SECRET] });
	const result = await f.invoke("omi_workflow_lens", { lens: "security" });
	assert.equal(result.isError, true);
	return f;
}
const accepted = (s: Workflow) => s.version === 2 ? s.acceptedRisks : undefined;
const bump = async (f: Awaited<ReturnType<typeof verifying>>) => { const s = await f.state(); await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1 })); };

test("development_accept_risk la persona revisa los hallazgos en la TUI, da el motivo y el trabajo sigue: verified, PR draft e issue lo muestran", async (t) => {
	const f = await insecure(t);
	await assert.rejects(f.action({ action: "verified" }), /seguridad/);
	f.remote.answer = "Preexistente en main; se sigue en otro issue";
	await f.command("accept-risk");
	assert.equal(f.prompts.at(-1), "Aceptar riesgo de seguridad", JSON.stringify(f.messages));
	// La revisión ajusta las líneas al ancho del modal: se compara el texto sin bordes ni saltos.
	const screen = f.confirmationDetails.at(-1)!.replace(/[│┌┐└┘├┤─]/g, " ").replace(/\s+/g, " ");
	for (const expected of [/Hallazgos que bloquean/, /value\.cjs:1 · expone un secreto/, /Qué implica/, /para este contenido\. Si un amend no toca su archivo y seguridad repite el mismo texto, sigue sin frenar, salvo un secreto o una exfiltración\. Si su archivo cambia, o después de un retry, seguridad lo vuelve a evaluar\./, /No corrige nada ni autoriza push, merge, comandos ni workflows/, /Esc o un motivo vacío no aceptan/, /Huella/]) assert.match(screen, expected);
	// Ronda 4 (rules-4-consentimiento-solo-este-contenido): la pantalla decía «sólo para este contenido», pero tras un amend el host
	// lleva la aceptación al contenido nuevo, también al auto-Land. La persona tiene que leer el alcance real antes de aceptar.
	assert.doesNotMatch(screen, /sólo para este contenido/);
	assert.doesNotMatch(screen, /Con el PR adoptado/, "sin PR adoptado, esa regla no le aplica");
	const state = await f.state();
	assert.deepEqual(accepted(state)?.map((a) => [a.findings, a.reason]), [[[SECRET], "Preexistente en main; se sigue en otro issue"]]);
	assert.ok(f.messages.some((m) => /^Riesgo aceptado sobre /.test(m)), JSON.stringify(f.messages));
	assert.match(f.remote.body, /### Riesgos aceptados por una persona/);
	await f.action({ action: "verified" });
	assert.equal((await f.state()).phase, "pr");
	await f.action({ action: "publish" });
	assert.match(f.remote.prBody, /^## Riesgos aceptados por una persona$/m);
	assert.match(f.remote.prBody, /^ {2}- \*\*Seguridad:\*\* ❌ fail · riesgo aceptado por una persona$/m);
});

test("development_accept_risk una sesión nueva con el trabajo pausado y el vínculo atrasado acepta el riesgo sin reanudar ni relanzar al agente", async (t) => {
	const f = await insecure(t);
	await f.action({ action: "pause", reason: "El blocker es preexistente: lo decide una persona" });
	await bump(f); await f.attach();
	assert.ok(f.messages.some((m) => /avanzó en otra rama/.test(m)), "el vínculo quedó atrasado");
	f.messages.length = 0; f.remote.answer = "Fuera del modelo de amenazas";
	await f.command("accept-risk");
	const state = await f.state();
	assert.equal(state.status, "paused"); assert.equal(accepted(state)?.length, 1, JSON.stringify(f.messages));
	assert.ok(!f.messages.some((m) => KICKOFF.test(m)), "un trabajo pausado no se relanza");
	assert.ok(f.messages.some((m) => /Seguí con \/omi-work resume/.test(m)));
});

test("development_accept_risk sin TUI interactiva, con Esc o sin motivo no se acepta nada", async (t) => {
	const f = await insecure(t);
	for (const mode of [{ mode: "rpc", hasUI: true }, { mode: "print", hasUI: false }]) {
		Object.assign(f.context, mode); f.messages.length = 0;
		await f.command("accept-risk");
		assert.ok(f.messages.some((m) => /requiere la TUI interactiva de OMI; lo decide una persona, no el agente ni un cliente RPC/.test(m)), JSON.stringify(f.messages));
	}
	Object.assign(f.context, { mode: "tui", hasUI: true });
	const reviews = f.reviews();
	f.remote.confirmations = false; await f.command("accept-risk");
	assert.equal(f.reviews(), reviews + 1, "Esc cierra la revisión");
	f.remote.confirmations = true; f.remote.answer = "   "; await f.command("accept-risk");
	f.remote.answer = "x".repeat(2001); f.messages.length = 0; await f.command("accept-risk");
	assert.ok(f.messages.some((m) => /demasiado largo/.test(m)), JSON.stringify(f.messages));
	assert.equal(accepted(await f.state()), undefined);
});

// Riesgo pendiente de #100: con el tope lleno, la revisión se abría y el rechazo llegaba recién después del motivo.
test("development_accept_risk con el tope de riesgos aceptados lleno, lo dice antes de abrir la revisión", async (t) => {
	const ten = Array.from({ length: 10 }, (_, i) => ({ fingerprint: String(i).padStart(64, "0"), findings: [`old.cjs:${i + 1} · otro riesgo`], reason: "Preexistente en main", at: "now" }));
	const fill = async (g: Awaited<ReturnType<typeof verifying>>) => { const s = await g.state(); await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1, acceptedRisks: ten })); };
	const f = await insecure(t);
	await fill(f);
	const reviews = f.reviews(); f.messages.length = 0;
	await f.command("accept-risk");
	assert.equal(f.reviews(), reviews, "no abre la revisión");
	assert.ok(f.messages.some((m) => /Aceptar riesgo de seguridad: se llegó al tope de 10/.test(m)), JSON.stringify(f.messages));
	assert.equal(accepted(await f.state())?.length, 10);
	// Review 1 de Sonnet: sin nada que aceptar, la respuesta es esa, no el tope.
	const g = await verifying(t);
	await fill(g);
	g.messages.length = 0; await g.command("accept-risk");
	assert.ok(g.messages.some((m) => /No hay hallazgos de seguridad sin aceptar/.test(m)), JSON.stringify(g.messages));
});

test("development_accept_risk el trabajo o el código cambian durante la revisión: no se acepta", async (t) => {
	const f = await insecure(t);
	f.uiControl.onReview = () => bump(f);
	f.messages.length = 0; await f.command("accept-risk");
	assert.ok(f.messages.some((m) => /cambió/.test(m)), JSON.stringify(f.messages));
	assert.equal(accepted(await f.state()), undefined);
	const g = await insecure(t);
	g.uiControl.onReview = () => g.write("value.cjs", "module.exports = 3;\n");
	g.messages.length = 0; await g.command("accept-risk");
	assert.ok(g.messages.some((m) => /El código cambió durante la revisión; no se aceptó nada/.test(m)), JSON.stringify(g.messages));
	assert.equal(accepted(await g.state()), undefined);
});

test("development_accept_risk el agente no puede aceptar riesgos ni sumar vueltas: ninguna tool lo expone", async (t) => {
	const f = await insecure(t);
	for (const [name, tool] of f.tools) assert.doesNotMatch(JSON.stringify(tool.parameters), /risk_accepted|accept-?risk|acceptedRisks|round_added|extra-?round|maxRounds/i, name);
	const workflow = f.tools.get("omi_workflow")!;
	for (const action of ["accept-risk", "risk_accepted", "extra-round", "round_added"]) assert.equal(Value.Check(workflow.parameters, { action }), false, action);
	await assert.rejects(f.action({ action: "risk_accepted", fingerprint: "x", findings: [SECRET], reason: "el agente" }), /inválidos/);
	assert.equal(accepted(await f.state()), undefined);
});

// Review del incidente (ronda 2, accept-risk-partial-sin-revisar): con una revisión partial, aceptar los blockers dejaba sin
// revisar para siempre la parte que quedó sin resultado (security no se repite sobre ese contenido), y la pantalla no lo decía.
test("development_accept_risk con una revisión de security parcial, la pantalla dice qué parte nadie juzgó y que aceptar no la revisa", () => {
	const state = createWorkflow({ number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") }, { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" }, "id", "now");
	const blocker = "parte 1/2 · src/a.ts:1 · permiso abierto";
	const partial: Review = { lens: "security", fingerprint: "tree", verdict: "fail", findings: [blocker, "parte 2/2 · Sin resultado del lente: conexión (3 intentos)"], severities: ["blocker", "aviso"], partial: true, at: "now" };
	const text = (r: Review) => acceptRiskDocument(state, "head", "tree", [blocker], r).sections.flatMap((s) => [s.title, ...s.lines.map((l) => l.kind === "text" ? l.text : "")]).join("\n");
	const shown = text(partial);
	assert.match(shown, /Revisión parcial/);
	assert.match(shown, /no juzgó todas las partes del cambio/);
	assert.match(shown, /Aceptar no las revisa/);
	assert.match(shown, /• aviso · parte 2\/2 · Sin resultado del lente: conexión \(3 intentos\)/);
	assert.doesNotMatch(text({ lens: "security", fingerprint: "tree", verdict: "fail", findings: [blocker], at: "now" }), /Revisión parcial/, "una revisión completa no lo dice");
	// Review 1 de Sonnet: la regla del PR adoptado sale sólo con el PR adoptado.
	const adopted = { ...state, pullRequest: { ownership: "adopted" } } as unknown as Workflow;
	const lines = (w: Workflow) => acceptRiskDocument(w, "head", "tree", [blocker]).sections.flatMap((s) => s.lines.map((l) => l.kind === "text" ? l.text : "")).join("\n");
	assert.match(lines(adopted), /Con el PR adoptado, se descarta cuando una ronda de corrección parte de otro HEAD y la revisión de seguridad de ese HEAD no lo repite\./);
	assert.doesNotMatch(lines(state), /Con el PR adoptado/);
});
