import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLensResult, parseSecurityResult } from "../src/tui/development-review.ts";

test("development_lenses un resultado inválido o con hallazgos no puede declararse aprobado", () => {
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":[]}'), { verdict: "pass", findings: [] });
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":["src/a.ts:4: permiso ausente"]}'), { verdict: "fail", findings: ["src/a.ts:4: permiso ausente"] });
	for (const raw of ["no JSON", "{}", '{"verdict":"approved","findings":[]}', '{"verdict":"pass","findings":[],"execute":"rm -rf"}']) assert.throws(() => parseLensResult(raw), /lente|formato/i);
});

test("development_lenses security: cada hallazgo trae su severidad; sin ella, con una inválida o como texto suelto es blocker; las claves de más se ignoran", () => {
	const findings = [{ severity: "aviso", finding: "a" }, { severity: "critical", finding: "b" }, { finding: "c" }, "d", { severity: "aviso", finding: "e", file: "x" }, { severity: "Aviso", finding: "f" }, { severity: 1, finding: "g" }];
	assert.deepEqual(parseSecurityResult(JSON.stringify({ verdict: "fail", findings, summary: "resumen" })), { verdict: "fail", findings: ["a", "b", "c", "d", "e", "f", "g"], severities: ["aviso", "blocker", "blocker", "blocker", "aviso", "blocker", "blocker"] });
	assert.deepEqual(parseSecurityResult('```json\n{"verdict":"pass","findings":[{"severity":"aviso","finding":"a.ts:1 · log"}]}\n```'), { verdict: "fail", findings: ["a.ts:1 · log"], severities: ["aviso"] }, "con algún hallazgo no hay pass, aunque sea aviso");
	assert.deepEqual(parseSecurityResult('{"verdict":"pass","findings":[]}'), { verdict: "pass", findings: [], severities: [] });
	for (const raw of ['{"verdict":"fail","findings":[{"severity":"aviso"}]}', '{"verdict":"fail","findings":[{"severity":"aviso","finding":""}]}', '{"verdict":"ok","findings":[]}', '{"verdict":"fail"}']) assert.throws(() => parseSecurityResult(raw), /formato/, raw);
	assert.throws(() => parseSecurityResult("no JSON"), /JSON/);
	assert.throws(() => parseLensResult('{"verdict":"fail","findings":[{"severity":"aviso","finding":"a"}]}'), /formato/, "los demás lentes siguen rechazando hallazgos objeto");
});
