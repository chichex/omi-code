// Aceptar riesgo: un blocker de security que no aplica lo acepta una persona, para un contenido exacto y sus hallazgos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { lensStatuses } from "../src/harness/lenses.ts";
import { issueSectionVariants, renderIssueSection } from "../src/harness/issue-section.ts";
import { renderWorkflowArtifact } from "../src/harness/pr-body.ts";
import { parseWorkflow, sourceHash, WorkflowV2Schema, type Evidence, type Exploration, type Lens, type Plan, type Review, type Workflow } from "../src/harness/model.ts";

const at = "2026-01-01T00:00:00Z";
const source = { number: 7, title: "Change", body: "Details", url: "https://github.com/acme/repo/issues/7", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan = (lenses: Plan["lenses"] = ["quality", "compliance", "security"]): Plan => ({ classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses, executor: { mode: "inline", writers: 1 } });
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
let ids = 0;
function evidence(kind: Evidence["kind"], fingerprint: string, changes: Partial<Evidence> = {}): Evidence {
	const failed = kind === "red";
	return { id: `${kind}-${ids++}`, kind, command: "npm test", stepId: null, caseId: kind === "gate" ? null : "D1", exitCode: failed ? 1 : 0, outcome: failed ? "failed" : "passed", output: "out", fingerprint, head: fingerprint, startedAt: at, finishedAt: at, ...changes };
}
const review = (lens: Lens, fingerprint: string, verdict: Review["verdict"] = "pass", findings: string[] = [], extra: Partial<Review> = {}): Review => ({ lens, fingerprint, verdict, findings, at, ...extra });
const lens = (s: Workflow, r: Review) => send(s, { type: "reviewed", review: r });
const verify = (s: Workflow, fingerprint: string, changes: Partial<Evidence> = {}) => send(s, { type: "evidence", evidence: evidence("verification", fingerprint, changes) });
function implement(s: Workflow, id: string, fingerprint: string): Workflow {
	s = send(s, { type: "step_started", id });
	s = send(s, { type: "evidence", evidence: evidence("red", fingerprint, { stepId: id }) });
	s = send(s, { type: "evidence", evidence: evidence("green", fingerprint, { stepId: id }) });
	return send(s, { type: "step_completed", id, commit: `commit-${id}`, fingerprint });
}
function approved(lenses?: Plan["lenses"]): Workflow {
	const s = send(createWorkflow(source, checkout, "workflow", at), { type: "explored", exploration });
	return send(send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan: plan(lenses) }), { type: "approved" });
}
const SECRET = "src/a.ts:1 · secreto en el log";
/** D1, quality y compliance pasan sobre `tree`; security falla con un blocker (sin severidades: el formato anterior). */
function insecure(findings = [SECRET], lenses?: Plan["lenses"]): Workflow {
	let s = verify(implement(approved(lenses), "C1", "tree"), "tree");
	for (const r of [review("quality", "tree"), review("compliance", "tree"), review("security", "tree", "fail", findings)]) s = lens(s, r);
	return s;
}
const accept = (s: Workflow, findings = [SECRET], fingerprint = "tree", reason = "Preexistente en main; se sigue en otro issue") => send(s, { type: "risk_accepted", fingerprint, findings, reason });
const acceptedOf = (s: Workflow) => s.version === 2 ? s.acceptedRisks : undefined;

test("harness_accept_risk una persona acepta los hallazgos de seguridad del contenido y verified sigue; una frase del chat no alcanza", () => {
	let s = insecure();
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }), /seguridad/);
	// Lo que diga el chat no acepta nada: queda como acuerdo y el blocker sigue frenando.
	s = send(s, { type: "agreed", quote: "acepto el riesgo de seguridad", summary: "Aceptar el riesgo", replan: false });
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }), /seguridad/);
	const accepted = accept(s);
	assert.deepEqual(acceptedOf(accepted), [{ fingerprint: "tree", findings: [SECRET], reason: "Preexistente en main; se sigue en otro issue", at }]);
	assert.equal(accepted.activity, "risk_accepted: Preexistente en main; se sigue en otro issue");
	const security = lensStatuses(accepted).find((st) => st.lens === "security")!;
	assert.equal(security.blocking, false); assert.equal(security.accepted, true);
	assert.equal(send(accepted, { type: "verified", fingerprint: "tree" }).phase, "pr");
});

test("harness_accept_risk vale sólo para ese contenido y esos hallazgos: otro contenido, otro hallazgo, sin fail, sin motivo, dos veces o fuera de Verificar se rechazan", () => {
	const s = insecure([SECRET, "src/a.ts:2 · token en la URL"]);
	assert.throws(() => accept(s, [SECRET, "src/a.ts:2 · token en la URL"], "tree2"), /no hay hallazgos de seguridad sin aceptar sobre este contenido/);
	assert.throws(() => accept(s, ["src/a.ts:9 · otro hallazgo"]), /no son los que bloquean este contenido/);
	assert.throws(() => accept(s, [SECRET]), /no son los que bloquean este contenido/, "aceptar una parte no alcanza: se aceptan todos los que bloquean");
	assert.throws(() => accept(s, [SECRET, "src/a.ts:2 · token en la URL"], "tree", "   "), /falta el motivo/);
	assert.throws(() => accept(s, [SECRET, "src/a.ts:2 · token en la URL"], "tree", "x".repeat(2001)), /demasiado largo/);
	const once = accept(s, [SECRET, "src/a.ts:2 · token en la URL"]);
	assert.throws(() => accept(once, [SECRET, "src/a.ts:2 · token en la URL"]), /no hay hallazgos de seguridad sin aceptar/, "dos veces");
	let passed = verify(implement(approved(), "C1", "tree"), "tree");
	passed = lens(passed, review("security", "tree"));
	assert.throws(() => accept(passed), /no hay hallazgos de seguridad sin aceptar/, "sin fail");
	let advisory = verify(implement(approved(), "C1", "tree"), "tree");
	advisory = lens(advisory, review("security", "tree", "fail", [SECRET], { severities: ["aviso"] }));
	assert.throws(() => accept(advisory), /no hay hallazgos de seguridad sin aceptar/, "un fail de sólo avisos no tiene nada que aceptar");
	assert.throws(() => accept(approved()), /evento inválido en fase implement/, "fuera de Verificar");
	const full = { ...insecure(), acceptedRisks: Array.from({ length: 10 }, (_, i) => ({ fingerprint: `old-${i}`, findings: ["viejo"], reason: "viejo", at })) };
	assert.throws(() => accept(full), /tope de 10/);
});

test("harness_accept_risk si el contenido cambia, seguridad se vuelve a evaluar: retry borra lo aceptado y el mismo hallazgo sobre tree2 vuelve a frenar", () => {
	const accepted = accept(insecure());
	// Un D rojo sobre el contenido sucio pide una vuelta: retry descarta lo aceptado.
	const retried = send(verify(accepted, "tree", { exitCode: 1, outcome: "failed" }), { type: "retry", reason: "Falló D1" });
	assert.equal(retried.round, 1); assert.equal(acceptedOf(retried), undefined); assert.ok(!("acceptedRisks" in retried), "sin aceptaciones el campo no queda, ni vacío");
	let again = verify(implement(retried, "C2", "tree2"), "tree2");
	for (const r of [review("quality", "tree2"), review("compliance", "tree2"), review("security", "tree2", "fail", [SECRET])]) again = lens(again, r);
	assert.throws(() => send(again, { type: "verified", fingerprint: "tree2" }), /seguridad/);
	assert.throws(() => accept(again, [SECRET], "tree"), /no hay hallazgos/, "lo aceptado sobre tree no vale para tree2");
	assert.equal(send(accept(again, [SECRET], "tree2"), { type: "verified", fingerprint: "tree2" }).phase, "pr");
	// refresh y un replan también lo borran.
	const refreshed = send(accepted, { type: "source_changed", source: { ...source, body: "Otros detalles" } });
	assert.ok(!("acceptedRisks" in refreshed));
	const replanned = send(accepted, { type: "agreed", quote: "cambiemos el alcance", summary: "Otro alcance", replan: true });
	assert.equal(replanned.phase, "recipe"); assert.ok(!("acceptedRisks" in replanned));
});

test("harness_accept_risk con el riesgo aceptado, retry y amend no descartan la decisión", () => {
	let s = lens(verify(implement(approved(), "C1", "tree"), "tree"), review("quality", "tree"));
	s = lens(lens(s, review("compliance", "tree", "fail", ["test.cjs:3 · el assert quedó más débil"])), review("security", "tree", "fail", [SECRET]));
	s = accept(s);
	assert.throws(() => send(s, { type: "retry", reason: "Corregir el aviso de compliance" }), /aceptó el riesgo/);
	assert.throws(() => send(s, { type: "retry", reason: "Corregir el aviso de compliance", fingerprint: "tree" }), /aceptó el riesgo/);
	assert.throws(() => send(s, { type: "amend", reason: "Restaurar el assert", fingerprint: "tree" }), /aceptó el riesgo/);
	assert.equal(send(s, { type: "verified", fingerprint: "tree" }).phase, "pr");
});

test("harness_accept_risk con el riesgo aceptado, un gate rojo sí se corrige con amend y retry con el contenido limpio apunta a amend", () => {
	const s = send(accept(insecure()), { type: "evidence", evidence: evidence("gate", "tree", { command: "npm run lint", exitCode: 1, outcome: "failed" }) });
	assert.throws(() => send(s, { type: "verified", fingerprint: "tree" }), /gate fallido/);
	assert.throws(() => send(s, { type: "retry", reason: "Falló lint", fingerprint: "tree" }), (error: Error) => /sobre este contenido se corrige con amend/.test(error.message) && !/aceptó el riesgo/.test(error.message));
	const amended = send(s, { type: "amend", reason: "Corregir lint", fingerprint: "tree" });
	assert.equal(amended.phase, "implement"); assert.equal(amended.round, 0);
	assert.deepEqual(amended.steps.map((step) => [step.id, step.status]), [["C1", "done"], ["C2", "pending"]]);
});

test("harness_accept_risk pausado o con las vueltas agotadas por seguridad, aceptar destraba; con un D o gate fallado, no", () => {
	const exhausted = (s: Workflow) => {
		const next = send({ ...s, round: 3 }, { type: "retry", reason: "Falló security" });
		assert.equal(next.status, "waiting"); assert.match(next.blockedReason, /agotaron las vueltas/); return next;
	};
	// Agotado sólo por security: aceptar lo destraba y verified sigue.
	const waiting = accept(exhausted(insecure()));
	assert.equal(waiting.status, "active"); assert.equal(waiting.blockedReason, "");
	assert.equal(send(waiting, { type: "verified", fingerprint: "tree" }).phase, "pr");
	// Pausado y agotado: aceptar limpia el bloqueo sin reanudar; resume sigue activo.
	const paused = accept(send(exhausted(insecure()), { type: "pause", reason: "Lo decide una persona" }));
	assert.equal(paused.status, "paused"); assert.equal(paused.blockedReason, "");
	assert.equal(send(paused, { type: "resume" }).status, "active");
	// Con un gate rojo sobre el contenido, aceptar el riesgo no alcanza: las vueltas siguen agotadas.
	const gate = accept(exhausted(send(insecure(), { type: "evidence", evidence: evidence("gate", "tree", { command: "npm run lint", exitCode: 1, outcome: "failed" }) })));
	assert.equal(gate.status, "waiting"); assert.match(gate.blockedReason, /agotaron las vueltas/);
	// Con un D rojo y pausado: queda pausado y resume vuelve a las vueltas agotadas.
	const red = accept(send(exhausted(verify(insecure(), "tree", { exitCode: 1, outcome: "failed" })), { type: "pause", reason: "Lo decide una persona" }));
	assert.equal(red.status, "paused"); assert.match(red.blockedReason, /agotaron las vueltas/);
	const resumed = send(red, { type: "resume" }); assert.equal(resumed.status, "waiting"); assert.match(resumed.blockedReason, /agotaron las vueltas/);
});

// Review del incidente (2026-11-26): un D interrumpido no es un rojo. Contarlo dejaba el trabajo agotado después de aceptar,
// y con las vueltas agotadas el reducer ni siquiera deja volver a correr el D.
test("harness_accept_risk con un D o un gate interrumpido, aceptar destraba las vueltas agotadas y el check se vuelve a correr", () => {
	const interrupted = { exitCode: null, outcome: "interrupted" } as const;
	const exhausted = (s: Workflow) => send({ ...s, round: 3 }, { type: "retry", reason: "Falló security", fingerprint: "tree" });
	const d = exhausted(verify(insecure(), "tree", interrupted));
	assert.match(d.blockedReason, /agotaron las vueltas/);
	const accepted = accept(d);
	assert.equal(accepted.status, "active"); assert.equal(accepted.blockedReason, "");
	assert.equal(send(verify(accepted, "tree"), { type: "verified", fingerprint: "tree" }).phase, "pr", "el D se vuelve a correr y verified sigue");
	const gate = accept(exhausted(send(insecure(), { type: "evidence", evidence: evidence("gate", "tree", interrupted) })));
	assert.equal(gate.status, "active");
});

test("harness_accept_risk un blocker aceptado no se reabre con otra corrida de security sobre el mismo contenido; uno sin aceptar tampoco, aunque un refuter apruebe", () => {
	const lenses: Plan["lenses"] = ["quality", "compliance", "security", "refuter"];
	const accepted = accept(insecure([SECRET], lenses));
	assert.throws(() => lens(accepted, review("security", "tree")), /ya falló sobre este contenido; queda como aviso/);
	const refuted = lens(insecure([SECRET], lenses), review("refuter", "tree"));
	assert.throws(() => lens(refuted, review("security", "tree")), (error: Error) => /blocker/.test(error.message) && /\/omi-work accept-risk/.test(error.message));
});

test("harness_accept_risk un estado guardado sin riesgos aceptados carga y su fail sigue bloqueando; uno con riesgos aceptados también carga", () => {
	const saved = insecure(); assert.ok(!("acceptedRisks" in saved));
	const legacy = parseWorkflow(JSON.stringify(saved));
	assert.throws(() => send(legacy, { type: "verified", fingerprint: "tree" }), /seguridad/);
	assert.equal(lensStatuses(legacy).find((st) => st.lens === "security")?.blocking, true);
	const accepted = accept(insecure());
	assert.equal(Value.Check(WorkflowV2Schema, accepted), true);
	const loaded = parseWorkflow(JSON.stringify(accepted));
	assert.deepEqual(acceptedOf(loaded), acceptedOf(accepted));
	assert.equal(send(loaded, { type: "verified", fingerprint: "tree" }).phase, "pr");
});

test("harness_accept_risk el PR draft y la sección del issue muestran «Riesgos aceptados por una persona»", () => {
	const findings = [SECRET, "src/a.ts:2 · token en la URL"];
	const before = insecure(findings);
	assert.doesNotMatch(renderWorkflowArtifact(before), /Riesgos aceptados/); assert.doesNotMatch(renderIssueSection(before), /Riesgos aceptados/);
	const s = send(accept(before, findings), { type: "verified", fingerprint: "tree" });
	const pr = renderWorkflowArtifact(s);
	assert.match(pr, /^## Riesgos aceptados por una persona\nHallazgos de seguridad que bloqueaban Verificar y una persona aceptó con `\/omi-work accept-risk` desde la TUI de OMI\./m);
	assert.match(pr, /^- \*\*Contenido `tree`\*\* · 2026-01-01T00:00:00Z · \*\*Motivo:\*\* Preexistente en main; se sigue en otro issue\n {2}- src\/a\.ts:1 · secreto en el log\n {2}- src\/a\.ts:2 · token en la URL$/m);
	assert.match(pr, /^ {2}- \*\*Seguridad:\*\* ❌ fail · riesgo aceptado por una persona$/m);
	assert.ok(pr.indexOf("## Advertencias") < pr.indexOf("## Riesgos aceptados"), "va después de las advertencias");
	const [full, summary, minimal] = issueSectionVariants(s);
	assert.match(full!, /^### Riesgos aceptados por una persona$/m); assert.match(full!, /^- \*\*Seguridad:\*\* ❌ fail · riesgo aceptado por una persona$/m);
	assert.match(full!, /^ {2}- src\/a\.ts:2 · token en la URL$/m);
	assert.match(summary!, /^ {2}- src\/a\.ts:1 · secreto en el log\n {2}- _y 1 hallazgos más en OMI_$/m);
	assert.match(minimal!, /^### Riesgos aceptados por una persona$/m); assert.match(minimal!, /_2 hallazgos en OMI_/);
});
