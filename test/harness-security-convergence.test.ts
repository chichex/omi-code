// Convergencia de security: desde la segunda revisión del pedido, el host compara con la anterior y baja a aviso un
// blocker nuevo de clase otro en un archivo sin cambios. Falla cerrado: si no puede comparar, no baja nada.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runner } from "../src/core/exec.ts";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { FAIL_WITHOUT_FINDINGS, securityBlocks } from "../src/harness/security-blockers.ts";
import { convergeSecurity, findingFile, previousMaterial, reviewedCommit, SECURITY_DOWNGRADED, securityBaseline, securityComparison, type SecurityComparison } from "../src/harness/security-convergence.ts";
import { parseSecurityResult } from "../src/tui/development-review.ts";
import { sourceHash, type Evidence, type Exploration, type Lens, type Plan, type Review, type Workflow } from "../src/harness/model.ts";

const at = "2026-01-01T00:00:00Z";
const sha = (c: string) => c.repeat(40);
const source = { number: 7, title: "Change", body: "Details", url: "https://github.com/acme/repo/issues/7", hash: sourceHash("Change", "Details") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: sha("0") };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" };
const plan: Plan = { classification: { type: "add", size: "small", risk: "high", riskAreas: [], causeKnown: true }, objective: "change", approach: "extend", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: ["security"], executor: { mode: "inline", writers: 1 } };
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
let ids = 0;
function evidence(kind: Evidence["kind"], fingerprint: string, changes: Partial<Evidence> = {}): Evidence {
	const failed = kind === "red";
	return { id: `${kind}-${ids++}`, kind, command: "npm test", stepId: null, caseId: kind === "gate" ? null : "D1", exitCode: failed ? 1 : 0, outcome: failed ? "failed" : "passed", output: "out", fingerprint, head: fingerprint, startedAt: at, finishedAt: at, ...changes };
}
const review = (lens: Lens, fingerprint: string, verdict: Review["verdict"] = "pass", findings: string[] = [], extra: Partial<Review> = {}): Review => ({ lens, fingerprint, verdict, findings, at, ...extra });
// Un paso C con rojo, verde y commit: su verde acredita `fingerprint` y su commit es `commit`.
function implement(s: Workflow, id: string, fingerprint: string, commit: string): Workflow {
	s = send(s, { type: "step_started", id });
	s = send(s, { type: "evidence", evidence: evidence("red", fingerprint, { stepId: id }) });
	s = send(s, { type: "evidence", evidence: evidence("green", fingerprint, { stepId: id }) });
	s = send(s, { type: "step_completed", id, commit, fingerprint });
	return send(s, { type: "evidence", evidence: evidence("verification", fingerprint) });
}
function approved(): Workflow {
	const s = send(createWorkflow(source, checkout, "workflow", at), { type: "explored", exploration });
	return send(send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan }), { type: "approved" });
}
/** Security falló sobre tree1 (commit 1) con `findings`; retry; C2 acredita tree2 (commit 2). */
function afterRetry(findings: string[], extra: Partial<Review> = {}): Workflow {
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", findings, extra) });
	s = send(s, { type: "retry", reason: "Cerrar el permiso" });
	return implement(s, "C2", "tree2", sha("2"));
}
// Git falso: responde el diff y el árbol pedidos, o falla con `code` (128: no encuentra el commit).
function git(answers: { diff?: string[]; tree?: string[]; code?: number } = {}) {
	const calls: string[][] = [];
	const runner: Runner = { async run(_command, args) {
		const sub = args.slice(4); calls.push(sub);
		if (answers.code) return { code: answers.code, stdout: "", stderr: "fatal: bad object" };
		const list = sub[0] === "ls-tree" ? answers.tree ?? [] : answers.diff ?? [];
		return { code: 0, stdout: list.map((p) => `${p}\0`).join(""), stderr: "" };
	} };
	return { runner, calls };
}
const TREE = ["src/a.ts", "src/b.ts", "src/c.ts"];
// Base: un blocker en src/a.ts; desde entonces sólo cambió src/b.ts.
const comparison = (changes: Partial<SecurityComparison> = {}): SecurityComparison => ({ baseline: review("security", "tree1", "fail", ["src/a.ts:1 · permiso abierto"]), changed: new Set(["src/b.ts"]), tree: new Set(TREE), blockerFiles: new Set(["src/a.ts"]), ...changes });
const security = (findings: unknown[]) => parseSecurityResult(JSON.stringify({ verdict: "fail", findings }));
const blocker = (finding: string, clase?: unknown) => ({ severity: "blocker", ...(clase === undefined ? {} : { clase }), finding });
const asReview = (r: { verdict: Review["verdict"]; findings: string[]; severities?: Review["severities"] }): Review => ({ lens: "security", fingerprint: "tree2", verdict: r.verdict, findings: r.findings, ...(r.severities ? { severities: r.severities } : {}), at });

test("security_convergence findingFile toma el archivo del primer tramo archivo:línea, con prefijo de parte, backticks o ./, y null si no hay", () => {
	assert.equal(findingFile("src/a.ts:12 · permiso"), "src/a.ts");
	assert.equal(findingFile("src/a.ts:12: permiso ausente"), "src/a.ts");
	assert.equal(findingFile("parte 1/2 · src/harness/metrics-store.ts:41–42,76–78 · La validación de directorios usa la ruta por separado"), "src/harness/metrics-store.ts");
	assert.equal(findingFile("`src/a.ts:3` · permiso"), "src/a.ts");
	assert.equal(findingFile('"src/a.ts:3" · permiso'), "src/a.ts");
	assert.equal(findingFile("./src/a.ts:3 · permiso"), "src/a.ts");
	assert.equal(findingFile(`${SECURITY_DOWNGRADED} · parte 2/2 · test/x.test.ts:197 · rojo`), "test/x.test.ts");
	assert.equal(findingFile("permiso abierto en src/a.ts:3"), null, "el archivo tiene que abrir un tramo");
	assert.equal(findingFile("src/a.ts · sin línea"), null);
	assert.equal(findingFile(FAIL_WITHOUT_FINDINGS), null);
});

test("security_convergence un blocker nuevo de clase otro en un archivo sin cambios desde la revisión anterior baja a aviso y lo dice", () => {
	const { result, downgraded } = convergeSecurity(security([blocker("src/c.ts:4 · el directorio queda con 0755", "otro"), { severity: "aviso", clase: "otro", finding: "src/c.ts:5 · el log crece" }]), comparison());
	assert.equal(downgraded, 1, "sólo cuenta los blockers bajados");
	assert.equal(result.verdict, "fail", "el veredicto no cambia");
	assert.deepEqual(result.findings, [`${SECURITY_DOWNGRADED} · src/c.ts:4 · el directorio queda con 0755`, "src/c.ts:5 · el log crece"]);
	assert.deepEqual(result.severities, ["aviso", "aviso"]);
	assert.equal(securityBlocks(asReview(result)), false);
});

test("security_convergence sólo baja la clase otro: secreto, exfiltración, sin clase o una clase inválida nunca bajan", () => {
	const kept = [
		blocker("src/c.ts:1 · deja la configuración en el log", "secreto"),
		blocker("src/c.ts:2 · un valor de la KB elige a qué servidor se manda el diff", "exfiltración"),
		blocker("src/c.ts:3 · permiso abierto"),
		blocker("src/c.ts:4 · permiso abierto", "Otro"),
		blocker("src/c.ts:5 · permiso abierto", "cualquiera"),
		blocker("src/c.ts:6 · permiso abierto", ["otro"]),
		"src/c.ts:7 · texto suelto",
	];
	const { result, downgraded } = convergeSecurity(security([...kept, blocker("src/c.ts:8 · permiso abierto", "otro")]), comparison());
	assert.equal(downgraded, 1, "el control de clase otro sí baja: la comparación está activa");
	assert.deepEqual(result.severities, [...kept.map(() => "blocker"), "aviso"]);
	assert.deepEqual(result.findings.slice(0, kept.length), kept.map((k) => typeof k === "string" ? k : k.finding), "lo que se mantiene no cambia de texto");
	assert.equal(securityBlocks(asReview(result)), true);
});

test("security_convergence un secreto nombrado en el texto no baja aunque la clase diga otro", () => {
	const phrases = ["imprime CLAUDE_CODE_OAUTH_TOKEN", "manda ANTHROPIC_API_KEY", "expone el Bearer", "copia auth.json", "tokens en el log"];
	const { result, downgraded } = convergeSecurity(security([...phrases.map((p, i) => blocker(`src/c.ts:${i + 1} · ${p}`, "otro")), blocker("src/c.ts:9 · el directorio queda abierto", "otro")]), comparison());
	assert.equal(downgraded, 1);
	assert.deepEqual(result.severities, [...phrases.map(() => "blocker"), "aviso"]);
});

test("security_convergence se mantiene el blocker en un archivo cambiado (a) o en el archivo de un blocker anterior (b)", () => {
	const { result, downgraded } = convergeSecurity(security([blocker("src/b.ts:1 · permiso nuevo", "otro"), blocker("`src/a.ts:9` · el permiso sigue abierto", "otro"), blocker("src/c.ts:1 · permiso abierto", "otro")]), comparison());
	assert.equal(downgraded, 1);
	assert.deepEqual(result.severities, ["blocker", "blocker", "aviso"]);
	assert.deepEqual(result.findings.slice(0, 2), ["src/b.ts:1 · permiso nuevo", "`src/a.ts:9` · el permiso sigue abierto"]);
});

test("security_convergence un blocker que una persona aceptó en la base sigue contando para la regla (b): repetido en su archivo sin cambios, vuelve a bloquear", async () => {
	const accepted = "src/a.ts:1 · permiso abierto";
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [accepted]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [accepted], reason: "Preexistente en main" });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Arreglar el gate", fingerprint: "tree1" });
	s = implement(s, "C2", "tree2", sha("2"));
	assert.deepEqual(s.version === 2 ? s.acceptedRisks?.map((a) => a.fingerprint) : [], ["tree1"], "la aceptación es de la base");
	const { runner } = git({ diff: ["src/b.ts"], tree: TREE });
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, runner);
	assert.ok(c, "hay comparación");
	assert.deepEqual([...c.blockerFiles], ["src/a.ts"]);
	assert.deepEqual(previousMaterial(c).findings, [{ blocker: true, text: accepted }]);
	const { result, downgraded } = convergeSecurity(security([blocker(accepted, "otro"), blocker("src/c.ts:1 · permiso abierto", "otro")]), c);
	assert.equal(downgraded, 1);
	assert.deepEqual(result.severities, ["blocker", "aviso"], "lo aceptado no pasa a otro contenido");
});

test("security_convergence falla cerrado: sin archivo, con un path que no está en HEAD, con un blocker anterior sin archivo o si Git no encuentra el commit anterior, no baja nada", async () => {
	const { result, downgraded } = convergeSecurity(security([blocker("permiso abierto en el directorio", "otro"), blocker("src/zzz.ts:1 · permiso abierto", "otro"), blocker("src/c.ts:1 · permiso abierto", "otro")]), comparison());
	assert.equal(downgraded, 1, "sólo el control con archivo en HEAD");
	assert.deepEqual(result.severities, ["blocker", "blocker", "aviso"]);
	const none = "sin comparación con la revisión anterior: no se baja ningún blocker";
	for (const [name, state] of [["un blocker anterior sin archivo", afterRetry(["src/a.ts:1 · permiso abierto", "permiso abierto en el directorio"])], ["un fail anterior sin hallazgos", afterRetry([])]] as const) {
		const stub = git({ diff: ["src/b.ts"], tree: TREE });
		const out = await securityComparison(state, { fingerprint: "tree2", head: sha("2") }, stub.runner);
		assert.equal(out.comparison, undefined, name); assert.match(out.note ?? "", /no se baja ningún blocker/, name);
		assert.deepEqual(stub.calls, [], `${name}: ni siquiera consulta Git`);
	}
	const missing = git({ code: 128 });
	assert.deepEqual(await securityComparison(afterRetry(["src/a.ts:1 · permiso abierto"]), { fingerprint: "tree2", head: sha("2") }, missing.runner), { note: none });
	assert.equal(missing.calls.length, 1, "Git falló al primer pedido");
	// Un contenido que ningún paso acreditó no tiene commit para comparar.
	let ghost = implement(approved(), "C1", "tree1", sha("1"));
	ghost = send(ghost, { type: "reviewed", review: review("security", "ghost", "fail", ["src/a.ts:1 · permiso abierto"]) });
	const unused = git({ diff: [], tree: TREE });
	assert.deepEqual(await securityComparison(ghost, { fingerprint: "tree1", head: sha("1") }, unused.runner), { note: none });
	assert.deepEqual(unused.calls, []);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(securityComparison(afterRetry(["src/a.ts:1 · permiso abierto"]), { fingerprint: "tree2", head: sha("2") }, git({ diff: [], tree: TREE }).runner, aborted.signal), { name: "AbortError" }, "una cancelación no se vuelve una nota");
});

// Review del incidente (2026-11-26, bypass-1): una revisión con una parte sin juicio no revisó todo el cambio. Si fuera la
// base, un blocker nuevo en un archivo de esa parte bajaría a aviso sin que nadie lo hubiera mirado.
test("security_convergence una base parcial (alguna parte sin juicio) no compara: no consulta Git y no baja nada", async () => {
	const partial = afterRetry(["parte 1/2 · src/a.ts:1 · permiso abierto", "parte 2/2 · Sin resultado del lente: conexión (3 intentos)"], { severities: ["blocker", "aviso"], partial: true });
	assert.equal(securityBaseline(partial)?.partial, true, "sigue siendo la última review con veredicto");
	const stub = git({ diff: ["src/b.ts"], tree: TREE });
	const out = await securityComparison(partial, { fingerprint: "tree2", head: sha("2") }, stub.runner);
	assert.equal(out.comparison, undefined);
	assert.equal(out.note, "sin comparación con la revisión anterior: no revisó todas las partes del cambio; no se baja ningún blocker");
	assert.deepEqual(stub.calls, [], "ni siquiera consulta Git");
	const complete = afterRetry(["parte 1/2 · src/a.ts:1 · permiso abierto", "parte 2/2 · src/c.ts:2 · el log crece"], { severities: ["blocker", "aviso"] });
	assert.ok((await securityComparison(complete, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree: TREE }).runner)).comparison, "el control completo sí compara");
});

test("security_convergence la base es la última review de security con veredicto de este pedido, también la archivada por retry, y su commit sale del paso cuyo verde acreditó ese contenido", async () => {
	// La forma de 98.json: un fail legacy sin severidades, por partes.
	const legacy = [
		"parte 1/2 · src/harness/metrics-store.ts:40–47 · La validación de privacidad sólo comprueba UID y bits POSIX.",
		"parte 1/2 · src/harness/metrics-store.ts:57–69 · El mismo `hostname` no garantiza que dos procesos compartan el espacio de PID.",
		"parte 2/2 · test/workspace-triage-runtime.test.ts:197 · El gate `npm test` del HEAD revisado terminó con código 1.",
	];
	let s = afterRetry(legacy);
	s = send(s, { type: "reviewed", review: review("security", "tree2", "unknown", ["Falta el módulo que valida la ruta"]) });
	s = send(s, { type: "reviewed", review: review("security", "tree2", "unknown", ["Sin resultado del lente: conexión (3 intentos)"], { noResult: true }) });
	const foreign = { sourceHash: "otro-pedido", round: 0, reason: "Cambió el pedido", at, evidence: [], reviews: [review("security", "foreign", "fail", ["src/z.ts:1 · ajeno"])] };
	s = { ...s, attempts: [...(s.attempts ?? []), foreign] };
	const base = securityBaseline(s);
	assert.deepEqual(base, s.attempts?.[0]?.reviews.find((r) => r.lens === "security"), "la archivada por retry, no la de otro pedido ni un unknown");
	assert.equal(reviewedCommit(s, "tree1"), sha("1"), "el verde de C1 quedó archivado y acredita tree1");
	assert.equal(reviewedCommit(s, "tree2"), sha("2"));
	assert.equal(reviewedCommit(s, "ghost"), undefined);
	const stub = git({ diff: ["src/tui/b.ts", "src/harness/metrics-store.ts"], tree: ["src/harness/metrics-store.ts", "src/tui/b.ts", "test/workspace-triage-runtime.test.ts"] });
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, stub.runner);
	assert.ok(c);
	assert.deepEqual(stub.calls, [["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--color=never", "--name-only", "-z", sha("1"), sha("2"), "--"], ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha("2")]]);
	assert.deepEqual([...c.blockerFiles].sort(), ["src/harness/metrics-store.ts", "test/workspace-triage-runtime.test.ts"], "sin severidades, cada hallazgo es blocker");
	assert.deepEqual(previousMaterial(c), { fingerprint: "tree1", verdict: "fail", findings: legacy.map((text) => ({ blocker: true, text })), changedFiles: ["src/harness/metrics-store.ts", "src/tui/b.ts"] });
});

test("security_convergence sobre el mismo contenido no hay archivos cambiados: no se pide el diff, sólo el árbol de HEAD", async () => {
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", ["src/a.ts:1 · permiso abierto"], { severities: ["aviso"] }) });
	const stub = git({ diff: ["src/a.ts"], tree: TREE });
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree1", head: sha("1") }, stub.runner);
	assert.ok(c);
	assert.deepEqual(stub.calls, [["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha("1")]]);
	assert.deepEqual([...c.changed], []); assert.deepEqual([...c.blockerFiles], [], "un aviso anterior no cuenta para la regla (b)");
});

test("security_convergence previous acota lo que manda: hasta 10 hallazgos con los blockers primero, 500 caracteres por hallazgo y 200 archivos, y cuenta lo omitido", () => {
	const findings = [...Array.from({ length: 8 }, (_, i) => `src/a.ts:${i + 1} · aviso ${i}`), ...Array.from({ length: 4 }, (_, i) => `src/b.ts:${i + 1} · blocker ${i} ${"x".repeat(600)}`)];
	const baseline = review("security", "tree1", "fail", findings, { severities: [...findings.slice(0, 8).map(() => "aviso" as const), ...findings.slice(8).map(() => "blocker" as const)] });
	const changed = new Set(Array.from({ length: 205 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`).reverse());
	const material = previousMaterial({ baseline, changed, tree: new Set(), blockerFiles: new Set(["src/b.ts"]) });
	assert.equal(material.findings.length, 10); assert.equal(material.findingsOmitted, 2);
	assert.deepEqual(material.findings.map((f) => f.blocker), [true, true, true, true, false, false, false, false, false, false]);
	assert.ok(material.findings.every((f) => f.text.length <= 500));
	assert.match(material.findings[0]!.text, /^src\/b\.ts:1 · blocker 0 x+…$/);
	assert.equal(material.changedFiles.length, 200); assert.equal(material.changedFilesOmitted, 5);
	assert.equal(material.changedFiles[0], "f000.ts", "ordenados");
	const small = previousMaterial(comparison());
	assert.equal("findingsOmitted" in small, false); assert.equal("changedFilesOmitted" in small, false);
});
