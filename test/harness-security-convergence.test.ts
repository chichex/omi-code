// Convergencia de security: desde la segunda revisión del pedido, el host compara con la anterior y baja a aviso un
// blocker nuevo de clase otro en un archivo sin cambios. Falla cerrado: si no puede comparar, no baja nada.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runner } from "../src/core/exec.ts";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { FAIL_WITHOUT_FINDINGS, securityBlocks } from "../src/harness/security-blockers.ts";
import { convergeSecurity, findingFile, previousMaterial, reviewedCommit, SECURITY_ACCEPTED_REPEAT, SECURITY_DOWNGRADED, securityBaseline, securityComparison, type SecurityComparison } from "../src/harness/security-convergence.ts";
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
const comparison = (changes: Partial<SecurityComparison> = {}): SecurityComparison => ({ baseline: review("security", "tree1", "fail", ["src/a.ts:1 · permiso abierto"]), changed: new Set(["src/b.ts"]), tree: new Set(TREE), blockerFiles: new Set(["src/a.ts"]), accepted: new Set(), ...changes });
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

// Review del incidente (2026-11-26, bypass-2): la convergencia miraba sólo el primer archivo:línea. Con el sumidero en un
// archivo sin cambios citado primero y el disparador en un archivo cambiado, el blocker bajaba a aviso.
test("security_convergence mira todas las rutas que cita el hallazgo: si alguna cambió, es la de un blocker anterior o una con línea no está en HEAD, no baja", () => {
	const kept = [
		blocker("src/c.ts:4 · el sumidero ejecuta lo que recibe; lo dispara src/b.ts:10 con datos del issue", "otro"),
		blocker("src/c.ts:5 · el sumidero ejecuta lo que recibe; lo llama el handler nuevo de `src/b.ts`", "otro"),
		blocker("src/c.ts:6 · el mismo permiso abierto que en src/a.ts", "otro"),
		blocker("src/c.ts:7 · igual que vendor/x.js:3, que no está en el repo", "otro"),
		blocker("src/c.ts:8 · lo usa (b.ts)", "otro"),
	];
	const control = blocker("src/c.ts:9 · el directorio queda abierto, también en src/c.ts:20", "otro");
	const { result, downgraded } = convergeSecurity(security([...kept, control]), comparison());
	assert.equal(downgraded, 1, "el control con rutas sólo sin cambios sí baja");
	assert.deepEqual(result.severities, [...kept.map(() => "blocker"), "aviso"]);
	// Cada forma de citar una ruta cambiada mantiene el blocker: entre backticks, con «./», entre paréntesis o al final de una oración.
	const forms = ["lo dispara `src/b.ts:12–14`", "lo dispara ./src/b.ts:3", "ver (src/b.ts)", "y src/b.ts."];
	for (const form of forms) assert.equal(convergeSecurity(security([blocker(`src/c.ts:4 · el sumidero; ${form}`, "otro")]), comparison()).downgraded, 0, form);
});

// Review del incidente (ronda 2, bypass-2-ruta-ancla-sin-forma y bypass-2-rutas-encadenadas-o-con-simbolos): findingPaths sólo
// reconocía rutas ASCII con extensión o «/». Un Makefile cambiado, un archivo con tilde, ñ, =, # o $, o rutas encadenadas con
// flechas bajaban a aviso aunque fueran de un archivo cambiado o del blocker anterior. El agente elige el nombre de sus archivos.
test("security_convergence reconoce un archivo cambiado o el de un blocker anterior con cualquier forma de ruta, también encadenado sin espacios", async () => {
	const shapes = ["Makefile", "Dockerfile", "src/acción.ts", "src/añadir.ts", "src/a=b.ts", "src/v2#x.ts", "app/routes/posts.$postId.tsx", "src/a%20b.ts"];
	const tree = [...TREE, ...shapes, "src/exec.ts", "src/run.ts", "src/cli.ts"];
	for (const file of shapes) {
		const changed = convergeSecurity(security([blocker(`${file}:2 · interpola el título del issue en un comando`, "otro")]), comparison({ changed: new Set([file]), tree: new Set(tree) }));
		assert.equal(changed.downgraded, 0, `regla (a): ${file} cambió`);
		const repeated = convergeSecurity(security([blocker(`${file}:2 · interpola el título del issue en un comando`, "otro")]), comparison({ tree: new Set(tree), blockerFiles: new Set([file]) }));
		assert.equal(repeated.downgraded, 0, `regla (b): ${file} es el de un blocker anterior`);
		const cited = convergeSecurity(security([blocker(`src/c.ts:4 · el sumidero; lo dispara ${file}:20`, "otro")]), comparison({ changed: new Set([file]), tree: new Set(tree) }));
		assert.equal(cited.downgraded, 0, `${file} citado después del primer tramo`);
	}
	const chain = convergeSecurity(security([blocker("src/exec.ts:88 · el título del issue llega a execSync: src/exec.ts:88←src/run.ts:40←src/cli.ts:12", "otro")]), comparison({ changed: new Set(["src/cli.ts"]), tree: new Set(tree) }));
	assert.equal(chain.downgraded, 0, "una cadena con flechas sin espacios");
	const control = convergeSecurity(security([blocker("src/exec.ts:88 · el título del issue llega a execSync: src/exec.ts:88←src/run.ts:40", "otro")]), comparison({ changed: new Set(["src/cli.ts"]), tree: new Set(tree) }));
	assert.equal(control.downgraded, 1, "el control sin archivos cambiados sí baja");
	// De punta a punta: la base cita un Makefile y Seguridad lo repite tras el retry sin que cambie.
	const s = afterRetry(["Makefile:2 · interpola el título del issue en un comando de shell"]);
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["extra.test.cjs"], tree: [...tree, "extra.test.cjs"] }).runner);
	assert.ok(c); assert.ok(c.blockerFiles.has("Makefile"));
	assert.equal(convergeSecurity(security([blocker("Makefile:2 · interpola el título del issue en un comando de shell", "otro")]), c).downgraded, 0);
	// Las otras rutas de un blocker anterior también cuentan, con cualquier forma.
	const chained = afterRetry(["src/exec.ts:88 · llega a execSync: src/exec.ts:88←src/acción.ts:40"]);
	const { comparison: d } = await securityComparison(chained, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree }).runner);
	assert.ok(d?.blockerFiles.has("src/acción.ts"), JSON.stringify([...d?.blockerFiles ?? []]));
});

// Review del incidente (ronda 3, bypass-3-ruta-con-comillas-o-negrita, bypass-3-ruta-envuelta-sin-linea y
// rules-3-convergencia-comillas-tipograficas): cortar en palabras dejaba pegadas «», “”, **, #L12, !, ? o una flecha, y una
// ruta con espacios se partía. Ahora cada archivo conocido se busca como subcadena, con límites de ruta.
test("security_convergence reconoce un archivo nombrado entre comillas tipográficas, en negrita, con #L, puntuación o espacios", async () => {
	const tree = [...TREE, "src/cli.ts", "src/run task.ts", "src/store.ts", "src/lib.ts", "src/b.ts.bak"];
	const wraps = ["«src/b.ts»", "“src/b.ts”", "**src/b.ts**", "src/b.ts#L12", "src/b.ts!", "¿src/b.ts?", "src/b.ts—el handler", "src/b.ts->exec", "‘src/b.ts’", "b.ts», que cambió"];
	for (const wrap of wraps) {
		const a = convergeSecurity(security([blocker(`src/c.ts:4 · execSync interpola el título del issue, que llega desde ${wrap}`, "otro")]), comparison({ tree: new Set(tree) }));
		assert.equal(a.downgraded, 0, `regla (a): ${wrap}`);
		const b = convergeSecurity(security([blocker(`src/c.ts:4 · arma la ruta del lock de ${wrap.replaceAll("src/b.ts", "src/store.ts").replace("b.ts»", "store.ts»")} con el título del issue`, "otro")]), comparison({ tree: new Set(tree), changed: new Set(), blockerFiles: new Set(["src/store.ts"]) }));
		assert.equal(b.downgraded, 0, `regla (b): ${wrap}`);
	}
	assert.equal(convergeSecurity(security([blocker("src/c.ts:4 · lo dispara «src/run task.ts»", "otro")]), comparison({ tree: new Set(tree), changed: new Set(["src/run task.ts"]) })).downgraded, 0, "una ruta con espacios");
	// Controles: otra palabra que contiene el nombre no lo nombra.
	for (const text of ["src/c.ts:4 · como en src/lib.ts", "src/c.ts:4 · como en src/b.ts.bak", "src/c.ts:4 · como en xb.ts"]) assert.equal(convergeSecurity(security([blocker(text, "otro")]), comparison({ tree: new Set(tree) })).downgraded, 1, text);
	// De punta a punta: la base nombra «src/cli.ts» sin línea y ese archivo protege la regla (b).
	const s = afterRetry(["src/c.ts:4 · execSync interpola el título que llega desde «src/cli.ts»"]);
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree }).runner);
	assert.ok(c?.blockerFiles.has("src/cli.ts"), JSON.stringify([...c?.blockerFiles ?? []]));
});

// Review del incidente (2026-11-26, bypass-5): las rutas de los blockers anteriores no se normalizaban ni se validaban.
// Si la base citaba «store.ts:22» y ahora el lente cita la ruta completa, la regla (b) no lo reconocía y bajaba.
test("security_convergence normaliza las rutas de los blockers anteriores contra el árbol; una que no está en el árbol ni entre los cambios no compara", async () => {
	const tree = ["src/harness/store.ts", "src/c.ts", "src/b.ts"];
	const short = afterRetry(["store.ts:22 · el lock ajeno se roba"]);
	const { comparison: c } = await securityComparison(short, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree }).runner);
	assert.ok(c);
	assert.ok(c.blockerFiles.has("src/harness/store.ts"), "la ruta corta se resuelve a la del árbol");
	const { result, downgraded } = convergeSecurity(security([blocker("src/harness/store.ts:30 · el lock ajeno se sigue robando", "otro"), blocker("src/c.ts:1 · permiso abierto", "otro")]), c);
	assert.equal(downgraded, 1);
	assert.deepEqual(result.severities, ["blocker", "aviso"], "repite el archivo del blocker anterior aunque lo cite con otra ruta");
	const unknown = afterRetry(["harness/nope.ts:1 · el lock ajeno se roba"]);
	assert.deepEqual(await securityComparison(unknown, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree }).runner), { note: "sin comparación con la revisión anterior: un blocker anterior cita un archivo que no está en el árbol; no se baja ningún blocker" });
	const deleted = afterRetry(["src/old.ts:1 · permiso abierto"]);
	const gone = await securityComparison(deleted, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/old.ts"], tree }).runner);
	assert.ok(gone.comparison?.blockerFiles.has("src/old.ts"), "un archivo borrado desde la base está entre los cambios");
});

// Review del incidente (2026-11-26, replay-riesgo-aceptado-reabre): la persona aceptaba un blocker sobre X, un gate rojo
// obligaba a un amend (retry se rechaza con AMEND_FIRST) y, sobre Y, el mismo hallazgo en el mismo archivo sin cambios
// volvía a frenar: lo aceptado contaba como blocker de la base. Ahora repetido en su archivo sin cambios baja a aviso y
// lo dice; un archivo cambiado, un secreto o un retry (que borra la aceptación) lo vuelven a frenar.
async function acceptedThenAmended(diff: string[], base = "src/a.ts:1 · permiso abierto") {
	const accepted = "src/a.ts:1 · permiso abierto";
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [base]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [base], reason: "Preexistente en main" });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Arreglar el gate", fingerprint: "tree1" });
	s = implement(s, "C2", "tree2", sha("2"));
	assert.deepEqual(s.version === 2 ? s.acceptedRisks?.map((a) => a.fingerprint) : [], ["tree1"], "la aceptación es de la base");
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, git({ diff, tree: TREE }).runner);
	assert.ok(c, "hay comparación");
	return { accepted, c };
}
test("security_convergence un blocker que una persona aceptó en la base, repetido tras un amend en su archivo sin cambios, baja a aviso y lo dice", async () => {
	const { accepted, c } = await acceptedThenAmended(["src/b.ts"]);
	assert.deepEqual([...c.blockerFiles], ["src/a.ts"], "el archivo sigue siendo el de un blocker anterior: la persona aceptó un texto, no el archivo");
	assert.deepEqual(previousMaterial(c).findings, [{ blocker: true, accepted: true, text: accepted }], "el lente sabe que una persona lo aceptó");
	const { result, downgraded } = convergeSecurity(security([blocker(accepted, "otro"), blocker("src/c.ts:1 · permiso abierto", "otro")]), c);
	assert.equal(downgraded, 2);
	assert.deepEqual(result.findings, [`${SECURITY_ACCEPTED_REPEAT} · ${accepted}`, `${SECURITY_DOWNGRADED} · src/c.ts:1 · permiso abierto`]);
	assert.deepEqual(result.severities, ["aviso", "aviso"]);
	assert.equal(result.verdict, "fail", "el veredicto no cambia");
	const secret = convergeSecurity(security([blocker("src/a.ts:1 · deja el token en el log", "secreto")]), c);
	assert.deepEqual([secret.downgraded, secret.result.severities], [0, ["blocker"]], "un secreto en un archivo aceptado se vuelve a aceptar");
	// Ronda 2 (replay-2-aceptado-se-extiende-al-archivo, rules-2-prefijo-aceptado-sin-aceptar): sólo el texto aceptado baja como
	// repetido. Otro hallazgo en ese archivo, o el mismo dicho de otra forma, no lo vio la persona: sigue blocker por la regla (b).
	const other = convergeSecurity(security([blocker("src/a.ts:40 · arma un comando de shell con el título del issue", "otro"), blocker("src/a.ts:1 · el permiso sigue abierto", "otro")]), c);
	assert.equal(other.downgraded, 0);
	assert.deepEqual(other.result.severities, ["blocker", "blocker"]);
	assert.ok(other.result.findings.every((f) => !f.startsWith(SECURITY_ACCEPTED_REPEAT)), "nadie lo aceptó: no lleva el rótulo");
	assert.equal(convergeSecurity(security([blocker(`  ${accepted.replace(" · ", "  ·  ")} `, "otro")]), c).downgraded, 1, "sólo cambian los espacios");
});

test("security_convergence un texto aceptado en una base por partes se reconoce sin el prefijo de parte", async () => {
	const { accepted, c } = await acceptedThenAmended(["src/b.ts"], "parte 2/3 · src/a.ts:1 · permiso abierto");
	assert.deepEqual(previousMaterial(c).findings, [{ blocker: true, accepted: true, text: "src/a.ts:1 · permiso abierto" }], "sin el prefijo de parte: es lo que el lente tiene que repetir");
	const { result, downgraded } = convergeSecurity(security([blocker(accepted, "otro")]), c);
	assert.equal(downgraded, 1);
	assert.deepEqual(result.findings, [`${SECURITY_ACCEPTED_REPEAT} · ${accepted}`]);
});

// Review del incidente (ronda 3, replay-3-aceptado-largo-no-se-repite y replay-3-aceptado-largo-o-ruta-corta-reabre): previous
// recortaba a 500 caracteres un texto aceptado, y el lente no podía repetirlo exacto; y un texto aceptado con una ruta corta
// («store.ts:22») nunca era una repetición, porque el primer tramo no estaba literal en el árbol.
async function acceptedOn(base: string, tree: string[], diff: string[]) {
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [base]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [base], reason: "Preexistente en main" });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Arreglar el gate", fingerprint: "tree1" });
	s = implement(s, "C2", "tree2", sha("2"));
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, git({ diff, tree }).runner);
	assert.ok(c); return c;
}
test("security_convergence un texto aceptado largo llega entero al lente y un texto aceptado con ruta corta también se reconoce", async () => {
	const long = `src/a.ts:1 · ${"el lock se roba con un PID ajeno; ".repeat(18)}`.trim();
	assert.ok(long.length > 500);
	const c = await acceptedOn(long, TREE, ["src/b.ts"]);
	assert.deepEqual(previousMaterial(c).findings, [{ blocker: true, accepted: true, text: long }], "entero: el lente lo tiene que poder repetir");
	assert.deepEqual(convergeSecurity(security([blocker(long, "otro")]), c).result.findings, [`${SECURITY_ACCEPTED_REPEAT} · ${long}`]);
	const tree = ["src/harness/store.ts", "src/b.ts"];
	const short = "store.ts:22 · el lock se roba con un PID ajeno";
	const kept = await acceptedOn(short, tree, ["src/b.ts"]);
	assert.deepEqual(convergeSecurity(security([blocker(short, "otro")]), kept).result.findings, [`${SECURITY_ACCEPTED_REPEAT} · ${short}`], "la ruta corta se resuelve contra el árbol");
	const changed = await acceptedOn(short, tree, ["src/harness/store.ts"]);
	assert.deepEqual(convergeSecurity(security([blocker(short, "otro")]), changed).result.severities, ["blocker"], "si su archivo cambió, vuelve a frenar");
	assert.deepEqual(convergeSecurity(security([blocker("store.ts:30 · otro hallazgo en el mismo archivo", "otro")]), kept).result.severities, ["blocker"], "otro texto con ruta corta sigue blocker");
});

// Review del incidente (ronda 3, replay-3-aceptado-pierde-regla-b-en-el-segundo-amend): sobre Y lo aceptado bajó a aviso, y Y
// pasó a ser la base. En el amend siguiente, ese aviso ya no era un blocker de la base: su archivo dejaba de proteger la regla
// (b) y el mismo texto aceptado ya no se reconocía.
async function twoAmends(yFindings: string[]) {
	const accepted = "src/a.ts:1 · permiso abierto";
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [accepted]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [accepted], reason: "Preexistente en main" });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Arreglar el gate", fingerprint: "tree1" });
	s = implement(s, "C2", "tree2", sha("2"));
	// Sobre Y (tree2) el host bajó el texto aceptado como repetido.
	s = send(s, { type: "reviewed", review: review("security", "tree2", "fail", yFindings, { severities: yFindings.map(() => "aviso" as const) }) });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree2", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Otro gate", fingerprint: "tree2" });
	s = implement(s, "C3", "tree3", sha("3"));
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree3", head: sha("3") }, git({ diff: ["src/b.ts"], tree: TREE }).runner);
	assert.ok(c); assert.equal(c.baseline.fingerprint, "tree2");
	return { accepted, c };
}
test("security_convergence lo aceptado sigue contando en el segundo amend: se reconoce y su archivo protege la regla (b)", async () => {
	const { accepted, c } = await twoAmends([`parte 1/2 · ${SECURITY_ACCEPTED_REPEAT} · src/a.ts:1 · permiso abierto`]);
	assert.ok(c.blockerFiles.has("src/a.ts"), "su archivo sigue protegiendo la regla (b)");
	const { result } = convergeSecurity(security([blocker(accepted, "otro"), blocker("src/a.ts:40 · arma un comando con el título del issue", "otro")]), c);
	assert.deepEqual(result.severities, ["aviso", "blocker"]);
	assert.equal(result.findings[0], `${SECURITY_ACCEPTED_REPEAT} · ${accepted}`, "el texto aceptado se sigue reconociendo");
	assert.deepEqual(previousMaterial(c).findings, [{ blocker: false, accepted: true, text: accepted }], "sin los prefijos del host");
	// Un aviso con el prefijo cuyo texto ninguna persona aceptó en esta vuelta no cuenta como aceptado. Ronda 4: sí cuenta como
	// blocker anterior y protege su archivo (falla cerrado), así que el mismo texto sigue blocker y sin el rótulo de aceptado.
	const forged = await twoAmends([`${SECURITY_ACCEPTED_REPEAT} · src/c.ts:9 · nadie lo aceptó`]);
	assert.equal(forged.c.accepted.size, 0);
	assert.equal(forged.c.blockerFiles.has("src/c.ts"), true);
	const again = convergeSecurity(security([blocker("src/c.ts:9 · nadie lo aceptó", "otro")]), forged.c).result;
	assert.deepEqual([again.findings, again.severities], [["src/c.ts:9 · nadie lo aceptó"], ["blocker"]], "no baja: su archivo es el de un blocker anterior");
});

// Ronda 4 (replay-4-aceptado-fuera-del-tope-de-previous, correctness-4-previous-tope-oculta-aceptados): previous cortaba en 10
// con los blockers primero, y un aceptado que la base guardó como aviso detrás de otros 10 avisos quedaba afuera. El lente no
// podía repetir su texto exacto y Verificar volvía a frenar hasta otra aceptación.
test("security_convergence previous manda primero lo aceptado: no lo deja afuera del tope de 10", async () => {
	const others = Array.from({ length: 10 }, (_, i) => `parte 1/2 · src/c.ts:${i + 1} · aviso ${i}`);
	const { accepted, c } = await twoAmends([...others, `parte 2/2 · ${SECURITY_ACCEPTED_REPEAT} · src/a.ts:1 · permiso abierto`]);
	const previous = previousMaterial(c);
	assert.deepEqual(previous.findings[0], { blocker: false, accepted: true, text: accepted });
	assert.equal(previous.findings.length, 10);
	assert.equal(previous.findingsOmitted, 1);
});

test("security_convergence lo aceptado vuelve a frenar si su archivo cambió o si un retry borró la aceptación", async () => {
	const { accepted, c } = await acceptedThenAmended(["src/a.ts"]);
	const changed = convergeSecurity(security([blocker(accepted, "otro")]), c);
	assert.deepEqual([changed.downgraded, changed.result.severities], [0, ["blocker"]], "el archivo aceptado cambió: la persona lo vuelve a mirar");
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [accepted]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [accepted], reason: "Preexistente en main" });
	// Un gate rojo sin amends disponibles: el único retry que se acepta con el riesgo aceptado.
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = { ...s, amends: [{ from: "tree0", reason: "uno", at }, { from: "tree0", reason: "dos", at }] } as Workflow;
	s = send(s, { type: "retry", reason: "Rehacer el permiso", fingerprint: "tree1" });
	assert.deepEqual(s.version === 2 ? s.acceptedRisks ?? [] : [], [], "retry borra la aceptación");
	s = implement(s, "C2", "tree2", sha("2"));
	const { comparison: retried } = await securityComparison(s, { fingerprint: "tree2", head: sha("2") }, git({ diff: ["src/b.ts"], tree: TREE }).runner);
	assert.ok(retried);
	assert.deepEqual([...retried.blockerFiles], ["src/a.ts"], "sin la aceptación, vuelve a ser blocker de la base");
	assert.deepEqual(convergeSecurity(security([blocker(accepted, "otro")]), retried).result.severities, ["blocker"]);
});

// Ronda 4 (bypass-4-retry-tras-repetido-aceptado-pierde-regla-b, correctness-4-aceptado-tras-retry-desde-amend-baja-sin-persona):
// tras el amend, Y guardó lo aceptado como aviso repetido. Un retry desde Y borraba la aceptación y, sobre Z, ese aviso ya no era
// un blocker de la base: lo aceptado repetido y otro blocker en su archivo bajaban a aviso sin una persona.
test("security_convergence tras un retry desde el contenido del amend, lo aceptado repetido vuelve a frenar y su archivo protege la regla (b)", async () => {
	const accepted = "src/a.ts:1 · permiso abierto";
	let s = implement(approved(), "C1", "tree1", sha("1"));
	s = send(s, { type: "reviewed", review: review("security", "tree1", "fail", [accepted]) });
	s = send(s, { type: "risk_accepted", fingerprint: "tree1", findings: [accepted], reason: "Preexistente en main" });
	s = send(s, { type: "evidence", evidence: evidence("gate", "tree1", { exitCode: 1, outcome: "failed" }) });
	s = send(s, { type: "amend", reason: "Arreglar el gate", fingerprint: "tree1" });
	s = implement(s, "C2", "tree2", sha("2"));
	s = send(s, { type: "reviewed", review: review("security", "tree2", "fail", ["src/b.ts:3 · ejecuta el body del issue", `${SECURITY_ACCEPTED_REPEAT} · ${accepted}`], { severities: ["blocker", "aviso"] }) });
	s = send(s, { type: "retry", reason: "Cerrar el body", fingerprint: "tree2" });
	assert.equal(s.round, 1, "el retry se aceptó");
	assert.deepEqual(s.version === 2 ? s.acceptedRisks ?? [] : [], [], "retry borra la aceptación");
	s = implement(s, "C3", "tree3", sha("3"));
	const { comparison: c } = await securityComparison(s, { fingerprint: "tree3", head: sha("3") }, git({ diff: ["src/b.ts"], tree: TREE }).runner);
	assert.ok(c); assert.equal(c.baseline.fingerprint, "tree2");
	assert.deepEqual([...c.blockerFiles].sort(), ["src/a.ts", "src/b.ts"], "lo aceptado que bajó como repetido sigue siendo un blocker de la base");
	assert.deepEqual([...c.accepted], [], "nadie lo aceptó en esta vuelta");
	const { result, downgraded } = convergeSecurity(security([blocker(accepted, "otro"), blocker("src/a.ts:40 · arma un comando de shell con el título del issue", "otro")]), c);
	assert.deepEqual([downgraded, result.severities], [0, ["blocker", "blocker"]]);
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
	const material = previousMaterial({ baseline, changed, tree: new Set(), blockerFiles: new Set(["src/b.ts"]), accepted: new Set() });
	assert.equal(material.findings.length, 10); assert.equal(material.findingsOmitted, 2);
	assert.deepEqual(material.findings.map((f) => f.blocker), [true, true, true, true, false, false, false, false, false, false]);
	assert.ok(material.findings.every((f) => f.text.length <= 500));
	assert.match(material.findings[0]!.text, /^src\/b\.ts:1 · blocker 0 x+…$/);
	assert.equal(material.changedFiles.length, 200); assert.equal(material.changedFilesOmitted, 5);
	assert.equal(material.changedFiles[0], "f000.ts", "ordenados");
	const small = previousMaterial(comparison());
	assert.equal("findingsOmitted" in small, false); assert.equal("changedFilesOmitted" in small, false);
});
