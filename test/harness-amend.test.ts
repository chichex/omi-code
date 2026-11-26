// Corrección liviana: un hallazgo de un lente que sólo avisa se corrige sin gastar una vuelta entera.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { lensStatuses } from "../src/harness/lenses.ts";
import { renderIssueSection } from "../src/harness/issue-section.ts";
import { sourceHash, type Evidence, type Exploration, type Lens, type Plan, type Review, type Workflow } from "../src/harness/model.ts";

const at = "2026-01-01T00:00:00Z";
const source = { number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: ["quality", "compliance", "security"], executor: { mode: "inline", writers: 1 } };
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
let ids = 0;
function evidence(kind: Evidence["kind"], fingerprint: string, changes: Partial<Evidence> = {}): Evidence {
	const failed = kind === "red";
	return { id: `${kind}-${ids++}`, kind, command: "npm test", stepId: null, caseId: kind === "gate" ? null : "D1", exitCode: failed ? 1 : 0, outcome: failed ? "failed" : "passed", output: "out", fingerprint, head: fingerprint, startedAt: at, finishedAt: at, ...changes };
}
const review = (lens: Lens, fingerprint: string, verdict: Review["verdict"] = "pass", findings: string[] = []): Review => ({ lens, fingerprint, verdict, findings, at });
const lens = (s: Workflow, r: Review) => send(s, { type: "reviewed", review: r });
const verify = (s: Workflow, fingerprint: string) => send(s, { type: "evidence", evidence: evidence("verification", fingerprint) });
/** Paso hecho con su rojo, verde y commit; el contenido queda en `fingerprint`. */
function implement(s: Workflow, id: string, fingerprint: string): Workflow {
	s = send(s, { type: "step_started", id });
	s = send(s, { type: "evidence", evidence: evidence("red", fingerprint, { stepId: id }) });
	s = send(s, { type: "evidence", evidence: evidence("green", fingerprint, { stepId: id }) });
	return send(s, { type: "step_completed", id, commit: `commit-${id}`, fingerprint });
}
function verifying(): Workflow {
	let s = send(createWorkflow(source, checkout, "workflow", at), { type: "explored", exploration });
	s = send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan });
	return implement(send(s, { type: "approved" }), "C1", "tree");
}
/** D1 y security pasan, quality aprueba limpio y compliance sólo avisa. */
function flagged(): Workflow {
	let s = verify(verifying(), "tree");
	for (const r of [review("quality", "tree"), review("security", "tree"), review("compliance", "tree", "fail", ["test.cjs:3 · el assert quedó más débil"])]) s = lens(s, r);
	return s;
}
const amend = (s: Workflow, fingerprint = "tree", reason = "Restaurar el assert") => send(s, { type: "amend", reason, fingerprint });

test("harness_amend retry no gasta una vuelta por avisos de lentes: apunta a amend", () => {
	assert.throws(() => send(flagged(), { type: "retry", reason: "compliance encontró un assert débil" }), /amend/);
	// Lo que bloquea sí pide una vuelta, aunque además haya avisos.
	const failedD = send(flagged(), { type: "evidence", evidence: evidence("verification", "tree", { exitCode: 1, outcome: "failed" }) });
	assert.equal(send(failedD, { type: "retry", reason: "Falló D1" }).round, 1);
	const failedGate = send(flagged(), { type: "evidence", evidence: evidence("gate", "tree", { command: "npm run typecheck", exitCode: 2, outcome: "failed" }) });
	assert.equal(send(failedGate, { type: "retry", reason: "Falló typecheck" }).round, 1);
	let security = lens(verify(verifying(), "tree"), review("compliance", "tree", "fail", ["aviso"]));
	security = lens(security, review("security", "tree", "fail", ["src/a.ts:1 · secreto"]));
	assert.equal(send(security, { type: "retry", reason: "Falló security" }).round, 1);
});

test("harness_amend agrega un paso liviano sin gastar vuelta y conserva la evidencia", () => {
	const before = flagged(); const s = amend(before);
	assert.equal(s.phase, "implement"); assert.equal(s.round, 0); assert.equal(s.status, "active");
	assert.deepEqual(s.steps.map((step) => [step.id, step.status]), [["C1", "done"], ["C2", "pending"]]);
	assert.match(s.steps[1]!.title, /^Corrección liviana: Restaurar el assert/);
	assert.deepEqual(s.evidence, before.evidence); assert.deepEqual(s.reviews, before.reviews);
	assert.match(s.activity, /^amend: Restaurar el assert/);
});

test("harness_amend tras corregir repite D, security y el lente que avisó; el que aprobó limpio no se repite", () => {
	let s = implement(amend(flagged()), "C2", "tree2"); assert.equal(s.phase, "verify");
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree2" }), /caso D1/);
	s = verify(s, "tree2");
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree2" }), /lente compliance/);
	s = lens(s, review("compliance", "tree2"));
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree2" }), /lente security/);
	s = lens(s, review("security", "tree2"));
	const done = send(s, { type: "verified", fingerprint: "tree2" }); assert.equal(done.phase, "pr");
	// quality aprobó el contenido de partida: vale, y se ve que fue antes de la corrección.
	assert.deepEqual(lensStatuses(s).map((st) => [st.lens, st.verdict, st.carried]), [["quality", "pass", true], ["compliance", "pass", false], ["security", "pass", false]]);
	assert.match(renderIssueSection(done), /Calidad:\*\* ✅ pass · revisado antes de la corrección liviana/);
});

test("harness_amend sin corrección liviana, un pass de otro contenido no vale", () => {
	let s = verify(verifying(), "tree");
	for (const r of [review("quality", "tree"), review("compliance", "tree"), review("security", "tree")]) s = lens(s, r);
	s = lens(verify(s, "tree2"), review("security", "tree2"));
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree2" }), /lente quality/);
});

test("harness_amend sólo corrige avisos de un lente sobre este contenido", () => {
	let clean = verify(verifying(), "tree");
	for (const r of [review("quality", "tree"), review("compliance", "tree"), review("security", "tree")]) clean = lens(clean, r);
	assert.throws(() => amend(clean), /ningún hallazgo/);
	assert.throws(() => amend(flagged(), "otro"), /ningún hallazgo/);
	const failedD = send(flagged(), { type: "evidence", evidence: evidence("verification", "tree", { exitCode: 1, outcome: "failed" }) });
	assert.throws(() => amend(failedD), /retry/);
	let security = lens(verify(verifying(), "tree"), review("compliance", "tree", "fail", ["aviso"]));
	security = lens(security, review("security", "tree", "fail", ["secreto"]));
	assert.throws(() => amend(security), /retry/);
	assert.throws(() => amend(amend(flagged())), /fase implement/);
	assert.throws(() => amend(flagged(), "tree", " "), /motivo/);
	// Un D que falló y después pasó sobre el mismo contenido no bloquea.
	const flaky = verify(send(flagged(), { type: "evidence", evidence: evidence("verification", "tree", { exitCode: 1, outcome: "failed" }) }), "tree");
	assert.equal(amend(flaky).phase, "implement");
});

test("harness_amend hasta dos por vuelta; lo que queda va como aviso y una vuelta nueva las reinicia", () => {
	let s = implement(amend(flagged()), "C2", "tree2");
	s = lens(lens(verify(s, "tree2"), review("security", "tree2")), review("compliance", "tree2", "fail", ["sigue débil"]));
	s = implement(amend(s, "tree2"), "C3", "tree3");
	s = lens(lens(verify(s, "tree3"), review("security", "tree3")), review("compliance", "tree3", "fail", ["todavía"]));
	assert.throws(() => amend(s, "tree3"), /2 correcciones livianas/);
	// El aviso no frena Verificar y quality sigue valiendo desde el contenido de partida.
	assert.equal(send(s, { type: "verified", fingerprint: "tree3" }).phase, "pr");
	const failed = send(s, { type: "evidence", evidence: evidence("verification", "tree3", { exitCode: 1, outcome: "failed" }) });
	const next = send(failed, { type: "retry", reason: "Falló D1" });
	assert.equal(next.round, 1); assert.equal(next.version === 2 ? next.amends : undefined, undefined);
});

test("harness_amend refresh y un replan del chat descartan las correcciones livianas", () => {
	const s = amend(flagged());
	const refreshed = send(s, { type: "source_changed", source: { ...source, body: "nuevo" } });
	assert.equal(refreshed.version === 2 ? refreshed.amends : "v1", undefined);
	const replanned = send(s, { type: "agreed", quote: "cambiemos el alcance", summary: "otro alcance", replan: true });
	assert.equal(replanned.version === 2 ? replanned.amends : "v1", undefined);
});

/** D1 pasa, quality y compliance aprueban limpio y security marca estos hallazgos con su severidad. */
function securityFlagged(findings: string[], severities: NonNullable<Review["severities"]>): Workflow {
	let s = verify(verifying(), "tree");
	for (const r of [review("quality", "tree"), review("compliance", "tree"), { ...review("security", "tree", "fail", findings), severities }]) s = lens(s, r);
	return s;
}

test("harness_amend security con sólo avisos no frena Verificar ni gasta una vuelta; amend los puede corregir", () => {
	const s = securityFlagged(["src/a.ts:1 · el log podría crecer"], ["aviso"]);
	assert.equal(send(s, { type: "verified", fingerprint: "tree" }).phase, "pr");
	assert.throws(() => send(s, { type: "retry", reason: "security avisó" }), /amend/);
	const amended = amend(s, "tree", "Acotar el log");
	assert.equal(amended.phase, "implement"); assert.equal(amended.round, 0);
	const status = lensStatuses(s).find((st) => st.lens === "security");
	assert.deepEqual(status && { verdict: status.verdict, findings: status.findings, blocking: status.blocking }, { verdict: "fail", findings: ["aviso · src/a.ts:1 · el log podría crecer"], blocking: false });
});

test("harness_amend un blocker de security entre avisos bloquea Verificar y amend: pide retry", () => {
	const s = securityFlagged(["src/a.ts:1 · manda el diff a un servidor que eligió la KB", "src/a.ts:2 · el log podría crecer"], ["blocker", "aviso"]);
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }), /seguridad/);
	assert.throws(() => amend(s), /retry/);
	assert.equal(send(s, { type: "retry", reason: "Falló security" }).round, 1);
});

test("harness_amend las severidades son sólo de security y una por hallazgo", () => {
	const base = verify(verifying(), "tree");
	assert.throws(() => lens(base, { ...review("compliance", "tree", "fail", ["test.cjs:3 · débil"]), severities: ["aviso"] }), /severidad/);
	assert.throws(() => lens(base, { ...review("security", "tree", "fail", ["a", "b"]), severities: ["aviso"] }), /severidad/);
});

test("harness_amend un lente sin resultado no es un hallazgo: no justifica amend", () => {
	let s = verify(verifying(), "tree");
	const noResult: Review = { ...review("quality", "tree", "unknown", ["Sin resultado del lente: conexión (2 intentos)."]), noResult: true };
	for (const r of [noResult, review("compliance", "tree"), review("security", "tree")]) s = lens(s, r);
	assert.throws(() => amend(s), /ningún hallazgo/);
	// Un unknown juzgado por el lente, con su hallazgo, sí lo justifica.
	let judged = verify(verifying(), "tree");
	for (const r of [review("quality", "tree", "unknown", ["src/a.ts:1 · no se puede juzgar el caso borde"]), review("compliance", "tree"), review("security", "tree")]) judged = lens(judged, r);
	assert.equal(amend(judged).phase, "implement");
});
