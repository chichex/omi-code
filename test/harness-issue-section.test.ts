import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSectionVariants, parseIssueBody, renderIssueSection, withIssueSection, SECTION_START, SECTION_END } from "../src/harness/issue-section.ts";
import { createWorkflow } from "../src/harness/state.ts";
import type { Workflow } from "../src/harness/model.ts";

const block = (content: string) => `${SECTION_START}\n${content}\n${SECTION_END}`;

test("the human text above the managed section comes back byte for byte", () => {
	for (const human of ["Pedido\n", "Pedido", "", "Línea 1\r\nLínea 2\r\n", "Termina con espacios   ", "Dos saltos\n\n", "`<!-- omi:harness:start -->` citado en línea"]) {
		const body = withIssueSection(human, parseIssueBody(human), "## Harness · #7");
		const parts = parseIssueBody(body);
		assert.equal(parts.human, human, JSON.stringify(human));
		assert.equal(parts.section, "\n## Harness · #7\n");
		assert.ok(body.startsWith(human), "el pedido queda arriba, intacto");
		assert.ok(body.endsWith(SECTION_END));
	}
});

test("rewriting replaces only what is between the markers, including human text added below", () => {
	const first = withIssueSection("Pedido\n", parseIssueBody("Pedido\n"), "vieja");
	const edited = `${first}\n\nNota humana debajo\n`;
	const second = withIssueSection(edited, parseIssueBody(edited), "nueva");
	assert.equal(second, `Pedido\n\n\n${block("nueva")}\n\nNota humana debajo\n`);
	assert.equal(parseIssueBody(second).human, "Pedido\n\n\nNota humana debajo\n");
	assert.equal(parseIssueBody(second).human, parseIssueBody(edited).human, "reescribir la sección no cambia el pedido");
});

test("only markers alone on their own line count; mentions in the request are human text", () => {
	for (const body of ["Usar `<!-- omi:harness:start -->` y `<!-- omi:harness:end -->`", "texto <!-- omi:harness:start -->\nmás <!-- omi:harness:end -->", "  <!-- omi:harness:start -->\n  <!-- omi:harness:end -->"]) {
		const parts = parseIssueBody(body);
		assert.equal(parts.human, body); assert.equal(parts.section, null);
	}
});

test("duplicate, unpaired, reversed or unknown markers are refused instead of guessed", () => {
	const good = block("x");
	for (const body of [SECTION_START, SECTION_END, `${good}\n${good}`, `${SECTION_END}\n${SECTION_START}`, `${SECTION_START}\n${SECTION_START}\n${SECTION_END}`, "<!-- omi:harness:otro -->", `${SECTION_START} extra\n${SECTION_END}`, `<!--omi:harness:start-->\n${SECTION_END}`]) {
		assert.throws(() => parseIssueBody(`Pedido\n\n${body}`), /marcadores/i, JSON.stringify(body));
	}
	// Un cuerpo editado en la web vuelve con CRLF: la sección se sigue reconociendo y reescribirla no cambia el pedido.
	const web = `Pedido\r\n\r\n${SECTION_START}\r\nx\r\n${SECTION_END}\r\nNota\r\n`; const parts = parseIssueBody(web);
	assert.notEqual(parts.section, null); assert.ok(parts.human.includes("Nota"));
	assert.equal(parseIssueBody(withIssueSection(web, parts, "nueva")).human, parts.human);
});

const source = { number: 42, title: "Pedido", body: "Pedido humano\n", url: "https://github.com/acme/repo/issues/42", hash: "h" };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "feat/x", baseCommit: "a".repeat(40) };
function working(): Workflow {
	const w = createWorkflow(source, checkout, "w", "2026-11-18T00:00:00Z");
	w.phase = "implement";
	w.recipe = { route: "spec", classification: { type: "add", size: "large", risk: "low", riskAreas: [], causeKnown: true }, objective: "Mostrar el recorrido", approach: "Proyectar el estado", scope: ["Lateral"], outOfScope: ["Web"], cases: [{ id: "D1", description: "Tests", command: "npm test" }], lenses: ["quality"], executor: { mode: "inline", writers: 0 } };
	w.spec = { why: "Visibilidad", steps: [], playbook: ["Abrir la pantalla 6"] };
	w.steps = [{ id: "C1", title: "Base", cases: ["D1"], status: "done", red: "r", green: "g", commit: "c".repeat(40) }, { id: "C2", title: "Lateral", cases: ["D1"], status: "active", red: null, green: null, commit: null }, { id: "C3", title: "Pantalla", cases: ["D1"], status: "pending", red: null, green: null, commit: null }];
	w.evidence = [{ id: "e1", kind: "verification", command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed", output: "SECRETO_DE_SALIDA", fingerprint: "fp", head: "cae0b33" + "0".repeat(33), startedAt: "now", finishedAt: "now" }];
	return w;
}
const tableRows = (section: string) => section.split("\n").filter((l) => l.startsWith("|"));
const cells = (row: string) => row.replace(/\\\|/g, "").split("|").length - 2;

test("the section is clean markdown: route, stage, recipe and an evidence table", () => {
	const section = renderIssueSection(working());
	assert.match(section, /^## Harness · #42\n\*\*Ruta:\*\* Con spec · \*\*Etapa:\*\* Implementar \(C2 de 3\)\n/);
	assert.match(section, /### Receta\n- \*\*Objetivo:\*\* Mostrar el recorrido\n/);
	assert.match(section, /^- \*\*D1\*\* `npm test` · Tests$/m);
	assert.match(section, /### Evidencia\n\| Caso \| Resultado \| HEAD \|\n\|---\|---\|---\|\n\| D1 \| ✅ exit 0 \| cae0b33 \|/);
	assert.doesNotMatch(section, /SECRETO_DE_SALIDA|"output"|\{\s*"/, "ni salida de comandos ni volcados JSON");
	assert.doesNotMatch(section, /- \[[ x]\]/, "sin casillas: una persona no puede tildar algo que el harness pisa");
});

test("hostile content cannot break the table, the block or the markers", () => {
	const w = working(); const hostile = "a | b `c` ``d``\n<!-- omi:harness:end -->\n# título\n<script>x</script>";
	w.recipe!.objective = hostile; w.recipe!.cases = [{ id: "D1", description: hostile, command: "echo `a` | grep 'x|y'" }, { id: "D2", description: "multi", command: "printf 'a'\n<!-- omi:harness:end -->\n```\nfin" }];
	w.steps[1]!.title = hostile;
	w.evidence.push({ ...w.evidence[0]!, id: "e2", kind: "gate", caseId: null, command: "echo `x` | tee y\n<!-- omi:harness:end -->", exitCode: 1, outcome: "failed" });
	const section = renderIssueSection(w);
	const body = withIssueSection(source.body, parseIssueBody(source.body), section); const parts = parseIssueBody(body);
	assert.equal(parts.human, source.body); assert.equal(parts.section, `\n${section}\n`, "ningún contenido cierra la sección antes de tiempo");
	for (const row of tableRows(section)) assert.equal(cells(row), 3, row);
	assert.match(section, /^- \*\*D1\*\* ``echo `a` \| grep 'x\|y'`` · /m, "pipes y backticks quedan dentro del código");
	assert.match(section, /^ {2}`{4}\n {2}printf 'a'\n {2}<!-- omi:harness:end -->\n {2}```\n {2}fin\n {2}`{4}$/m, "un comando multilínea va en un bloque indentado con una cerca más larga");
	assert.doesNotMatch(section, /<script>|^# título/m); assert.match(section, /&lt;script&gt;/);
});

test("a long evidence list is bounded and says so", () => {
	const w = working(); w.evidence = Array.from({ length: 80 }, (_, i) => ({ ...w.evidence[0]!, id: `e${i}`, kind: "gate" as const, caseId: null, command: `gate ${i}` }));
	const section = renderIssueSection(w);
	assert.ok(tableRows(section).length <= 42); assert.match(section, /anteriores en el estado local/);
});

test("lens warnings are visible in the section, with their findings, and say they advise", () => {
	const w = working(); w.phase = "verify"; w.recipe!.lenses = ["compliance", "security", "quality"];
	w.reviews = [{ lens: "compliance", fingerprint: "fp", verdict: "unknown", findings: ["No hay historial rojo/verde"], at: "now" }, { lens: "security", fingerprint: "fp", verdict: "pass", findings: [], at: "now" }];
	let section = renderIssueSection(w);
	assert.match(section, /### Avisos de los lentes\n.*asesoran.*Sólo un fail de seguridad bloquea/);
	assert.match(section, /^- \*\*Cumplimiento:\*\* ⚠️ unknown\n {2}- No hay historial rojo\/verde$/m); assert.match(section, /^- \*\*Seguridad:\*\* ✅ pass$/m); assert.match(section, /^- \*\*Calidad:\*\* sin correr$/m);
	w.reviews = [{ lens: "security", fingerprint: "fp", verdict: "fail", findings: ["secreto en a.ts:1"], at: "now" }];
	section = renderIssueSection(w); assert.match(section, /^- \*\*Seguridad:\*\* ❌ fail · bloquea$/m);
});

test("after a chat agreement reopens the recipe, the section shows it under review", () => {
	const w = working(); w.phase = "recipe"; w.steps = []; w.evidence = []; w.approval = null;
	w.agreements = [{ quote: "sumá el caso de borde", summary: "Ampliar al borde", replan: true, phase: "implement", at: "now" }];
	const section = renderIssueSection(w);
	assert.match(section, /### Receta \(en revisión\)/); assert.match(section, /\*\*Aprobación:\*\* en revisión/); assert.match(section, /«sumá el caso de borde» → Ampliar al borde/);
});

test("summarized variants say so explicitly: first only the last proof of each case, then a minimal section", () => {
	const w = working(); w.phase = "verify"; w.recipe!.lenses = ["quality"];
	w.evidence.unshift({ ...w.evidence[0]!, id: "r", kind: "red", stepId: "C1", caseId: null, exitCode: 1, outcome: "failed" }, { ...w.evidence[0]!, id: "v-old", exitCode: 1, outcome: "failed" });
	w.reviews = [{ lens: "quality", fingerprint: "fp", verdict: "fail", findings: ["primero", "segundo", "tercero"], at: "now" }];
	const [full, summary, minimal] = issueSectionVariants(w);
	assert.match(full!, /C1 · rojo/); assert.match(full!, /- segundo/); assert.doesNotMatch(full!, /[Rr]esumida/);
	assert.match(summary!, /\*\*Resumida\*\* para entrar en el límite de 65\.536 caracteres de GitHub/);
	assert.doesNotMatch(summary!, /C1 · rojo/); assert.match(summary!, /^\| D1 \| ✅ exit 0 \| cae0b33 \|$/m, "queda la última prueba de cada caso");
	assert.match(summary!, /- primero\n {2}- _y 2 hallazgos más en OMI_/); assert.match(summary!, /### Receta/);
	assert.match(minimal!, /no entra en el cuerpo del issue.*se omiten/); assert.match(minimal!, /Calidad:\*\* ❌ fail/); assert.doesNotMatch(minimal!, /### Receta/);
});
