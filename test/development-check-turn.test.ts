// omi_workflow_check con Git y procesos reales: el turno de checks del repo y los ajustes de timeout que hace el host.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Evidence } from "../src/harness/model.ts";
import { checkTurnPath, takeCheckTurn } from "../src/harness/check-queue.ts";
import { developmentFixture } from "./helpers/development.ts";

type Fixture = Awaited<ReturnType<typeof developmentFixture>>;
type Progress = { progress?: { activity: string; status: string } };
const FAST = { pollMs: 10, limitMs: 60_000 };
const WAITING = "Esperando turno de checks · npm test en issue-98";
const texts = (result: { content: unknown[] }) => result.content.map((c) => (c as { text: string }).text);
const evidenceOf = (result: { content: unknown[] }) => JSON.parse(texts(result)[0]!) as Evidence;
const waitingEvents = (f: Fixture) => (f.progress as Progress[]).filter((e) => e.progress?.activity === WAITING && e.progress.status === "waiting");
async function until(condition: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 1000 && !condition(); i++) await sleep(5);
	assert.ok(condition(), label);
}
async function verifying(t: TestContext): Promise<Fixture> {
	const f = await developmentFixture(t, { deps: { checkTurn: FAST } }); await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	assert.equal((await f.state()).phase, "verify");
	return f;
}
// Otro worktree del mismo repo corre npm test y tiene el turno.
const otherWorktree = (f: Fixture) => takeCheckTurn({ ...f.checkout, root: join(f.home, "issue-98") }, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);

test("development_check_turn un gate espera el turno de otro worktree del repo, lo muestra en el progreso y corre al liberarse", async (t) => {
	const f = await verifying(t);
	const other = await otherWorktree(f);
	// Un gate sin historia es pesado: node test.cjs ya corrió rápido como rojo y verde, otro-test no.
	const pending = f.invoke("omi_workflow_check", { kind: "gate", command: "node other-test.cjs" });
	await until(() => waitingEvents(f).length > 0, "el progreso dice a quién espera");
	await sleep(80);
	assert.equal((await f.state()).evidence.filter((e) => e.kind === "gate").length, 0, "mientras espera, no corre");
	assert.equal(waitingEvents(f).length, 1, "el progreso se emite sólo cuando cambia el texto");
	const released = Date.now(); await other.release();
	const result = await pending;
	assert.equal(result.isError, false);
	assert.deepEqual(texts(result).slice(1), ["Esperó menos de 1 min el turno de checks del repo: lo tenía npm test en issue-98."]);
	const evidence = evidenceOf(result);
	assert.equal(evidence.kind, "gate"); assert.equal(evidence.outcome, "passed");
	assert.ok(Date.parse(evidence.startedAt) >= released, "startedAt queda después de la espera");
	assert.deepEqual((await f.state()).evidence.filter((e) => e.kind === "gate").map((e) => e.id), [evidence.id]);
	assert.ok(!(await readdir(join(f.checkout.commonDir, "omi"))).includes("check-turn.lock"), "al terminar libera el turno");
	const last = (f.progress as Progress[]).at(-1)?.progress;
	assert.notEqual(last?.activity, WAITING);
});

test("development_check_turn Esc mientras espera turno no corre el comando, no registra evidencia y el progreso deja de esperar", async (t) => {
	const f = await verifying(t);
	const other = await otherWorktree(f);
	const turn = await readFile(checkTurnPath(f.checkout), "utf8");
	const marker = join(f.home, "ran");
	const before = (await f.state()).evidence.length;
	const controller = new AbortController();
	const pending = f.invoke("omi_workflow_check", { kind: "gate", command: `touch ${marker}` }, controller.signal);
	await until(() => waitingEvents(f).length > 0, "está esperando turno");
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(existsSync(marker), false, "no corre el comando");
	assert.equal((await f.state()).evidence.length, before, "no registra evidencia");
	const last = (f.progress as Progress[]).at(-1)?.progress;
	assert.ok(last && last.status !== "waiting" && last.activity !== WAITING, `el progreso deja de esperar: ${JSON.stringify(last)}`);
	assert.equal(await readFile(checkTurnPath(f.checkout), "utf8"), turn, "el turno ajeno queda intacto");
	await other.release();
});

// Review del incidente (2026-11-26, queue-1-Q1): un setup nunca tenía historia y siempre esperaba turno, también un
// npm ci de 5 s detrás de la suite de otro worktree. Sólo el primero de un comando espera; si fue rápido, el siguiente no.
test("development_check_turn un setup espera el turno la primera vez; ya corrido y rápido, el siguiente no espera", async (t) => {
	const f = await developmentFixture(t, { deps: { checkTurn: FAST } }); await f.start();
	const command = "node -e 0";
	let other = await otherWorktree(f);
	const first = f.invoke("omi_workflow_check", { kind: "setup", command });
	await until(() => waitingEvents(f).length > 0, "sin historia, el setup espera");
	await other.release();
	assert.equal((await first).isError, false);
	other = await otherWorktree(f);
	const before = waitingEvents(f).length;
	const second = await Promise.race([f.invoke("omi_workflow_check", { kind: "setup", command }), sleep(3000).then(() => "esperó el turno")]);
	await other.release();
	assert.notEqual(second, "esperó el turno", "ya corrido y rápido, no espera");
	assert.equal(waitingEvents(f).length, before, "no mostró espera");
});

test("development_check_turn un timeoutSeconds corto se sube a 1,5× la última corrida completa del mismo comando y la salida lo dice", async (t) => {
	// Cada lectura del reloj del harness avanza 4 s: cada check registrado dura 4 s.
	let clock = Date.now();
	const f = await developmentFixture(t, { deps: { checkTurn: FAST, now: () => new Date(clock += 4000).toISOString() } }); await f.start();
	const slow = join(f.home, "slow");
	const command = `node -e "setTimeout(() => {}, require('node:fs').existsSync('${slow}') ? 2000 : 0)"`;
	const first = await f.invoke("omi_workflow_check", { kind: "reproduction", command, timeoutSeconds: 1 });
	assert.equal(first.isError, false);
	assert.equal(texts(first).length, 1, "sin corrida anterior no hay ajuste");
	await writeFile(slow, "");
	const second = await f.invoke("omi_workflow_check", { kind: "reproduction", command, timeoutSeconds: 1 });
	assert.equal(second.isError, false, `con 1 s lo habría cortado: ${JSON.stringify(texts(second))}`);
	assert.equal(evidenceOf(second).outcome, "passed");
	assert.deepEqual(texts(second).slice(1), ["timeoutSeconds 1 → 6: la última corrida completa de este comando tardó 4 s; el host deja 1,5× de margen."]);
});

test("development_check_turn un check cortado por tiempo lo dice y sugiere timeoutSeconds", async (t) => {
	const f = await developmentFixture(t, { deps: { checkTurn: FAST } }); await f.start();
	const command = `node -e "setTimeout(() => {}, 10000)"`;
	const NOTE = "Se cortó por tiempo a los 1 s. No cuenta como corrida completa: quedó interrumpida. Volvé a correrlo con timeoutSeconds: 2.";
	const reproduction = await f.invoke("omi_workflow_check", { kind: "reproduction", command, timeoutSeconds: 1 });
	assert.equal(reproduction.isError, true);
	assert.equal(evidenceOf(reproduction).outcome, "interrupted");
	assert.deepEqual(texts(reproduction).slice(1), [NOTE]);
	const setup = await f.invoke("omi_workflow_check", { kind: "setup", command, timeoutSeconds: 1 });
	assert.equal(setup.isError, true);
	assert.match(texts(setup)[0]!, /"timedOut":true/);
	assert.ok(texts(setup).includes(NOTE), `también un setup: ${JSON.stringify(texts(setup))}`);
});
