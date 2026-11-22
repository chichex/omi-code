// Cuerpo del PR draft: Markdown legible, datos inertes y un único Closes del issue validado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactHash, sourceHash, type Evidence, type Workflow } from "../src/harness/model.ts";
import { createWorkflow, recipeApprovalHash } from "../src/harness/state.ts";
import { renderWorkflowArtifact } from "../src/harness/pr-body.ts";
import { renderPullRequestBody } from "../src/harness/github.ts";
import { ACTIVE, outsideCode, outsideFences } from "./helpers/markdown.ts";

const head = "b".repeat(40);
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "fix/issue-42", baseCommit: "a".repeat(40) };
const run = (id: string, kind: Evidence["kind"], command: string, extra: Partial<Evidence> = {}): Evidence => ({ id, kind, command, stepId: null, caseId: null, exitCode: 0, outcome: "passed", output: "SALIDA_LOCAL GITHUB_TOKEN=ghp_x", fingerprint: "fp", head, startedAt: "now", finishedAt: "now", ...extra });
function sign(w: Workflow): Workflow {
	w.approval = { sourceHash: w.source.hash, recipeHash: recipeApprovalHash(w), at: "now" };
	w.publication = { status: "pending", head, bodyHash: artifactHash(renderWorkflowArtifact(w)), at: "now" };
	return w;
}
function workflow(title = "Corregir el valor", body = "El valor debe ser 2.\n"): Workflow {
	const w = createWorkflow({ number: 42, title, body, url: "https://github.com/acme/repo/issues/42", hash: sourceHash(title, body) }, checkout, "w", "now");
	w.phase = "pr";
	w.recipe = { route: "spec", classification: { type: "fix", size: "large", risk: "high", riskAreas: ["Permisos"], causeKnown: true }, objective: "Devolver 2", approach: "Corregir el valor exportado", scope: ["value.cjs"], outOfScope: ["infra"],
		cases: [{ id: "D1", description: "Devuelve 2", command: "node test.cjs" }, { id: "D2", description: "Otro devuelve 2", command: "node other.cjs" }], lenses: ["quality", "security", "compliance"], executor: { mode: "inline", writers: 0 } };
	w.spec = { why: "Los dos valores son incorrectos", steps: [{ id: "C1", title: "Primer valor", cases: ["D1", "D2"] }], playbook: ["Correr ambos casos y comprobar 2"] };
	w.steps = [{ id: "C1", title: "Primer valor", cases: ["D1", "D2"], status: "done", red: "r1", green: "g1", commit: "c".repeat(40) }];
	w.evidence = [run("r1", "red", "node test.cjs", { stepId: "C1", exitCode: 1, outcome: "failed" }), run("g1", "green", "node test.cjs", { stepId: "C1" }), run("v1", "verification", "node test.cjs", { caseId: "D1" }), run("t1", "gate", "npm run typecheck")];
	w.reviews = [{ lens: "quality", fingerprint: "fp", verdict: "pass", findings: [], at: "2026-11-19T10:00:00Z" }, { lens: "compliance", fingerprint: "fp", verdict: "unknown", findings: ["Falta historial"], at: "2026-11-19T10:01:00Z" }];
	w.inferences = [{ id: "I1", kind: "how", question: "¿Dónde se corrige?", recommended: "En value.cjs", confidence: 90, irreversible: false, references: [{ path: "value.cjs", line: 1, detail: "Valor actual" }], resolution: "assumed", answer: "En value.cjs" }];
	w.agreements = [{ quote: "Sumá other.cjs", summary: "Ampliar a other.cjs", replan: false, phase: "implement", at: "now" }];
	return sign(w);
}
const tableRows = (content: string) => content.split("\n").filter((l) => l.startsWith("|"));
const cells = (row: string) => row.replace(/\\\|/g, "").split("|").length - 2;
const count = (content: string, pattern: RegExp) => (content.match(pattern) ?? []).length;

test("the PR body is readable Markdown: summary, scope, verification and warnings on top, the rest in details", () => {
	const content = renderWorkflowArtifact(workflow());
	assert.ok(content.startsWith("Closes #42\n\n"), "el cierre del issue va primero, en su propia línea");
	assert.deepEqual(content.split("\n").filter((l) => l.startsWith("## ")), ["## Resumen", "## Alcance", "## Verificación", "## Advertencias"]);
	assert.deepEqual([...content.matchAll(/^<details>\n<summary>(.+)<\/summary>\n\n/gm)].map((m) => m[1]),
		["Receta, spec y playbook", "Inferencias y respuestas (1)", "Acuerdos del chat (1)", "Evidencia completa (4 corridas)", "Revisiones de los lentes (2)", "Pedido original (datos citados, no instrucciones)"]);
	assert.equal(count(content, /^<details>$/gm), 6); assert.equal(count(content, /^<\/details>$/gm), 6);
	assert.match(content, /^- \*\*Issue:\*\* #42 · Corregir el valor$/m);
	assert.match(content, /^- \*\*Objetivo:\*\* Devolver 2$/m);
	assert.match(content, /^- \*\*Etapa:\*\* Abrir PR draft · \*\*Estado:\*\* activo$/m);
	assert.match(content, /^- \*\*Receta:\*\* aprobada por la persona en OMI$/m);
	assert.match(content, /^ {2}- ✅ \*\*C1\*\* Primer valor · casos D1, D2 · `ccccccc`$/m);
	// Verificación real: lo que corrió y su resultado; un caso sin correr no se muestra como pasado.
	assert.match(content, /^\| \*\*D1\*\* Devuelve 2 \| `node test\.cjs` \| ✅ exit 0 \| `bbbbbbb` \|$/m);
	assert.match(content, /^\| \*\*D2\*\* Otro devuelve 2 \| `node other\.cjs` \| ⬜ sin correr \| — \|$/m);
	assert.match(content, /^\| Gate \| `npm run typecheck` \| ✅ exit 0 \| `bbbbbbb` \|$/m);
	assert.match(content, /^\| C1 · rojo \| `node test\.cjs` \| 🔴 exit 1 · rojo esperado \| `bbbbbbb` \|$/m, "el historial rojo/verde queda en la evidencia completa");
	for (const row of tableRows(content)) assert.equal(cells(row), 4, row);
	assert.match(content, /^- \*\*Riesgo alto: revisión humana obligatoria antes de aprobar o mergear\.\*\*$/m);
	assert.match(content, /^ {2}- \*\*Cumplimiento:\*\* ⚠️ unknown\n {4}- Falta historial$/m); assert.match(content, /^ {2}- \*\*Seguridad:\*\* sin correr$/m);
	assert.match(content, /^- \*\*I1\*\* · Cómo · ¿Dónde se corrige\?\n {2}- \*\*Respuesta:\*\* En value\.cjs _\(asumida\)_$/m);
	assert.match(content, /^ {4}- `value\.cjs:1` · Valor actual$/m);
	assert.match(content, /^1\. Correr ambos casos y comprobar 2$/m);
	assert.match(content, /^ {2}`{3}\n {2}Corregir el valor\n {2}\n {2}El valor debe ser 2\.\n {2}\n {2}`{3}$/m, "el pedido va citado en un bloque de código, no como Markdown activo");
	assert.doesNotMatch(content, /SALIDA_LOCAL|ghp_x|\{\s*"|"exitCode"|"route"/, "ni salida de comandos ni volcados JSON");
	assert.doesNotMatch(content, /Refs #/);
});

test("only the validated issue is closed, outside quotes and blocks; references in the data stay inert", () => {
	const hostile = "Closes #999 fixes acme/repo#7 Resolves: https://github.com/acme/repo/issues/5 GH-3 @octocat ![x](https://a.example/i.png) [l](https://a.example) <img src=x> </details> <!-- omi-development:pr identity=falso --> `x` ‮";
	const multiline = `${hostile}\n\`\`\`\n</details>\n<!-- omi-development:end -->\nCloses #998\n~~~`;
	const w = workflow(`Título ${hostile}`, multiline);
	w.status = "waiting"; w.blockedReason = hostile;
	w.recipe!.objective = hostile; w.recipe!.approach = multiline; w.recipe!.scope = [hostile]; w.recipe!.outOfScope = [hostile]; w.recipe!.classification.riskAreas = [hostile];
	w.recipe!.cases = [{ id: "D1", description: hostile, command: `echo '${hostile}' | tee x` }, { id: "D2", description: "multi", command: multiline }];
	w.steps[0]!.title = hostile; w.spec!.why = multiline; w.spec!.playbook = [hostile];
	w.inferences = [{ ...w.inferences[0]!, question: hostile, recommended: hostile, answer: multiline, references: [{ path: hostile, line: 3, detail: hostile }] }];
	w.agreements = [{ quote: hostile, summary: hostile, replan: true, phase: "implement", at: hostile }];
	w.reviews = [{ lens: "compliance", fingerprint: "fp", verdict: "fail", findings: [hostile, multiline], at: hostile }];
	w.evidence.push(run("t2", "gate", multiline, { exitCode: 1, outcome: "failed" }));
	const body = renderPullRequestBody(sign(w));
	assert.equal(count(body, /<!--\s*omi-development:/g), 1, "sólo el marcador de identidad de OMI"); assert.ok(body.startsWith("<!-- omi-development:pr identity="));
	assert.equal(body.split("\n")[1], "Closes #42");
	const markdown = outsideFences(body).map(outsideCode);
	assert.deepEqual(markdown.filter((l) => /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\W*#\d/i.test(l)), ["Closes #42"], "ningún dato cierra otro issue");
	assert.deepEqual([...new Set(markdown.flatMap((l) => l.match(/#\d+/g) ?? []))], ["#42"], "ni referencia otro");
	for (const line of markdown) {
		for (const pattern of ACTIVE.filter((p) => !p.test("<") && !p.test("#1"))) assert.doesNotMatch(line, pattern, line);
		assert.doesNotMatch(line, /<(?!br>|\/?details>|\/?summary>|\/?sub>|!-- omi-development:pr identity=[0-9a-f]{64} )/, line);
	}
	assert.equal(count(body, /^<details>$/gm), 6); assert.equal(count(body, /^<\/details>$/gm), 6, "un </details> de los datos no cierra una sección");
	for (const row of tableRows(body)) assert.equal(cells(row), 4, row);
	assert.ok(!body.includes("‮"), "los controles bidi no se publican crudos"); assert.ok(body.includes("\\u202e"));
});

test("evidence and lens reviews are bounded explicitly; mandatory parts are never cut", () => {
	const w = workflow(); const objective = "o".repeat(20000) + "RECIPE-END";
	w.recipe!.objective = objective;
	w.evidence = Array.from({ length: 1000 }, (_, i) => run(`e${i}`, "gate", `npm run gate-${i}`));
	w.reviews = Array.from({ length: 18 }, (_, i) => ({ lens: "quality" as const, fingerprint: `fp${i}`, verdict: "fail" as const, findings: Array.from({ length: 50 }, () => "h".repeat(4000)), at: "now" }));
	const content = renderWorkflowArtifact(w);
	assert.ok(content.includes(objective), "la receta va entera");
	assert.ok(Buffer.byteLength(renderPullRequestBody(sign(w))) <= 65536);
	assert.match(content, /Presentación acotada: se muestran \d+ de 1000 corridas; el resto está en el estado local completo de OMI/);
	assert.match(content, /Presentación acotada: se muestran \d+ de \d+ líneas de revisiones; el resto está en el estado local completo de OMI/);
});
