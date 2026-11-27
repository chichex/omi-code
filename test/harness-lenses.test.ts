import assert from "node:assert/strict";
import { test } from "node:test";
import { combineLensResults, LENS_PART_BUDGET, lensEvidence, lensParts, lensRequests } from "../src/harness/lenses.ts";
import { createWorkflow, lensRunBlock, transition } from "../src/harness/state.ts";
import { withoutPrecedents } from "../src/harness/lens-precedents.ts";
import type { Evidence, Workflow } from "../src/harness/model.ts";

const file = (name: string, lines: number, width = 40) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n` + `+${"x".repeat(width)}\n`.repeat(lines);
// Las etiquetas de continuación son lo único que agrega el reparto: sin ellas queda el diff original.
const unlabeled = (parts: string[]) => parts.map((p) => p.replace(/^\[continúa [^\n]*\]\n/gm, "")).join("");
// El presupuesto se mide como el texto va en el JSON de la llamada: comillas, barras y saltos escapados.
const cost = (value: string) => JSON.stringify(value).length - 2;

test("lens parts: a diff that fits is a single part; otherwise files are packed by budget without losing anything", () => {
	const files = [file("a", 10), file("b", 10), file("c", 10)];
	assert.deepEqual(lensParts(files, 10_000), [files.join("")]);
	assert.deepEqual(lensParts([], 10_000), [""]);
	const budget = cost(files[0]!) + cost(files[1]!);
	const parts = lensParts(files, budget);
	assert.deepEqual(parts, [files[0]! + files[1]!, files[2]!], "packs whole files in order");
	for (const p of parts) assert.ok(cost(p) <= budget);
});

test("lens parts: a file larger than the budget is split by lines into labeled fragments, and a huge line by characters", () => {
	const big = file("big.txt", 500); const huge = `diff --git a/min.js b/min.js\n+${"m".repeat(5000)}\n`;
	const files = [file("a", 2), big, huge, file("z", 2)]; const budget = 2000;
	const parts = lensParts(files, budget);
	assert.ok(parts.length > 10);
	for (const p of parts) assert.ok(cost(p) <= budget, `${cost(p)} > ${budget}`);
	assert.equal(unlabeled(parts), files.join(""), "nada se trunca ni se reordena");
	assert.ok(parts.some((p) => /^\[continúa diff --git a\/big\.txt b\/big\.txt · fragmento 2\/\d+\]$/m.test(p)));
	assert.ok(parts.some((p) => /^\[continúa diff --git a\/min\.js b\/min\.js · fragmento \d+\/\d+\]$/m.test(p)));
	const astral = `diff --git a/e b/e\n+${"🙂".repeat(3000)}\n`;
	assert.doesNotMatch(lensParts([astral], 1000).join(""), /�/); assert.equal(unlabeled(lensParts([astral], 1000)), astral, "no corta un par sustituto");
});

test("lens results combine by part: the worst verdict wins and findings are joined with their part", () => {
	assert.deepEqual(combineLensResults([{ verdict: "pass", findings: [] }]), { verdict: "pass", findings: [] });
	assert.deepEqual(combineLensResults([{ verdict: "fail", findings: ["a.ts:1 · bug"] }]), { verdict: "fail", findings: ["a.ts:1 · bug"] }, "una sola parte no agrega prefijos");
	assert.deepEqual(combineLensResults([{ verdict: "pass", findings: [] }, { verdict: "unknown", findings: ["falta contexto"] }, { verdict: "pass", findings: [] }]), { verdict: "unknown", findings: ["parte 2/3 · falta contexto"] });
	assert.deepEqual(combineLensResults([{ verdict: "unknown", findings: ["u"] }, { verdict: "fail", findings: ["f1", "f2"] }]), { verdict: "fail", findings: ["parte 1/2 · u", "parte 2/2 · f1", "parte 2/2 · f2"] });
	const many = combineLensResults(Array.from({ length: 3 }, () => ({ verdict: "fail" as const, findings: Array.from({ length: 50 }, (_, i) => `h${i} ${"z".repeat(3995)}`) })));
	assert.equal(many.findings.length, 100); assert.match(many.findings.at(-1)!, /51 hallazgos más/);
	assert.ok(many.findings.every((f) => f.length <= 4000)); assert.match(many.findings[0]!, /^parte 1\/3 · h0 z+…$/, "un hallazgo que no entra con su prefijo se marca, no se corta en silencio");
});

test("lens results combine by part: sin resultado sólo si ninguna parte juzgó unknown; un fail juzgado sigue siendo fail", () => {
	const missing = { verdict: "unknown" as const, findings: ["Sin resultado del lente: conexión (3 intentos)"], noResult: true as const };
	assert.deepEqual(combineLensResults([missing]), missing, "una parte sin resultado conserva la marca");
	assert.deepEqual(combineLensResults([{ verdict: "pass", findings: [] }, missing]), { verdict: "unknown", findings: ["parte 2/2 · Sin resultado del lente: conexión (3 intentos)"], noResult: true });
	assert.deepEqual(combineLensResults([{ verdict: "unknown", findings: ["falta contexto"] }, missing]), { verdict: "unknown", findings: ["parte 1/2 · falta contexto", "parte 2/2 · Sin resultado del lente: conexión (3 intentos)"] }, "un unknown juzgado no se re-tira: no queda como sin resultado");
	assert.deepEqual(combineLensResults([{ verdict: "fail", findings: ["a.ts:1 · bug"] }, missing]).noResult, undefined);
	assert.equal(combineLensResults([]).noResult, true, "ninguna parte revisada");
});

test("combine en security: severidades por parte, blocker primero, sin avisos no guarda la lista y una parte sin resultado no es un blocker", () => {
	const aviso = { verdict: "fail" as const, findings: ["x"], severities: ["aviso" as const] };
	const blocker = { verdict: "fail" as const, findings: ["y"], severities: ["blocker" as const] };
	const missing = { verdict: "unknown" as const, findings: ["Sin resultado del lente: conexión (3 intentos)"], noResult: true as const };
	assert.deepEqual(combineLensResults([aviso, blocker], true), { verdict: "fail", findings: ["parte 2/2 · y", "parte 1/2 · x"], severities: ["blocker", "aviso"] }, "el blocker va primero y cada hallazgo conserva su severidad");
	assert.deepEqual(combineLensResults([{ verdict: "fail", findings: ["a"] }, blocker], true), { verdict: "fail", findings: ["parte 1/2 · a", "parte 2/2 · y"] }, "sin avisos no se guarda la lista: un estado viejo la lee igual");
	const pending = combineLensResults([aviso, missing], true);
	assert.deepEqual(pending, { verdict: "unknown", noResult: true, findings: ["parte 1/2 · x", "parte 2/2 · Sin resultado del lente: conexión (3 intentos)"] }, "sin un blocker juzgado, la parte que faltó deja la review sin resultado");
	const s = createWorkflow({ number: 42, title: "P", body: "P\n", url: "https://github.com/acme/repo/issues/42", hash: "h" }, { root: "/r", commonDir: "/r/.git", branch: "feat/x", baseCommit: "a".repeat(40) }, "w", "now");
	s.phase = "verify";
	s.recipe = { route: "direct", classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "o", approach: "a", scope: ["s"], outOfScope: [], cases: [{ id: "D1", description: "d", command: "npm test" }], lenses: ["security"], executor: { mode: "inline", writers: 0 } };
	const recorded = transition(s, { type: "reviewed", review: { lens: "security", fingerprint: "fp", ...pending, at: "now" } }, "now");
	assert.equal(lensRunBlock(recorded, "security", "fp"), "", "se vuelve a correr sin gastar veredictos");
	assert.deepEqual(combineLensResults([blocker, missing], true), { verdict: "fail", findings: ["parte 1/2 · y", "parte 2/2 · Sin resultado del lente: conexión (3 intentos)"], severities: ["blocker", "aviso"] }, "con un blocker juzgado bloquea por ese blocker, no por la parte que faltó");
	const many = combineLensResults([{ verdict: "fail", findings: Array.from({ length: 50 }, (_, i) => `a${i}`), severities: Array.from({ length: 50 }, () => "aviso" as const) }, { verdict: "fail", findings: Array.from({ length: 50 }, (_, i) => `b${i}`), severities: Array.from({ length: 50 }, () => "aviso" as const) }, blocker], true);
	assert.equal(many.findings.length, 100); assert.equal(many.findings[0], "parte 3/3 · y"); assert.match(many.findings.at(-1)!, /^… y 2 hallazgos más de las partes no entran/);
	assert.deepEqual(many.severities, ["blocker", ...Array.from({ length: 99 }, () => "aviso")], "la línea de los omitidos es aviso si ninguno era blocker");
	const hidden = combineLensResults([{ verdict: "fail", findings: Array.from({ length: 100 }, (_, i) => `c${i}`) }, aviso], true);
	assert.equal(hidden.findings.length, 100); assert.match(hidden.findings.at(-1)!, /^… y 2 hallazgos más/); assert.equal(hidden.severities, undefined, "un blocker omitido hace blocker a la línea que lo cuenta");
	assert.deepEqual(combineLensResults([{ verdict: "fail", findings: [] }, aviso], true), { verdict: "fail", findings: ["parte 1/2 · El lente de seguridad falló sin detallar hallazgos", "parte 2/2 · x"], severities: ["blocker", "aviso"] }, "un fail sin hallazgos de una parte es blocker: los avisos de otra no lo tapan");
});

// El escenario medido en la review: 5 pasos con rojo y verde, un caso D y 2 gates × 3 vueltas, todo con
// salidas de 12.000 caracteres (≈207 KB de evidencia), y un diff de ≈600 KB.
function heavy(): Workflow {
	const w = createWorkflow({ number: 42, title: "P", body: "P\n", url: "https://github.com/acme/repo/issues/42", hash: "h" }, { root: "/r", commonDir: "/r/.git", branch: "feat/x", baseCommit: "a".repeat(40) }, "w", "now");
	const run = (id: string, kind: Evidence["kind"], command: string, extra: Partial<Evidence> = {}): Evidence => ({ id, kind, command, stepId: null, caseId: null, exitCode: 0, outcome: "passed", output: `${id} `.padEnd(12_000, "o"), fingerprint: "f".repeat(64), head: "b".repeat(40), startedAt: "now", finishedAt: "now", ...extra });
	w.phase = "verify";
	w.recipe = { route: "spec", classification: { type: "add", size: "large", risk: "low", riskAreas: [], causeKnown: true }, objective: "o", approach: "a", scope: ["s"], outOfScope: [], cases: [{ id: "D1", description: "d", command: "npm test" }], lenses: ["quality"], executor: { mode: "inline", writers: 0 } };
	for (let i = 1; i <= 5; i++) {
		w.steps.push({ id: `C${i}`, title: `Paso ${i}`, cases: ["D1"], status: "done", red: `r${i}`, green: `g${i}`, commit: `${i}`.repeat(40) });
		w.evidence.push(run(`r${i}`, "red", "npm test", { stepId: `C${i}`, exitCode: 1, outcome: "failed" }), run(`g${i}`, "green", "npm test", { stepId: `C${i}` }));
	}
	w.evidence.push(run("v1", "verification", "npm test", { caseId: "D1" }));
	for (let round = 1; round <= 3; round++) for (const gate of ["npm run typecheck", "npm run lint"]) w.evidence.push(run(`${gate}-${round}`, "gate", gate));
	return w;
}
const diffFiles = () => Array.from({ length: 10 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n` + Array.from({ length: 1200 }, (_, n) => `+const s${n} = "x\\y" + 'z'; // ${"q".repeat(20)}\n`).join(""));
const unlabeledDiff = (texts: string[]) => texts.map((t) => JSON.parse(t).diff.replace(/^\[continúa [^\n]*\]\n/gm, "")).join("");

test("lens requests: with ≈207 KB of evidence and a ≈600 KB diff no call goes over the budget and the evidence is summarized explicitly", () => {
	const w = heavy(); const files = diffFiles(); const context = { content: { head: "b".repeat(40), fingerprint: "f".repeat(64) }, cases: w.recipe!.cases, scope: w.recipe!.scope, outOfScope: [] };
	const evidenceChars = JSON.stringify(lensEvidence(w)).length; const diffChars = files.join("").length;
	assert.ok(evidenceChars > 200_000 && evidenceChars < 215_000, `${evidenceChars}`); assert.ok(diffChars > 590_000 && diffChars < 620_000, `${diffChars}`);
	const texts = lensRequests(context, w, files);
	for (const text of texts) assert.ok(text.length <= LENS_PART_BUDGET, `${text.length} > ${LENS_PART_BUDGET}`);
	const sent = texts.map((t) => JSON.parse(t));
	assert.deepEqual(sent.map((m) => m.part), sent.map((_, i) => ({ index: i + 1, total: texts.length })));
	assert.equal(unlabeledDiff(texts), files.join(""), "nada del diff se omite");
	const evidence = sent[0].evidence;
	for (const m of sent) { assert.deepEqual(m.evidence, evidence); assert.deepEqual(m.cases, context.cases); }
	assert.match(evidence.summarized.rule, /rojo y el verde acreditados/);
	assert.equal(evidence.summarized.omittedRuns, 4, "las corridas viejas de los gates se cuentan, no desaparecen");
	assert.deepEqual(evidence.steps.map((s: { history: { id: string; kind: string }[] }) => s.history.map((e) => [e.kind, e.id])), [1, 2, 3, 4, 5].map((i) => [["red", `r${i}`], ["green", `g${i}`]]), "el rojo y el verde acreditados de cada paso");
	assert.deepEqual(evidence.gates.map((g: { command: string; id?: string }) => g.command), ["npm run typecheck", "npm run lint"]);
	const outputs = [...evidence.steps.flatMap((s: { history: { output: string }[] }) => s.history), evidence.cases[0].verification, ...evidence.gates].map((e: { output: string }) => e.output);
	const cap = evidence.summarized.outputChars;
	assert.ok(cap < 12_000);
	for (const output of outputs) {
		const marker = /^\[recortado: (\d+) caracteres\]/.exec(output);
		assert.ok(marker, output.slice(0, 80)); assert.equal(Number(marker[1]), 12_000 - cap); assert.ok(output.endsWith("o".repeat(Math.min(cap, 100))), "queda la cola de la salida");
	}
	assert.deepEqual(lensRequests(context, w, files), texts, "determinista");
});

test("lens requests: evidence that fits travels whole, and a small diff fits with it in one call", () => {
	const w = heavy(); w.evidence = w.evidence.slice(0, 2).map((e) => ({ ...e, output: "corto" }));
	const texts = lensRequests({ cases: w.recipe!.cases }, w, [diffFiles()[0]!.slice(0, 5000)]);
	assert.equal(texts.length, 1); const sent = JSON.parse(texts[0]!);
	assert.equal(sent.evidence.summarized, undefined); assert.deepEqual(sent.evidence, lensEvidence(w));
});

test("lens requests: material that does not fit even summarized fails explicitly instead of sending it", () => {
	const w = heavy();
	assert.throws(() => lensRequests({ cases: Array.from({ length: 30 }, (_, i) => ({ id: `D${i}`, description: "x".repeat(4000), command: "npm test" })) }, w, diffFiles()), /no entra en una llamada/);
});

test("lens requests: si con los precedentes o la revisión anterior no entra, van vacíos y lo dicen, en vez de fallar", () => {
	const w = heavy(); w.evidence = w.evidence.slice(0, 2).map((e) => ({ ...e, output: "corto" }));
	const precedents = { items: Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, line: 1, detail: "regla", excerpt: { from: 1, lines: ["x".repeat(1500)] } })), omitted: 0 };
	const previous = { fingerprint: "f".repeat(64), verdict: "fail", findings: [{ blocker: true, text: "src/a.ts:1 · y" }], changedFiles: ["src/a.ts"] };
	assert.ok(JSON.stringify(precedents).length > 45_000, `${JSON.stringify(precedents).length}`);
	const files = [file("a.ts", 200)]; const budget = 40_000;
	const texts = lensRequests({ cases: w.recipe!.cases, precedents, previous }, w, files, budget);
	for (const text of texts) assert.ok(text.length <= budget, `${text.length} > ${budget}`);
	const sent = texts.map((t) => JSON.parse(t));
	for (const m of sent) {
		assert.deepEqual(m.precedents.items, []); assert.equal(m.precedents.omitted, 30); assert.match(m.precedents.note, /no entraron en la llamada/);
		assert.deepEqual(m.previous, { omitted: true, note: "La revisión anterior no entró en la llamada; el harness igual compara los archivos cambiados." });
	}
	assert.equal(unlabeledDiff(texts), files.join(""), "el diff llega entero");
	const roomy = JSON.parse(lensRequests({ cases: w.recipe!.cases, precedents, previous }, w, files)[0]!);
	assert.deepEqual(roomy.precedents, precedents, "con lugar, viajan enteros"); assert.deepEqual(roomy.previous, previous);
	const cases = Array.from({ length: 30 }, (_, i) => ({ id: `D${i}`, description: "x".repeat(4000), command: "npm test" }));
	assert.throws(() => lensRequests({ cases, precedents: withoutPrecedents(precedents) }, heavy(), diffFiles()), /no entra en una llamada/, "sin nada que vaciar, el error de siempre");
});
