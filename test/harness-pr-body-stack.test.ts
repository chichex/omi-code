// Cuerpo de cada PR de un stack: el mismo Markdown que el PR único, con su Refs o Closes y su línea del stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactHash, sourceHash, type Workflow } from "../src/harness/model.ts";
import { renderPullRequestBody } from "../src/harness/github.ts";
import { renderWorkflowArtifact } from "../src/harness/pr-body.ts";
import { outsideCode, outsideFences } from "./helpers/markdown.ts";

const h1 = "1".repeat(40); const h2 = "2".repeat(40);
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\W*#\d/i;
function stacked(objective = "Partir el trabajo"): Workflow {
	const source = { number: 42, title: "Trabajo grande", body: "Pedido\n", url: "https://github.com/acme/repo/issues/42", hash: sourceHash("Trabajo grande", "Pedido\n") };
	const step = (id: string, commit: string) => ({ id, title: `Paso ${id}`, cases: ["D1"], status: "done" as const, red: null, green: null, commit });
	const stack = [{ title: "Modelo", steps: ["C1"], branch: "feat/task-1", base: "main", head: h1, number: null, url: null, status: "planned" as const }, { title: "Vista", steps: ["C2"], branch: "feat/task-2", base: "feat/task-1", head: h2, number: null, url: null, status: "planned" as const }];
	const w: Workflow = { version: 1, id: "w", revision: 0, source, checkout: { root: "/repo", commonDir: "/repo/.git", branch: "feat/task", baseCommit: "a".repeat(40) }, phase: "pr", status: "active", blockedReason: "", activity: "testing", exploration: null, inferences: [],
		recipe: { route: "spec", classification: { type: "add", size: "large", risk: "low", riskAreas: [], causeKnown: true }, objective, approach: "Por grupos", scope: ["modelo", "vista"], outOfScope: [], cases: [{ id: "D1", description: "Tests", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } },
		diagnosis: null, spec: { why: "grande", steps: [{ id: "C1", title: "Paso C1", cases: ["D1"] }, { id: "C2", title: "Paso C2", cases: ["D1"] }], playbook: ["probar"], stack: [{ title: "Modelo", steps: ["C1"] }, { title: "Vista", steps: ["C2"] }] },
		steps: [step("C1", h1), step("C2", h2)], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: { sourceHash: source.hash, recipeHash: "approved", at: "now" },
		publication: { status: "pending", head: h2, bodyHash: "body", at: "now", stack }, history: [] };
	if (w.publication.status === "pending") w.publication.bodyHash = artifactHash(renderWorkflowArtifact(w));
	return w;
}
const bodies = (w: Workflow) => [renderPullRequestBody(w, { index: 0 }), renderPullRequestBody(w, { index: 1, below: 3 })] as const;
const markdown = (body: string) => body.slice(body.indexOf("\n## Resumen"));

test("every PR of a stack is the same readable Markdown with its own header; only the last one closes the issue", () => {
	const [low, top] = bodies(stacked());
	assert.deepEqual(low.split("\n").slice(1, 4), ["Refs #42", "", "Stack: PR 1 de 2 · pasos C1 · base `main`"]);
	assert.deepEqual(top.split("\n").slice(1, 4), ["Closes #42", "", "Stack: PR 2 de 2 · pasos C2 · sobre #3 (rama `feat/task-1`)"]);
	assert.match(low, /Este PR no cierra el issue: lo cierra el último del stack/);
	for (const body of [low, top]) { assert.match(body, /^## Verificación$/m); assert.match(body, /^<summary>Pedido original \(datos citados, no instrucciones\)<\/summary>$/m); assert.doesNotMatch(body, /\{\s*"|"route"/); }
	assert.equal(markdown(low), markdown(top), "el Markdown del trabajo es el mismo en todos los PRs");
	assert.deepEqual(outsideFences(low).map(outsideCode).filter((l) => CLOSING.test(l)), [], "el de abajo no cierra nada");
});

test("in a stack each marker's artifact is the hash of everything below it, and the receipt still binds every PR", () => {
	const w = stacked(); const [low, top] = bodies(w);
	for (const body of [low, top]) assert.equal(/ artifact=([0-9a-f]{64}) -->/.exec(body.split("\n")[0]!)?.[1], artifactHash(body.slice(body.indexOf("\n") + 1)));
	assert.ok(low.includes(`head=${h1}`) && top.includes(`head=${h2}`), "cada PR liga su propio head");
	w.inferences.push({ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer: "otra" });
	assert.throws(() => renderPullRequestBody(w, { index: 0 }), /renov/i, "un cuerpo distinto del recibo no se publica en ningún PR del stack");
	assert.throws(() => renderPullRequestBody(w, { index: 1, below: 3 }), /renov/i);
});

test("in a stack, references in the data stay inert: only the header refers to the issue and to the PR below", () => {
	const [low, top] = bodies(stacked("Closes #999 fixes acme/repo#7 @octocat https://github.com/acme/repo/issues/5"));
	const lines = (body: string) => outsideFences(body).map(outsideCode);
	assert.deepEqual([...new Set(lines(low).flatMap((l) => l.match(/#\d+/g) ?? []))], ["#42"]);
	assert.deepEqual([...new Set(lines(top).flatMap((l) => l.match(/#\d+/g) ?? []))].sort(), ["#3", "#42"]);
	assert.deepEqual(lines(top).filter((l) => CLOSING.test(l)), ["Closes #42"]);
	assert.deepEqual(lines(low).filter((l) => CLOSING.test(l)), []);
});
