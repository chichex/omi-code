import assert from "node:assert/strict";
import { test } from "node:test";
import { combineLensResults, lensParts } from "../src/harness/lenses.ts";

const file = (name: string, lines: number, width = 40) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n` + `+${"x".repeat(width)}\n`.repeat(lines);
// Las etiquetas de continuación son lo único que agrega el reparto: sin ellas queda el diff original.
const unlabeled = (parts: string[]) => parts.map((p) => p.replace(/^\[continúa [^\n]*\]\n/gm, "")).join("");

test("lens parts: a diff that fits is a single part; otherwise files are packed by budget without losing anything", () => {
	const files = [file("a", 10), file("b", 10), file("c", 10)];
	assert.deepEqual(lensParts(files, 10_000), [files.join("")]);
	assert.deepEqual(lensParts([], 10_000), [""]);
	const budget = files[0]!.length + files[1]!.length;
	const parts = lensParts(files, budget);
	assert.deepEqual(parts, [files[0]! + files[1]!, files[2]!], "packs whole files in order");
	for (const p of parts) assert.ok(p.length <= budget);
});

test("lens parts: a file larger than the budget is split by lines into labeled fragments, and a huge line by characters", () => {
	const big = file("big.txt", 500); const huge = `diff --git a/min.js b/min.js\n+${"m".repeat(5000)}\n`;
	const files = [file("a", 2), big, huge, file("z", 2)]; const budget = 2000;
	const parts = lensParts(files, budget);
	assert.ok(parts.length > 10);
	for (const p of parts) assert.ok(p.length <= budget, `${p.length} > ${budget}`);
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
