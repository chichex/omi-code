// Corrección liviana: un D o un gate rojo, o un hallazgo de un lente que sólo avisa, se corrige sin gastar una vuelta entera.
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
	// Sin el contenido limpio observado, lo que bloquea sí puede pedir una vuelta, aunque además haya avisos.
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

test("harness_amend sólo corrige avisos o rojos sobre este contenido", () => {
	let clean = verify(verifying(), "tree");
	for (const r of [review("quality", "tree"), review("compliance", "tree"), review("security", "tree")]) clean = lens(clean, r);
	assert.throws(() => amend(clean), /ningún hallazgo/);
	assert.throws(() => amend(flagged(), "otro"), /ningún hallazgo/);
	// Regla nueva (2026-11-26): un D rojo ya no pide retry, amend lo corrige (ver «un D rojo se corrige con amend»). Un blocker de security sí.
	const failedD = send(flagged(), { type: "evidence", evidence: evidence("verification", "tree", { exitCode: 1, outcome: "failed" }) });
	assert.equal(amend(failedD).round, 0);
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

// Pedido del dueño (2026-11-26): un D o un gate rojo se corrige con amend, sin gastar vuelta. #99 gastó 2 de 3 retry así.
const failedGate = (s: Workflow, fingerprint: string, command = "npm run typecheck", changes: Partial<Evidence> = {}) => send(s, { type: "evidence", evidence: evidence("gate", fingerprint, { command, exitCode: 2, outcome: "failed", ...changes }) });
const passedGate = (s: Workflow, fingerprint: string, command = "npm run typecheck") => send(s, { type: "evidence", evidence: evidence("gate", fingerprint, { command }) });
const failedD = (s: Workflow, fingerprint: string, changes: Partial<Evidence> = {}) => send(s, { type: "evidence", evidence: evidence("verification", fingerprint, { exitCode: 1, outcome: "failed", ...changes }) });
/** Los tres lentes aprueban limpio sobre `fingerprint`. */
function cleanLenses(s: Workflow, fingerprint = "tree"): Workflow {
	for (const r of [review("quality", fingerprint), review("compliance", fingerprint), review("security", fingerprint)]) s = lens(s, r);
	return s;
}
const verified = (s: Workflow, fingerprint: string) => send(s, { type: "verified", fingerprint });

test("harness_amend un D rojo se corrige con amend sin gastar vuelta: después se repiten el D, security y el lente que avisó", () => {
	const red = failedD(flagged(), "tree");
	let s = amend(red, "tree", "D1 falla con el valor 0");
	assert.equal(s.phase, "implement"); assert.equal(s.round, 0); assert.deepEqual(s.evidence, red.evidence); assert.deepEqual(s.reviews, red.reviews);
	assert.deepEqual(s.steps.map((step) => [step.id, step.status]), [["C1", "done"], ["C2", "pending"]]);
	assert.match(s.steps[1]!.title, /^Corrección liviana: D1 falla con el valor 0/);
	// El paso nuevo exige su propio rojo, verde y commit.
	assert.throws(() => send(s, { type: "step_completed", id: "C2", commit: "commit-C2", fingerprint: "tree2" }));
	s = implement(s, "C2", "tree2");
	assert.throws(() => verified(s, "tree2"), /caso D1/);
	s = verify(s, "tree2");
	assert.throws(() => verified(s, "tree2"), /lente compliance/);
	s = lens(s, review("compliance", "tree2"));
	assert.throws(() => verified(s, "tree2"), /lente security/);
	assert.equal(verified(lens(s, review("security", "tree2")), "tree2").phase, "pr");
});

test("harness_amend un gate rojo se corrige con amend aunque ningún lente avise, y el gate se repite sobre el contenido corregido", () => {
	const red = failedGate(cleanLenses(verify(verifying(), "tree")), "tree");
	let s = amend(red, "tree", "typecheck: falta un tipo");
	assert.equal(s.phase, "implement"); assert.equal(s.round, 0);
	s = lens(verify(implement(s, "C2", "tree2"), "tree2"), review("security", "tree2"));
	assert.throws(() => verified(s, "tree2"), /gate fallido: npm run typecheck/);
	s = passedGate(s, "tree2");
	assert.equal(verified(s, "tree2").phase, "pr");
});

test("harness_amend un D o gate interrumpido no es un rojo del cambio: se vuelve a correr", () => {
	const gate = failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm test", { exitCode: null, outcome: "interrupted" });
	assert.throws(() => amend(gate), /interrump/);
	assert.throws(() => verified(gate, "tree"), /gate fallido/);
	assert.equal(verified(passedGate(gate, "tree", "npm test"), "tree").phase, "pr");
	const d = failedD(cleanLenses(verify(verifying(), "tree")), "tree", { exitCode: null, outcome: "interrupted" });
	assert.throws(() => amend(d), /interrump/);
	assert.throws(() => verified(d, "tree"), /caso D1/);
	assert.equal(verified(verify(d, "tree"), "tree").phase, "pr");
});

test("harness_retry con el contenido limpio, un D o gate rojo que amend corrige no gasta vuelta: retry apunta a amend", () => {
	const retry = (s: Workflow, fingerprint?: string) => send(s, { type: "retry", reason: "Falló typecheck", ...(fingerprint ? { fingerprint } : {}) });
	const red = failedGate(cleanLenses(verify(verifying(), "tree")), "tree");
	assert.throws(() => retry(red, "tree"), /amend/);
	assert.equal(amend(red).phase, "implement", "lo que retry rechaza, amend lo acepta con el mismo contenido");
	const redD = failedD(cleanLenses(verify(verifying(), "tree")), "tree");
	assert.throws(() => retry(redD, "tree"), /amend/);
	// En la última vuelta, un rojo con amend disponible no agota las vueltas: apunta a amend.
	const last = { ...red, round: 3 } as Workflow;
	assert.throws(() => retry(last, "tree"), /amend/);
	assert.equal(last.status, "active"); assert.equal(amend(last).round, 3);
	// Sin contenido limpio observado (checkout sucio), amend no puede: retry sigue disponible.
	assert.equal(retry(red).round, 1);
	// Sin amends en la vuelta, el rojo vuelve a pedir retry.
	let s = implement(amend(red), "C2", "tree2");
	s = implement(amend(failedGate(lens(verify(s, "tree2"), review("security", "tree2")), "tree2"), "tree2"), "C3", "tree3");
	s = failedGate(lens(verify(s, "tree3"), review("security", "tree3")), "tree3");
	assert.throws(() => amend(s, "tree3"), /2 correcciones livianas/);
	assert.equal(retry(s, "tree3").round, 1);
	// Un blocker de security sigue pidiendo retry aunque además haya un D rojo: amend no lo corrige.
	const blocker = lens(failedD(verify(verifying(), "tree"), "tree"), review("security", "tree", "fail", ["src/a.ts:1 · secreto"]));
	assert.throws(() => amend(blocker), /blocker de security[^:]*: eso pide retry/);
	assert.equal(retry(blocker, "tree").round, 1);
});

test("harness_amend verified: manda la última corrida de cada gate de la vuelta; un rojo de antes de un amend se repite y un pass de antes de un amend por aviso vale", () => {
	// Un gate rojo sobre otro contenido de la vuelta, nunca repetido sobre el final, frena.
	const other = cleanLenses(verify(failedGate(verifying(), "other", "npm test", { exitCode: 1 }), "tree"));
	assert.throws(() => verified(other, "tree"), /gate fallido: npm test/);
	assert.equal(verified(passedGate(other, "tree", "npm test"), "tree").phase, "pr");
	// Manda la última corrida, no cualquier pass: pasó y después falló sobre tree; sin repetirlo sobre tree2, frena.
	let flipped = failedGate(passedGate(flagged(), "tree"), "tree");
	flipped = cleanLenses(verify(implement(amend(flipped), "C2", "tree2"), "tree2"), "tree2");
	assert.throws(() => verified(flipped, "tree2"), /gate fallido: npm run typecheck/);
	// Un gate que pasó antes de un amend por un aviso sigue valiendo, como el lente que aprobó limpio.
	let carried = implement(amend(passedGate(flagged(), "tree")), "C2", "tree2");
	carried = lens(lens(verify(carried, "tree2"), review("compliance", "tree2")), review("security", "tree2"));
	assert.equal(verified(carried, "tree2").phase, "pr");
	// Sobre este contenido manda su última corrida, aunque antes haya fallado.
	assert.equal(verified(passedGate(failedGate(carried, "tree2"), "tree2"), "tree2").phase, "pr");
});

test("harness_amend un comando ausente (126/127) no cuenta como gate ni traba la vuelta; una interrumpida sólo cuenta sobre este contenido; amend lo explica", () => {
	const missing = { exitCode: 127, outcome: "failed" } as const;
	// (1) 127 sobre A y amend por un aviso: verified sobre B pasa sin ese gate.
	let s = implement(amend(failedGate(flagged(), "tree", "omi-no-existe", missing)), "C2", "tree2");
	s = lens(lens(verify(s, "tree2"), review("compliance", "tree2")), review("security", "tree2"));
	assert.equal(verified(s, "tree2").phase, "pr");
	// (2) 126 o 127 sobre B tampoco frena: el comando nunca corrió.
	assert.equal(verified(failedGate(s, "tree2", "omi-no-existe", missing), "tree2").phase, "pr");
	assert.equal(verified(failedGate(s, "tree2", "./no-ejecutable.sh", { exitCode: 126 }), "tree2").phase, "pr");
	// (3) Una interrumpida sobre A que no se repitió no frena B.
	let interrupted = implement(amend(failedGate(flagged(), "tree", "npm test", { exitCode: null, outcome: "interrupted" })), "C2", "tree2");
	interrupted = lens(lens(verify(interrupted, "tree2"), review("compliance", "tree2")), review("security", "tree2"));
	assert.equal(verified(interrupted, "tree2").phase, "pr");
	// (4) Una interrumpida sobre B sí frena: tiene que pasar sobre este contenido.
	assert.throws(() => verified(failedGate(interrupted, "tree2", "npm test", { exitCode: null, outcome: "interrupted" }), "tree2"), /gate fallido: npm test/);
	// (5) Sin hallazgos y con sólo un comando ausente, amend dice por qué no corrige.
	const onlyMissing = failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "omi-no-existe", missing);
	assert.throws(() => amend(onlyMissing), /no existe o no es ejecutable/);
	assert.throws(() => amend(failedD(cleanLenses(verify(verifying(), "tree")), "tree", { exitCode: 126 })), /D de la receta, pausá/);
});

// Review del incidente (2026-11-26): retry juzgaba toda la evidencia de la vuelta. Un rojo ya corregido o que no se
// reprodujo, un corte por tiempo o un comando ausente gastaban una vuelta y, en la última, frenaban el trabajo.
const retryOn = (s: Workflow, fingerprint: string) => send(s, { type: "retry", reason: "Falló npm test", fingerprint });

test("harness_retry vale la última corrida de cada check sobre este contenido: un rojo corregido o que no se reprodujo no pide vuelta", () => {
	// Rojo sobre tree, amend y C2 en tree2: sobre tree2 todo pasa y compliance sólo avisa.
	let s = implement(amend(failedGate(flagged(), "tree", "npm test", { exitCode: 1 })), "C2", "tree2");
	s = passedGate(lens(lens(verify(s, "tree2"), review("security", "tree2")), review("compliance", "tree2", "fail", ["test.cjs:3 · sigue débil"])), "tree2", "npm test");
	assert.equal(verified(s, "tree2").phase, "pr");
	assert.throws(() => retryOn(s, "tree2"), /sólo avisan/);
	// Un gate flaky: falló y después pasó sobre el mismo contenido, con sólo avisos.
	const flaky = passedGate(failedGate(flagged(), "tree", "npm test", { exitCode: 1 }), "tree", "npm test");
	assert.throws(() => retryOn(flaky, "tree"), /sólo avisan/);
	// Un D que falló y después pasó, igual.
	assert.throws(() => retryOn(verify(failedD(flagged(), "tree"), "tree"), "tree"), /sólo avisan/);
});

test("harness_retry un D o un gate interrumpido o con comando ausente se vuelve a correr: retry no gasta la vuelta ni agota la última", () => {
	const interrupted = { exitCode: null, outcome: "interrupted" } as const;
	const gate = failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm test", interrupted);
	assert.throws(() => retryOn(gate, "tree"), /interrumpido[^:]*: no es un rojo del cambio; volvé a correrlo con el timeoutSeconds que sugiere OMI/);
	assert.equal(retryOn(passedGate(gate, "tree", "npm test"), "tree").round, 1, "repetido y verde, nada lo frena: los topes y los lentes agotados siguen pidiendo retry");
	// En la última vuelta, un D interrumpido no deja el trabajo esperando con las vueltas agotadas.
	const last = { ...failedD(cleanLenses(verify(verifying(), "tree")), "tree", interrupted), round: 3 } as Workflow;
	assert.throws(() => retryOn(last, "tree"), /interrumpido/);
	assert.equal(verified(verify(last, "tree"), "tree").phase, "pr", "volver a correrlo lo resuelve");
	// Un gate con un comando que no existe, con un aviso de por medio.
	assert.throws(() => retryOn(failedGate(flagged(), "tree", "nmp test", { exitCode: 127 }), "tree"), /no existe o no es ejecutable/);
	// Con un rojo de verdad o un blocker de security, el interrumpido no cambia nada: retry sigue.
	const blocker = lens(failedD(verify(verifying(), "tree"), "tree", interrupted), review("security", "tree", "fail", ["src/a.ts:1 · secreto"]));
	assert.equal(retryOn(blocker, "tree").round, 1);
	// Cortado con el tope del host (1800 s), volver a correrlo no le da más tiempo: cuenta como rojo y retry sigue.
	const capped = failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm test", { ...interrupted, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:30:01Z" });
	assert.equal(retryOn(capped, "tree").round, 1);
	// Sin el contenido limpio (checkout sucio), retry no puede saber qué vale y sigue la regla de toda la vuelta.
	assert.equal(send(gate, { type: "retry", reason: "checkout sucio" }).round, 1);
});

// Review del incidente (ronda 2, correctness-2-senal-sin-salida y queue-2-retry-senal-sin-salida): un D o un gate que el cambio
// mata por señal (exit 128 o más: SIGSEGV 139, OOM 137, abort 134) quedaba interrumpido para siempre. retry, amend y verified
// lo rechazaban, y volver a correrlo daba lo mismo. En main, retry lo aceptaba.
test("harness_retry un crash que se repite (misma señal, exit 128 o más) sobre este contenido es un rojo: amend lo corrige y, sin amends, retry abre vuelta", () => {
	const crash = { exitCode: 139, outcome: "interrupted" } as const;
	const once = failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm run test:native", crash);
	assert.throws(() => retryOn(once, "tree"), /interrumpido[^:]*: no es un rojo del cambio; volvé a correrlo/, "una sola vez se vuelve a correr");
	assert.throws(() => amend(once), /interrumpido/);
	const twice = failedGate(once, "tree", "npm run test:native", crash);
	assert.throws(() => retryOn(twice, "tree"), /amend/, "un crash repetido se corrige con amend: retry apunta a amend");
	assert.equal(amend(twice).round, 0, "amend lo corrige sin gastar vuelta");
	assert.throws(() => verified(twice, "tree"), /gate fallido/, "verified sigue frenado");
	const spent = { ...twice, amends: [{ from: "x", reason: "uno", at }, { from: "y", reason: "dos", at }] } as Workflow;
	assert.equal(retryOn(spent, "tree").round, 1, "sin amends, retry abre la vuelta");
	assert.throws(() => retryOn(failedGate(once, "tree", "npm run test:native", { exitCode: 137, outcome: "interrupted" }), "tree"), /interrumpido/, "otra señal no es el mismo crash");
	assert.throws(() => retryOn(failedGate(failedGate(cleanLenses(verify(verifying(), "tree")), "old", "npm run test:native", crash), "tree", "npm run test:native", crash), "tree"), /interrumpido/, "un crash sobre otro contenido no cuenta");
	assert.throws(() => retryOn(failedGate(failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm run test:native", { exitCode: null, outcome: "interrupted" }), "tree", "npm run test:native", { exitCode: null, outcome: "interrupted" }), "tree"), /interrumpido/, "dos cortes sin código no son un crash");
	const d = failedD(failedD(cleanLenses(verify(verifying(), "tree")), "tree", crash), "tree", crash);
	assert.equal(amend(d).round, 0, "un D que crashea igual dos veces también se corrige con amend");
});

// Review del incidente (ronda 3, correctness-3-crash-amend-salta-gate): tras un amend, verified buscaba la última corrida que
// «juzgó» un gate sólo entre pass y exit 1 a 125. Un crash repetido (que amend corrige) quedaba afuera y el gate pasaba sin
// repetirse sobre el contenido nuevo.
test("harness_amend tras un amend por un crash repetido, verified exige repetir el gate sobre el contenido nuevo", () => {
	const crash = { exitCode: 139, outcome: "interrupted" } as const;
	const twice = failedGate(failedGate(cleanLenses(verify(verifying(), "tree")), "tree", "npm run test:native", crash), "tree", "npm run test:native", crash);
	const fixed = lens(verify(implement(amend(twice, "tree", "Arreglar el crash"), "C2", "tree2"), "tree2"), review("security", "tree2"));
	assert.throws(() => verified(fixed, "tree2"), /gate fallido: npm run test:native/, "el crash de tree manda mientras no se repita");
	assert.equal(verified(passedGate(fixed, "tree2", "npm run test:native"), "tree2").phase, "pr", "repetido y verde, sigue");
});
