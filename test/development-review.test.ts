import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLensResult, parseSecurityResult, SECURITY_FORMAT } from "../src/tui/development-review.ts";
import { combineLensResults } from "../src/harness/lenses.ts";
import { securityBlockers } from "../src/harness/security-blockers.ts";
import type { Review } from "../src/harness/model.ts";

test("development_lenses un resultado inválido o con hallazgos no puede declararse aprobado", () => {
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":[]}'), { verdict: "pass", findings: [] });
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":["src/a.ts:4: permiso ausente"]}'), { verdict: "fail", findings: ["src/a.ts:4: permiso ausente"] });
	for (const raw of ["no JSON", "{}", '{"verdict":"approved","findings":[]}', '{"verdict":"pass","findings":[],"execute":"rm -rf"}']) assert.throws(() => parseLensResult(raw), /lente|formato/i);
});

test("development_lenses security: cada hallazgo trae su severidad; sin ella, con una inválida o como texto suelto es blocker; las claves de más se ignoran", () => {
	const findings = [{ severity: "aviso", finding: "a" }, { severity: "critical", finding: "b" }, { finding: "c" }, "d", { severity: "aviso", finding: "e", file: "x" }, { severity: "Aviso", finding: "f" }, { severity: 1, finding: "g" }];
	assert.deepEqual(parseSecurityResult(JSON.stringify({ verdict: "fail", findings, summary: "resumen" })), { verdict: "fail", findings: ["a", "b", "c", "d", "e", "f", "g"], severities: ["aviso", "blocker", "blocker", "blocker", "aviso", "blocker", "blocker"], downgradable: [false, false, false, false, false, false, false] });
	assert.deepEqual(parseSecurityResult('```json\n{"verdict":"pass","findings":[{"severity":"aviso","finding":"a.ts:1 · log"}]}\n```'), { verdict: "fail", findings: ["a.ts:1 · log"], severities: ["aviso"], downgradable: [false] }, "con algún hallazgo no hay pass, aunque sea aviso");
	assert.deepEqual(parseSecurityResult('{"verdict":"pass","findings":[]}'), { verdict: "pass", findings: [], severities: [], downgradable: [] });
	for (const raw of ['{"verdict":"fail","findings":[{"severity":"aviso"}]}', '{"verdict":"fail","findings":[{"severity":"aviso","finding":""}]}', '{"verdict":"ok","findings":[]}', '{"verdict":"fail"}']) assert.throws(() => parseSecurityResult(raw), /formato/, raw);
	assert.throws(() => parseSecurityResult("no JSON"), /JSON/);
	assert.throws(() => parseLensResult('{"verdict":"fail","findings":[{"severity":"aviso","finding":"a"}]}'), /formato/, "los demás lentes siguen rechazando hallazgos objeto");
});

test("development_lenses security: la clase sólo permite bajar con otro exacto y el prompt la pide", () => {
	const findings = [{ severity: "blocker", clase: "otro", finding: "a" }, { severity: "blocker", clase: "secreto", finding: "b" }, { severity: "blocker", finding: "c" }, { severity: "blocker", clase: "Otro", finding: "d" }];
	assert.deepEqual(parseSecurityResult(JSON.stringify({ verdict: "fail", findings })).downgradable, [true, false, false, false]);
	assert.deepEqual(parseSecurityResult(JSON.stringify({ verdict: "fail", findings: ["e", { severity: "aviso", clase: ["otro"], finding: "f" }, { severity: "blocker", clase: "exfiltración", finding: "g" }] })).downgradable, [false, false, false], "un texto suelto, una clase que no es texto o exfiltración no bajan");
	assert.match(SECURITY_FORMAT, /"clase":"secreto\|exfiltración\|otro"/);
	assert.match(SECURITY_FORMAT, /exfiltración si manda código o datos a un destino que nadie autorizó/);
});

// Review del incidente (2026-11-26): un unknown con un hallazgo marcado blocker, incluso un secreto, no frenaba nada: con
// una parte no bloqueaba verified y con varias combineSecurity lo bajaba a aviso. En main, fail + unknown daba fail.
test("development_lenses security: un unknown con un hallazgo marcado blocker es fail, con una parte y con varias; un texto suelto o un aviso en un unknown siguen siendo unknown", () => {
	const secret = { severity: "blocker", clase: "secreto", finding: "src/a.ts:1 · imprime el token" };
	const one = parseSecurityResult(JSON.stringify({ verdict: "unknown", findings: [secret, { severity: "aviso", finding: "src/a.ts:2 · falta el módulo de rutas" }] }));
	assert.deepEqual(one, { verdict: "fail", findings: ["src/a.ts:1 · imprime el token", "src/a.ts:2 · falta el módulo de rutas"], severities: ["blocker", "aviso"], downgradable: [false, false], unjudged: true });
	const review = (r: { verdict: Review["verdict"]; findings: string[]; severities?: Review["severities"] }): Review => ({ lens: "security", fingerprint: "tree", at: "now", verdict: r.verdict, findings: r.findings, ...(r.severities ? { severities: r.severities } : {}) });
	assert.deepEqual(securityBlockers(review(one)), ["src/a.ts:1 · imprime el token"], "con una parte, bloquea verified");
	const first = parseSecurityResult(JSON.stringify({ verdict: "fail", findings: [{ severity: "aviso", finding: "src/b.ts:1 · el log crece" }] }));
	const combined = combineLensResults([first, parseSecurityResult(JSON.stringify({ verdict: "unknown", findings: [secret] }))], true);
	assert.deepEqual(securityBlockers(review(combined)), ["parte 2/2 · src/a.ts:1 · imprime el token"], "con varias partes, el blocker sigue siendo blocker");
	// #89: lo que el lente no pudo juzgar avisa. Sólo un severity blocker explícito lo vuelve fail.
	assert.equal(parseSecurityResult(JSON.stringify({ verdict: "unknown", findings: ["src/a.ts:1 · falta el módulo", { severity: "aviso", finding: "x" }, { finding: "y" }, { severity: "critical", finding: "z" }] })).verdict, "unknown");
});
