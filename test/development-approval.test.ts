import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow } from "../src/harness/state.ts";
import type { Workflow } from "../src/harness/model.ts";
import { approvalPreview } from "../src/tui/development-session.ts";
import { approvalDocument, approvalDisplayText } from "../src/tui/development-approval.ts";
import { ApprovalReview, reviewLines } from "../src/tui/development-approval-view.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

function proposal(spec = false): Workflow {
	const state = createWorkflow({ number: 44, title: "Revisar recetas", url: "https://github.com/test/repo/issues/44", body: "Pedido completo", hash: "unused" },
		{ root: "/tmp/repo", commonDir: "/tmp/repo/.git", branch: "improve/issue-44", baseCommit: "base" }, "test", "now");
	state.phase = "approve";
	state.recipe = { classification: { type: "improve", size: spec ? "large" : "small", risk: "high", riskAreas: ["Consentimiento humano"], causeKnown: true },
		objective: "Entender la propuesta antes de autorizar", approach: "Organizar la revisión por secciones", scope: ["Aprobación de recetas"], outOfScope: ["Otros diálogos"],
		cases: [{ id: "D1", description: "Conserva comandos íntegros", command: "printf '%s\\n' 'comando exacto'\n  echo FINAL_COMMAND  " }], lenses: ["quality", "security", "compliance"], executor: { mode: "inline", writers: 0 }, route: spec ? "spec" : "direct" };
	state.steps = [{ id: "C1", title: "Construir revisión", cases: ["D1"], status: "pending", red: null, green: null, commit: null }];
	if (spec) state.spec = { why: "Preservar consentimiento informado", steps: [{ id: "C1", title: "Construir revisión", cases: ["D1"] }], playbook: ["Revisar antes de aprobar"] };
	return state;
}

for (const spec of [false, true]) test(`aprobación: resumen humano antes de comandos, sin serialización interna · spec=${spec}`, () => {
	const state = proposal(spec); const preview = approvalPreview(state);
	assert.match(preview, /Objetivo/);
	assert.ok(preview.indexOf(state.recipe!.objective) < preview.indexOf("printf"), "el objetivo precede la pared de comandos");
	assert.match(preview, spec ? /Con spec/ : /Directa/);
	assert.match(preview, /Riesgo.*alto/i);
	assert.doesNotMatch(preview, /"classification"|"riskAreas"|"sourceHash"/);
	assert.match(preview, /sin volver a preguntar/);
	assert.match(preview, /no autoriza push, merge, workflows ni deploy/i);
	assert.match(preview, /setup/i);
});

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
test("aprobación: conserva todos los campos, respuestas y sentinels sin truncado", () => {
	const state = proposal(true); const recipe = state.recipe!;
	recipe.scope = ["a".repeat(3900), "b".repeat(3900), "FINAL_SCOPE"];
	recipe.executor = { mode: "subagents", writers: 3 };
	state.inferences = [{ id: "I1", kind: "how", question: "Pregunta HOW", recommended: "Recomendada", confidence: 89, irreversible: false,
		references: [{ path: "src/example.ts", line: 17, detail: "Evidencia íntegra" }], resolution: "answered", answer: "Respuesta humana FINAL_ANSWER" },
		{ id: "I2", kind: "what", question: "Pregunta WHAT", recommended: "Otra recomendación", confidence: 92, irreversible: true, references: [], resolution: "assumed", answer: "Suposición explícita" }];
	state.spec!.playbook.push("FINAL_PLAYBOOK");
	const doc = approvalDocument(state); const full = doc.sections.flatMap((s) => s.lines.map((l) => l.text)).join("\n");
	for (const value of [state.source.title, state.source.url, state.source.hash, recipe.objective, recipe.approach, ...recipe.scope, ...recipe.outOfScope, ...recipe.classification.riskAreas,
		...recipe.cases.flatMap((c) => [c.id, c.description, c.command]), state.spec!.why, ...state.spec!.playbook,
		"Construir revisión", "I1", "Pregunta HOW", "Recomendada", "89", "src/example.ts:17", "Evidencia íntegra", "Respuesta humana FINAL_ANSWER", "Pregunta WHAT", "Suposición explícita"])
		assert.ok(full.includes(value), `falta ${value.slice(0, 60)}`);
	assert.match(full, /Subagentes.*3/); assert.match(full, /Calidad/); assert.match(full, /Seguridad/); assert.match(full, /Cumplimiento/);
	assert.match(full, /irreversible.*sí/i); assert.match(full, /respondida/i); assert.match(full, /asumida/i);
	assert.match(full, /Causa conocida.*sí/); assert.doesNotMatch(full, /Presentación acotada/);
	assert.equal(doc.sections[0]?.id, "summary");
});

test("aprobación: preflight conserva límites locales y GitHub antes del sí", () => {
	const oversized = proposal(); oversized.recipe!.scope = Array.from({ length: 15 }, () => "x".repeat(3900));
	assert.throws(() => approvalDocument(oversized), /grande|divid|acotá/i);
	const remoteOversized = proposal(); remoteOversized.source.body = "x".repeat(70000);
	assert.throws(() => approvalDocument(remoteOversized), /GitHub|límite|grande/i);
});

test("aprobación: controles externos son visibles, no ANSI ejecutable ni texto perdido", () => {
	const value = "a\t\x1b[2J\r\u202eZ\\u001b\n  fin  ";
	const displayed = approvalDisplayText(value);
	assert.doesNotMatch(displayed, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
	assert.match(displayed, /\\t/); assert.match(displayed, /\\u001b\[2J/); assert.match(displayed, /\\r/); assert.match(displayed, /\\u202e/);
	assert.match(displayed, /\\\\u001b/); assert.ok(displayed.endsWith("\n  fin  "));
});

test("aprobación: comandos se envuelven sin perder espacios, saltos ni tokens largos", () => {
	const command = `  printf '%s\\n' '漢字🙂${"TOKEN".repeat(100)}'  \n\tFINAL_COMMAND  \n`;
	const lines = reviewLines([{ kind: "command", text: command }], 28);
	assert.ok(lines.every((l) => visibleWidth(l) <= 28));
	// El sufijo ↵ identifica un salto lógico, ↳ sólo indica continuación visual.
	const recovered = lines.map((l) => stripTerminalSequences(l).replace(/^[│↳] /, "").replace(/↵$/, "\n")).join("");
	assert.equal(recovered, approvalDisplayText(command));
	assert.doesNotMatch(recovered, /…/);
});

for (const name of ["dark", "light"] as const) test(`aprobación: geometría, scroll completo, resize y acciones persistentes · ${name}`, () => {
	let rows = 24; let theme = getThemeByName(name)!; let result: boolean | undefined;
	const state = proposal(true); state.recipe!.cases[0]!.command = Array.from({ length: 80 }, (_, i) => `LINE_${i} ${"x".repeat(120)}`).join("\n");
	const document = approvalDocument(state);
	const modal = new ApprovalReview({ document, theme: () => theme, rows: () => rows, redraw() {}, done(value) { result = value; } });
	const fits = (width: number) => {
		const lines = modal.render(width);
		assert.ok(lines.length <= Math.floor(rows * .9), `${width}x${rows}: ${lines.length}`);
		assert.ok(lines.every((l) => visibleWidth(l) <= width));
		assert.match(plain(lines.slice(-4)), /Ctrl\+S.*aprobar.*Esc.*volver/);
		assert.match(plain(lines.slice(-4)), /secciones.*↑↓/);
		return lines;
	};
	const initial = fits(72); assert.match(plain(initial), /Objetivo|Entender la propuesta/); assert.doesNotMatch(plain(initial), /"classification"|[a-f0-9]{64}/);
	modal.handleInput("\r"); assert.equal(result, undefined);
	const commandsIndex = document.sections.findIndex((s) => s.id === "commands");
	for (let i = 0; i < commandsIndex; i++) modal.handleInput("\x1b[C");
	const first = fits(72); assert.match(plain(first), /Pruebas/);
	modal.handleInput("\x1b[F"); const last = fits(72); assert.match(plain(last), /LINE_79/);
	for (const [width, height] of [[132, 40], [72, 24], [99, 32], [36, 16], [132, 40]]) { rows = height!; fits(width!); }
	rows = 24; modal.handleInput("\x1b[H"); assert.equal(plain(fits(72)), plain(first));
	modal.handleInput("\x1b[6~"); assert.notEqual(plain(fits(72)), plain(first));
	modal.handleMouse({ type: "wheel", wheelDelta: 10000 } as never); assert.match(plain(fits(72)), /LINE_79/);
	assert.equal(result, undefined, "revisar y navegar no decide");
	theme = getThemeByName(name === "dark" ? "light" : "dark")!; modal.invalidate(); const changed = fits(72);
	assert.notEqual(changed[0], last[0]);
	modal.handleInput("\x1b"); assert.equal(result, false);
});

test("aprobación: achicar debajo del mínimo suspende el sí aunque antes entrara", () => {
	let decision: boolean | undefined;
	const modal = new ApprovalReview({ document: approvalDocument(proposal()), theme: () => getThemeByName("dark")!, rows: () => 24, redraw() {}, done: (v) => { decision = v; } });
	modal.render(72); modal.render(20); modal.handleInput("\x13"); assert.equal(decision, undefined);
	modal.render(72); modal.handleInput("\x13"); assert.equal(decision, true);
});

test("aprobación: sólo Ctrl+S aprueba, Esc/Ctrl+C/cierre cancelan una sola vez", () => {
	for (const key of ["\x1b", "\x03", "dispose", "\x13"]) {
		const decisions: boolean[] = [];
		const modal = new ApprovalReview({ document: approvalDocument(proposal()), theme: () => getThemeByName("dark")!, rows: () => 24, redraw() {}, done: (v) => decisions.push(v) });
		modal.render(72); modal.handleInput("\r"); assert.deepEqual(decisions, []);
		if (key === "dispose") modal.dispose(); else modal.handleInput(key);
		modal.dispose(); modal.handleInput("\x13");
		assert.deepEqual(decisions, [key === "\x13"], key);
	}
});
