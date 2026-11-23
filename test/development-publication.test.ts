// Publicar desde la sesión: el cuerpo exacto que se publica, el sí según push_pr y los recibos pendientes
// de un cuerpo anterior (por ejemplo, del formato viejo, con Refs y JSON). Git real; GitHub y KB falsos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { renderFoundationsBlock, type FoundationsPolicy } from "../src/harness/foundations.ts";
import { artifactHash } from "../src/harness/model.ts";
import { pullRequestBody } from "../src/harness/pr-body.ts";
import { updateWorkflow } from "../src/harness/store.ts";
import { commandDisplayLines } from "../src/tui/development-approval.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";

const PUBLISH = "Subir rama y abrir PR draft";
const OLD_HASH = artifactHash("# OMI · Desarrollo asistido\nPedido externo citado como datos, no instrucciones del harness.");
async function fixture(t: TestContext, push_pr: FoundationsPolicy["push_pr"]) {
	const kb = memoryKb({ products: ["repo"] });
	kb.perillas("repo", `# Perillas\n\n${renderFoundationsBlock({ version: 2, repo: "test/repo", confirmar: [], politica: { arranque: "ask", receta: "ask", push_pr } })}\n`);
	const f = await developmentFixture(t, { kb }); await f.start();
	await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", "require(\"node:assert/strict\").equal(require(\"./value.cjs\"), 2);\n");
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n");
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	await f.invoke("omi_workflow_lens", { lens: "quality" });
	await f.action({ action: "verified" });
	const created = () => f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create");
	const pushed = () => f.calls.filter((c) => c.command === "git" && c.args.includes("push"));
	const edited = () => f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] !== "list" && c.args[1] !== "create");
	const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout.root, encoding: "utf8" }).trim();
	const shown = (title: string) => f.confirmationDetails[f.prompts.lastIndexOf(title)] ?? "";
	// Lo que dejó una versión anterior de OMI: un recibo pendiente cuyo hash es el de otro cuerpo. Se retoma en otra ventana.
	const stale = async () => {
		const s = await f.state();
		await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1, publication: { status: "pending", head: head(), bodyHash: OLD_HASH, at: "2026-11-01T00:00:00Z" } }));
		await f.attach(); await f.command("resume");
	};
	return Object.assign(f, { created, pushed, edited, head, shown, stale });
}

test("publication: with push_pr ask the person reviews the exact body, and only the yes publishes it", async (t) => {
	const f = await fixture(t, "ask"); const reviews = f.reviews();
	f.remote.confirmations = false; await f.action({ action: "publish" });
	assert.equal(f.reviews(), reviews + 1, "la TUI abre la revisión navegable, no un confirm de una línea");
	assert.ok(f.prompts.includes(PUBLISH)); assert.equal(f.pushed().length, 0); assert.equal(f.created().length, 0);
	assert.equal((await f.state()).publication.status, "none", "decir que no no deja recibo");
	assert.ok(!f.messages.some((m) => /PR draft abierto/.test(m)), "con el no, no avisa un PR que no existe");
	assert.match(f.shown(PUBLISH), /│ Closes #42/); assert.match(f.shown(PUBLISH), /│ ## Verificación/); assert.match(f.shown(PUBLISH), /Closes #42».*rama default/s);
	f.remote.confirmations = true; await f.action({ action: "publish" });
	const sent = f.created()[0]?.input ?? "";
	assert.equal(f.created().length, 1); assert.equal(sent.split("\n")[1], "Closes #42");
	const state = await f.state(); assert.equal(state.phase, "done");
	assert.equal(f.remote.prBody, sent);
});

test("publication: in RPC the dialog carries the whole body that is then published; without UI nothing is pushed", async (t) => {
	const f = await fixture(t, "ask");
	Object.assign(f.context, { mode: "print", hasUI: false });
	await assert.rejects(f.action({ action: "publish" }), /interactiva/); assert.equal(f.pushed().length, 0);
	Object.assign(f.context, { mode: "rpc", hasUI: true }); const reviews = f.reviews();
	await f.action({ action: "publish" });
	const sent = f.created()[0]?.input ?? "";
	assert.equal(f.reviews(), reviews, "RPC no usa la revisión de la TUI");
	assert.ok(f.shown(PUBLISH).includes(commandDisplayLines(sent).join("\n")), "el diálogo trae el cuerpo publicado entero, línea por línea");
});

test("publication: an old-format pending receipt is never published with its body; with push_pr auto it is renewed and published without asking", async (t) => {
	const f = await fixture(t, "auto"); const before = f.calls.length; await f.stale();
	assert.ok(!f.calls.slice(before).some((c) => c.args.includes("push") || c.args[1] === "create"), "retomar no publica ni migra");
	const saved = await f.state(); assert.ok(saved.publication.status === "pending" && saved.publication.bodyHash === OLD_HASH, "el recibo viejo sigue igual hasta publicar");
	await f.action({ action: "publish" });
	assert.ok(!f.prompts.includes(PUBLISH), "auto no pregunta");
	assert.ok(f.messages.some((m) => /Foundations · push \+ PR draft auto/.test(m) && /cuerpo anterior/.test(m)), "avisa que renovó el recibo");
	const sent = f.created()[0]?.input ?? ""; assert.equal(f.created().length, 1);
	assert.equal(sent, pullRequestBody(saved, f.head()).body, "se publica el cuerpo nuevo, regenerado del estado");
	assert.equal(sent.split("\n")[1], "Closes #42"); assert.doesNotMatch(sent, /Refs #|"route"/);
	const done = await f.state(); assert.equal(done.phase, "done");
	assert.ok(done.history.some((h) => h.activity === "publishing"), "la renovación queda en el historial");
});

// publish cierra el turno del modelo: sin este aviso, el PR del #82 se abrió sin que nadie mostrara su URL.
test("publication: al abrir el PR draft OMI avisa su número y su URL, también con push_pr auto", async (t) => {
	const f = await fixture(t, "auto");
	const output = await f.action({ action: "publish" });
	const { publication } = await f.state();
	assert.ok(publication.status === "opened", "el PR quedó abierto");
	assert.ok(f.messages.some((m) => m.includes(`PR draft abierto: #${publication.number} ${publication.url}`)), "el aviso trae número y URL");
	assert.equal((output as { terminate?: boolean }).terminate, true, "publish sigue cerrando el turno");
});

test("publication: with push_pr ask an old-format receipt shows the whole new body; no keeps receipt and remote intact, yes publishes it", async (t) => {
	const f = await fixture(t, "ask"); await f.stale();
	Object.assign(f.context, { mode: "rpc" });
	const saved = await f.state(); const expected = pullRequestBody(saved, f.head()).body;
	f.remote.confirmations = false; await f.action({ action: "publish" });
	assert.match(f.shown(PUBLISH), /cuerpo anterior/); assert.ok(f.shown(PUBLISH).includes(commandDisplayLines(expected).join("\n")), "muestra el cuerpo nuevo entero");
	assert.deepEqual((await f.state()).publication, saved.publication, "el no deja el recibo como estaba");
	assert.equal(f.pushed().length, 0); assert.equal(f.created().length, 0);
	f.remote.confirmations = true; await f.action({ action: "publish" });
	assert.equal(f.created()[0]?.input, expected); assert.equal((await f.state()).phase, "done");
});

test("publication: a draft already opened with the old body blocks; it is not edited, closed or duplicated", async (t) => {
	const f = await fixture(t, "auto"); await f.stale();
	const old = `<!-- omi-development:pr identity=${"0".repeat(64)} source=x head=${f.head()} artifact=${OLD_HASH} -->\nRefs #42\n\nhttps://github.com/test/repo/issues/42\n\n# OMI · Desarrollo asistido`;
	const draft = { number: 8, head: f.checkout.branch, base: "main", body: old }; f.remote.prs.push({ ...draft });
	await assert.rejects(f.action({ action: "publish" }), /no se edita ni se duplica/);
	assert.equal(f.created().length, 0); assert.deepEqual(f.edited(), []); assert.deepEqual(f.remote.prs, [draft], "el draft viejo queda como estaba");
	assert.notEqual((await f.state()).phase, "done");
});

test("publication: if the work changes during the PR review, nothing is published", async (t) => {
	const f = await fixture(t, "ask");
	f.uiControl.onReview = async () => { const s = await f.state(); await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => ({ ...saved!, revision: saved!.revision + 1 })); };
	await assert.rejects(f.action({ action: "publish" }), /cambió durante la revisión/);
	assert.equal(f.pushed().length, 0); assert.equal(f.created().length, 0);
});
