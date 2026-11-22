import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import { createWorkflow, transition, recipeApprovalHash } from "../src/harness/state.ts";
import { parseWorkflow, sourceHash, WorkflowV2Schema } from "../src/harness/model.ts";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { performLifecycleOperation } from "../src/harness/lifecycle-operations.ts";

const repo = "acme/app"; const at = "2026-01-01T00:00:00Z"; const owner = "process-a";
const root = { workflowId: "root42", issue: 42, repo };
const config = () => defaultLifecycleConfig(repo, "main");
const pin = (block = config()) => ({ key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "perillas", author: "Ada", date: at, acceptedAt: at } });
const subject = (id = "head-1", number = 42) => ({ id, repo, number, branch: `feat/pr-${number}`, base: "main", headSha: "b".repeat(40), baseSha: "a".repeat(40), contentHash: "c".repeat(64), mergedSha: null });
const intent = (id = "op1", kind = "review", subjectId = "head-1") => ({ id, key: `intent-${id}`, kind, subjectId, targetId: null, correlationId: `correlation-${id}`, retryOf: null });
type DecisionSubject = { id: string; kind: string; subjectId: string; targetId: string | null };
const decision = (i: DecisionSubject = intent(), hash = pin().accepted.blockHash) => ({ id: `decision-${i.id}`, kind: i.kind, subjectId: i.subjectId, targetId: i.targetId, configHash: hash, source: "person", at });
const receipt = (id = "op1", outcome = "succeeded", subjectId = "head-1") => ({ operationId: id, correlationId: `correlation-${id}`, subjectId, targetId: null, externalId: `external-${id}`, outcome, verifiedSubjectId: null, at });
function initialized() { return life.initializeLifecycle(root, pin()); }
function ready() { return life.bindLifecycleSubject(initialized(), subject(), { id: "confirmation1", source: "person", at }); }
function reserve(s: unknown = ready(), i: DecisionSubject = intent()) { return life.reserveLifecycleOperation(s, i, decision(i), owner, at); }
function observed() { return life.confirmLifecycleOperation(reserve(), receipt()); }
function finding(id = "finding1", externalId = "comment1") { return { id, provider: "github", externalId, operationId: "op1", subjectId: "head-1", text: "Falta validar un error", severity: "medium", resolved: false, outdated: false, at }; }
function workflow() {
 const source = { number: 42, title: "Lifecycle", body: "Pedido", hash: sourceHash("Lifecycle", "Pedido"), url: "https://github.com/acme/app/issues/42" };
 return createWorkflow(source, { root: "/repo", commonDir: "/repo/.git", branch: "feat/work", baseCommit: "a".repeat(40) }, root.workflowId, at);
}
async function stored(t: TestContext) {
 const dir = await realpath(await mkdtemp(join(tmpdir(), "omi-lifecycle-root-"))); t.after(() => rm(dir, { recursive: true, force: true })); await mkdir(join(dir, ".git"));
 const state = { ...workflow(), checkout: { ...workflow().checkout, root: dir, commonDir: join(dir, ".git") }, lifecycle: ready() };
 await updateWorkflow(state.checkout, 42, undefined, () => state); return state;
}

test("v2 acepta agregado durable cerrado, no una lista de evidencia prestada del modelo", () => {
 const enabled = { status: "enabled", root, pins: [pin()], pinHash: pin().accepted.blockHash, stage: "review", currentSubject: null, subjects: [], decisions: [], operations: [], budget: { attemptsUsed: 0, fixForwardPRsUsed: 0, roundsUsed: 0, activeMilliseconds: 0 }, segments: [], ledger: [], evidence: [], checks: [], approvals: [] };
 assert.equal(Value.Check(WorkflowV2Schema, { ...workflow(), lifecycle: enabled }), true);
 assert.equal(Value.Check(WorkflowV2Schema, { ...workflow(), lifecycle: { ...enabled, approved: true } }), false);
});

test("inicialización única y reserva consumen sólo presupuesto post-PR, sin mutar el original", () => {
 const s = ready(); const before = JSON.stringify(s); const next = reserve(s);
 assert.equal(next.budget.attemptsUsed, 1); assert.equal(next.budget.roundsUsed, 0); assert.equal(next.budget.fixForwardPRsUsed, 0);
 assert.equal(next.operations[0]?.status, "pending"); assert.equal(next.operations[0]?.correlationId, "correlation-op1");
 assert.equal(JSON.stringify(s), before); assert.equal(workflow().maxRounds, 3);
 assert.equal(next.pins[0]?.accepted.block.corrections.maxRounds, 2);
 assert.throws(() => life.reserveLifecycleOperation(initialized(), intent(), decision(), owner, at), /sujeto|adop/);
 assert.throws(() => life.initializeLifecycle(root, { ...pin(), accepted: { ...pin().accepted, blockHash: "f".repeat(64) } }));
});

test("decisión faltante/ajena/obsoleta o política auto sobre ask no reserva ni inventa permisos", () => {
 for (const d of [null, { ...decision(), subjectId: "other" }, { ...decision(), configHash: "f".repeat(64) }, { ...decision(), source: "policy" }, { ...decision(), approved: true }]) assert.throws(() => life.reserveLifecycleOperation(ready(), intent(), d, owner, at));
 const other = { ...subject(), repo: "other/app" }; assert.throws(() => life.bindLifecycleSubject(initialized(), other, { id: "confirmation", source: "person", at }));
 assert.throws(() => life.reserveLifecycleOperation(ready(), { ...intent(), cost: 0 }, decision(), owner, at));
});

test("unknown no devuelve consumo ni permite replay con ID/correlación/intención nuevos", () => {
 const s = life.markLifecycleUnknown(reserve(), "op1", "respuesta perdida", at);
 assert.equal(s.budget.attemptsUsed, 1);
 assert.throws(() => life.reserveLifecycleOperation(s, intent("op2"), decision(intent("op2")), owner, at), /pendiente|inciert|duplic/);
 assert.throws(() => life.confirmLifecycleOperation(s, { ...receipt(), correlationId: "otra" }));
 const confirmed = life.confirmLifecycleOperation(s, receipt());
 assert.equal(confirmed.operations[0]?.status, "confirmed"); assert.equal(confirmed.budget.attemptsUsed, 1);
 assert.deepEqual(life.confirmLifecycleOperation(confirmed, receipt()), confirmed, "polling del mismo recibo es idempotente");
 assert.throws(() => life.confirmLifecycleOperation(confirmed, receipt("op1", "failed")), /recibo|confirm/);
});

test("resultado confirmado fallido sigue fallido y sólo admite retry explícito enlazado", () => {
 const s = life.confirmLifecycleOperation(reserve(), receipt("op1", "failed"));
 const failed = s.operations[0]; assert.ok(failed?.status === "confirmed"); assert.equal(failed.receipt.outcome, "failed");
 assert.throws(() => reserve(s, intent("op2")));
 const nextIntent = { ...intent("op2"), retryOf: "op1" }; const next = life.reserveLifecycleOperation(s, nextIntent, decision(nextIntent), owner, at);
 assert.equal(next.budget.attemptsUsed, 2); assert.equal(next.operations[1]?.status, "pending");
});

test("límites aceptados cambian sin borrar consumo y cada ronda de corrección cuenta aparte", () => {
 const one = { ...config(), budget: { ...config().budget, maxAttempts: 1 } };
 let s = life.bindLifecycleSubject(life.initializeLifecycle(root, pin(one)), subject(), { id: "confirm", source: "person", at });
 s = life.confirmLifecycleOperation(life.reserveLifecycleOperation(s, intent(), decision(intent(), lifecycleHash(one)), owner, at), receipt("op1", "failed"));
 const retry = { ...intent("op2"), retryOf: "op1" };
 assert.throws(() => life.reserveLifecycleOperation(s, retry, decision(retry, lifecycleHash(one)), owner, at), /presupuesto|intentos/);
 s = life.applyLifecyclePin(s, pin()); assert.equal(s.budget.attemptsUsed, 1);
 s = life.reserveLifecycleOperation(s, retry, decision(retry), owner, at); assert.equal(s.budget.attemptsUsed, 2);
 const lower = life.applyLifecyclePin(s, pin(one)); assert.equal(lower.budget.attemptsUsed, 2, "bajar límite no vuelve inválido el consumo histórico");
 let corrections = { ...ready(), stage: "corrections" };
 for (let n = 1; n <= 2; n++) {
  const id = `correction-${n}`; const subj = { ...subject(id), headSha: String(n).repeat(40) };
  corrections = life.bindLifecycleSubject(corrections, subj, { id, source: "person", at }); const i = intent(id, "correction", id);
  corrections = life.confirmLifecycleOperation(life.reserveLifecycleOperation(corrections, i, decision(i), owner, at), receipt(id, "succeeded", id));
 }
 const i = intent("correction-3", "correction", "correction-2");
 assert.throws(() => life.reserveLifecycleOperation(corrections, i, decision(i), owner, at), /rondas/);
 assert.equal(corrections.budget.roundsUsed, 2); assert.equal(workflow().round, 0);
});

test("PR43 conserva raíz42 y consumo, y fix-forward tiene su propio límite global", () => {
 const target = defaultLifecycleTarget({ id: "release", provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" }, evidence: { kind: "github-release", assets: ["app.tar.gz"], checksumsAsset: "checksums.txt" }, onFailure: { action: "fix-forward", mode: "ask" } }); assert.ok("target" in target);
 const block = { ...config(), ship: { status: "configured" as const, targets: [target.target] } }; const hash = lifecycleHash(block);
 let s = { ...life.bindLifecycleSubject(life.initializeLifecycle(root, pin(block)), { ...subject("merge42"), mergedSha: "d".repeat(40) }, { id: "merge-observed", source: "person", at }), stage: "ship" };
 const i = { ...intent("recovery", "fix-forward", "merge42"), targetId: "release" }; s = life.confirmLifecycleOperation(life.reserveLifecycleOperation(s, i, decision(i, hash), owner, at), { ...receipt("recovery", "succeeded", "merge42"), targetId: "release" });
 s = life.bindLifecycleSubject(s, subject("pr43", 43), { id: "owned43", source: "publication", at });
 assert.deepEqual(s.root, root); assert.equal(s.budget.fixForwardPRsUsed, 1); assert.equal(s.budget.attemptsUsed, 1);
 s = { ...s, stage: "ship" }; s = life.bindLifecycleSubject(s, { ...subject("merge43", 43), mergedSha: "e".repeat(40) }, { id: "merge43", source: "person", at });
 const again = { ...intent("recovery2", "fix-forward", "merge43"), targetId: "release" }; assert.throws(() => life.reserveLifecycleOperation(s, again, decision(again, hash), owner, at), /fix-forward|recuperación/);
});

test("tiempo activo en milisegundos: espera humana excluida, checkpoints no se duplican ni atrasan", () => {
 let s = life.beginLifecycleActivity(ready(), "segment1", owner);
 s = life.checkpointLifecycleActivity(s, "segment1", owner, 100, "human-wait");
 s = life.checkpointLifecycleActivity(s, "segment1", owner, 10000, "active");
 s = life.checkpointLifecycleActivity(s, "segment1", owner, 10100, "closed");
 assert.equal(s.budget.activeMilliseconds, 200);
 assert.deepEqual(life.checkpointLifecycleActivity(s, "segment1", owner, 10100, "closed"), s);
 assert.throws(() => life.checkpointLifecycleActivity(s, "segment1", owner, 10, "closed"));
 assert.throws(() => life.beginLifecycleActivity(s, "segment1", owner));
 const interrupted = life.beginLifecycleActivity(s, "segment2", owner);
 assert.throws(() => life.reserveLifecycleOperation(interrupted, intent(), decision(), "process-b", at), /actividad|reconcili/);
 assert.throws(() => life.checkpointLifecycleActivity(interrupted, "segment2", "process-b", 0, "closed"));
});

test("ledger dedup por origen sin borrar ediciones ni confundir texto igual con mismo hallazgo", () => {
 let s = life.ingestLifecycleFinding(observed(), finding()); const hash = s.ledger[0]?.observations[0]?.hash;
 assert.equal(s.ledger.length, 1); assert.deepEqual(life.ingestLifecycleFinding(s, { ...finding("ignored"), at: "later" }), s);
 s = life.ingestLifecycleFinding(s, { ...finding(), text: "Hallazgo editado", resolved: true, outdated: true });
 assert.equal(s.ledger.length, 1); assert.equal(s.ledger[0]?.observations.length, 2); assert.equal(s.ledger[0]?.observations[0]?.hash, hash);
 assert.ok(life.lifecycleFindingBlocks(s).length > 0, "resolved/outdated no corrige");
 s = life.ingestLifecycleFinding(s, finding("finding2", "comment2")); assert.equal(s.ledger.length, 2);
 assert.throws(() => life.ingestLifecycleFinding(s, { ...finding(), operationId: "inventado" }));
});

test("disposición corregido/refutado exige evidencia host vigente y no aprueba checks ni GitHub", () => {
 let s = life.ingestLifecycleFinding(observed(), finding()); const hash = s.ledger[0]!.observations[0]!.hash;
 const disposition = { findingId: "finding1", subjectId: "head-1", observationHash: hash, status: "refuted-with-evidence", reason: "El caso ya se cubre", evidenceIds: ["proof1"], at };
 assert.throws(() => life.disposeLifecycleFinding(s, disposition));
 s = life.registerLifecycleEvidence(s, { id: "proof1", subjectId: "head-1", operationId: "op1", kind: "refutation", outcome: "pass", at });
 s = life.disposeLifecycleFinding(s, disposition); assert.deepEqual(life.lifecycleFindingBlocks(s), []); assert.deepEqual(s.checks, []); assert.deepEqual(s.approvals, []);
 s = life.bindLifecycleSubject(s, { ...subject("head-2"), headSha: "d".repeat(40) }, { id: "new-head", source: "person", at });
 assert.ok(life.lifecycleFindingBlocks(s).length > 0, "evidencia vieja no acredita otro SHA/base/contenido");
 assert.equal(s.ledger[0]?.dispositions.length, 1);
});

test("parsear rechaza contadores/IDs/referencias/hash incoherentes y preserva disabled legacy", () => {
 const state = { ...workflow(), lifecycle: reserve() }; assert.equal(parseWorkflow(JSON.stringify(state)).version, 2);
 for (const changed of [{ ...state.lifecycle, budget: { ...state.lifecycle.budget, attemptsUsed: 0 } }, { ...state.lifecycle, operations: [...state.lifecycle.operations, ...state.lifecycle.operations] }, { ...state.lifecycle, root: { ...root, workflowId: "other" } }, { ...state.lifecycle, pinHash: "f".repeat(64) }]) assert.throws(() => parseWorkflow(JSON.stringify({ ...state, lifecycle: changed })));
 assert.deepEqual(parseWorkflow(JSON.stringify(workflow())).lifecycle, { status: "disabled" });
});

test("store conserva consumo entre reload/refresh/replan y rechaza resets o borrado de journal", async t => {
 const base = await stored(t); const initial = await readWorkflow(base.checkout, 42); assert.ok(initial);
 const saved = await updateWorkflow(base.checkout, 42, initial.revision, s => { assert.ok(s?.version === 2); return { ...s, revision: s.revision + 1, lifecycle: reserve(s.lifecycle) }; });
 const reloaded = await readWorkflow(base.checkout, 42); assert.ok(reloaded?.version === 2 && saved.version === 2); assert.deepEqual(reloaded.lifecycle, saved.lifecycle);
 const refreshed = transition(reloaded, { type: "source_changed", source: reloaded.source }, at); assert.deepEqual(refreshed.lifecycle, reloaded.lifecycle);
 const local = structuredClone(reloaded); local.phase = "verify";
 local.exploration = { references: [{ path: "fixture.ts", line: 1, detail: "fixture" }], findings: [], approach: "fixture", missingFoundation: [], dependencies: [], disposition: "continue", reason: "fixture" };
 local.recipe = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "fixture", approach: "fixture", scope: ["fixture"], outOfScope: [], cases: [{ id: "D1", description: "fixture", command: "fixture" }], lenses: [], executor: { mode: "inline", writers: 0 }, route: "direct" };
 local.approval = { sourceHash: local.source.hash, recipeHash: recipeApprovalHash(local), at };
 assert.deepEqual(transition(local, { type: "retry", reason: "fixture" }, at).lifecycle, reloaded.lifecycle);
 assert.deepEqual(transition(local, { type: "agreed", quote: "Fixture del acuerdo humano", summary: "Rehacer receta de fixture", replan: true }, at).lifecycle, reloaded.lifecycle);
 for (const lifecycle of [{ status: "disabled" as const }, ready()]) await assert.rejects(updateWorkflow(base.checkout, 42, reloaded.revision, s => { assert.ok(s?.version === 2); return { ...s, revision: s.revision + 1, lifecycle }; }));
});

test("coordinador persiste pending antes del efecto; respuesta perdida no se ejecuta al retomar", async t => {
 const base = await stored(t); let calls = 0;
 const deps = { checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => 100,
  authorize: async () => decision(), execute: async () => { const saved = await readWorkflow(base.checkout, 42); assert.ok(saved?.version === 2 && saved.lifecycle.status === "enabled"); assert.equal(saved.lifecycle.operations[0]?.status, "pending"); calls++; throw new Error("respuesta perdida"); } };
 await assert.rejects(performLifecycleOperation(deps, intent()), /inciert|unknown/); assert.equal(calls, 1);
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.budget.attemptsUsed, 1); assert.equal(after.lifecycle.operations[0]?.status, "unknown");
 await assert.rejects(performLifecycleOperation({ ...deps, authorize: async () => decision(intent("op2")) }, intent("op2"))); assert.equal(calls, 1);
});

test("reservas concurrentes con misma intención no duplican consumo ni efecto", async t => {
 const base = await stored(t); let calls = 0;
 const deps = { checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => 100, authorize: async () => decision(), execute: async () => { calls++; return receipt(); } };
 const result = await Promise.allSettled([performLifecycleOperation(deps, intent()), performLifecycleOperation(deps, intent())]);
 assert.equal(result.filter(r => r.status === "fulfilled").length, 1); assert.equal(calls, 1);
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.budget.attemptsUsed, 1);
});

test("fallar al persistir reserva, incluso después de rename, jamás ejecuta el efecto", async t => {
 const base = await stored(t); let calls = 0;
 const persist: typeof updateWorkflow = async (...args) => { const next = await updateWorkflow(...args); if (next.version === 2 && next.lifecycle.status === "enabled" && next.lifecycle.operations.length) throw new Error("sync posterior simulado"); return next; };
 const deps = { checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => 100, authorize: async () => decision(), execute: async () => { calls++; return receipt(); }, persist };
 await assert.rejects(performLifecycleOperation(deps, intent())); assert.equal(calls, 0);
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.operations[0]?.status, "pending");
 await assert.rejects(performLifecycleOperation({ ...deps, persist: updateWorkflow }, intent())); assert.equal(calls, 0);
});

test("persistir un segmento activo no permite omitir tiempo conocido ni reabrirlo", async t => {
 const base = await stored(t); let timed = life.beginLifecycleActivity(ready(), "clock", owner);
 timed = life.checkpointLifecycleActivity(timed, "clock", owner, 100, "active");
 const first = await updateWorkflow(base.checkout, 42, 0, saved => { assert.ok(saved?.version === 2); return { ...saved, revision: 1, lifecycle: timed }; });
 const stolen = structuredClone(timed); const segment = stolen.segments[0]; assert.ok(segment); segment.elapsedMilliseconds = 1000; segment.mode = "closed";
 await assert.rejects(updateWorkflow(base.checkout, 42, first.revision, saved => { assert.ok(saved?.version === 2); return { ...saved, revision: saved.revision + 1, lifecycle: stolen }; }), /tiempo|actividad|consumo/);
 const correct = life.checkpointLifecycleActivity(timed, "clock", owner, 1000, "closed");
 const done = await updateWorkflow(base.checkout, 42, first.revision, saved => { assert.ok(saved?.version === 2); return { ...saved, revision: saved.revision + 1, lifecycle: correct }; });
 assert.ok(done.version === 2 && done.lifecycle.status === "enabled"); assert.equal(done.lifecycle.budget.activeMilliseconds, 1000);
});

test("agotar tiempo bloquea otro intento; cambiar límite conserva milisegundos consumidos", () => {
 const block = { ...config(), budget: { ...config().budget, activeSeconds: 60 } };
 let s = life.bindLifecycleSubject(life.initializeLifecycle(root, pin(block)), subject(), { id: "confirm", source: "person", at });
 s = life.checkpointLifecycleActivity(life.beginLifecycleActivity(s, "clock", owner), "clock", owner, 60000, "closed");
 assert.throws(() => life.reserveLifecycleOperation(s, intent(), decision(intent(), lifecycleHash(block)), owner, at), /tiempo/);
 s = life.applyLifecyclePin(s, pin()); assert.equal(s.budget.activeMilliseconds, 60000);
 assert.equal(life.reserveLifecycleOperation(s, intent(), decision(), owner, at).budget.attemptsUsed, 1);
 assert.throws(() => life.bindLifecycleSubject(s, subject("alias-mismo-head"), { id: "another", source: "person", at }), /snapshot/);
});

test("estado cerca de8MB conserva margen para recibos y bloquea antes del efecto", async t => {
 const base = await stored(t); const initial = await readWorkflow(base.checkout, 42); assert.ok(initial);
 const proof = { id: "fixture", kind: "verification" as const, command: "fixture", stepId: null, caseId: null, exitCode: 0, outcome: "passed" as const, output: "x".repeat(12000), fingerprint: "fixture", head: "b".repeat(40), startedAt: at, finishedAt: at };
 let low = 0, high = 1000;
 const candidate = (count: number) => ({ ...initial, revision: 1, evidence: Array.from({ length: count }, (_, i) => ({ ...proof, id: `fixture-${i}` })) });
 while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(candidate(middle), null, 2) + "\n") < 8 * 1024 * 1024 - 8000) low = middle; else high = middle - 1; }
 const large = candidate(low); assert.ok(Buffer.byteLength(JSON.stringify(large, null, 2)) > 8 * 1024 * 1024 - 64000);
 await updateWorkflow(base.checkout, 42, 0, () => large); let calls = 0;
 await assert.rejects(performLifecycleOperation({ checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => 100, authorize: async () => decision(), execute: async () => { calls++; return receipt(); } }, intent()), /espacio|recibo/);
 assert.equal(calls, 0); const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.budget.attemptsUsed, 0);
});

test("espera humana durable y observaciones durante una operación no pierden recibo ni hechos", async t => {
 const base = await stored(t); let clock = 0;
 const execute = async (_state: unknown, _intent: unknown, activity: { setMode: (mode: "active" | "human-wait") => Promise<void> }) => {
  clock = 100; await activity.setMode("human-wait"); clock = 10000; await activity.setMode("active");
  const current = await readWorkflow(base.checkout, 42); assert.ok(current?.lifecycle.status === "enabled");
  await updateWorkflow(base.checkout, 42, current.revision, saved => {
   assert.ok(saved?.version === 2 && saved.lifecycle.status === "enabled");
   return { ...saved, revision: saved.revision + 1, lifecycle: { ...saved.lifecycle, checks: [...saved.lifecycle.checks, { id: "check1", subjectId: "head-1", context: "ci", appId: 1, state: "success", externalId: "run1", at }] } };
  });
  clock = 10100; return receipt();
 };
 await performLifecycleOperation({ checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => clock, authorize: async () => decision(), execute }, intent());
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled");
 assert.equal(after.lifecycle.budget.activeMilliseconds, 200); assert.equal(after.lifecycle.checks.length, 1); assert.equal(after.lifecycle.operations[0]?.status, "confirmed");
});

test("callback in-place no puede borrar consumo/journal ni cambiar identidad", async t => {
 const base = await stored(t);
 const first = await updateWorkflow(base.checkout, 42, 0, saved => { assert.ok(saved?.version === 2); saved.lifecycle = reserve(saved.lifecycle); saved.revision++; return saved; });
 await assert.rejects(updateWorkflow(base.checkout, 42, first.revision, saved => { assert.ok(saved?.version === 2); saved.lifecycle = ready(); saved.revision++; return saved; }), /historia|journal|reinicia/);
 await assert.rejects(updateWorkflow(base.checkout, 42, first.revision, saved => { assert.ok(saved); saved.id = "otra-identidad"; saved.revision++; return saved; }), /identidad/);
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.budget.attemptsUsed, 1);
});

test("ledger registra A→B→A y cada transición de disposición sin reciclar la vigencia anterior", () => {
 let s = life.ingestLifecycleFinding(observed(), finding());
 s = life.ingestLifecycleFinding(s, { ...finding(), text: "Versión B", at: "later" });
 s = life.registerLifecycleEvidence(s, { id: "proof", subjectId: "head-1", operationId: "op1", kind: "refutation", outcome: "pass", at });
 const disposition = { findingId: "finding1", subjectId: "head-1", observationHash: s.ledger[0]!.observations.at(-1)!.hash, status: "refuted-with-evidence", reason: "Evidencia para B", evidenceIds: ["proof"], at };
 s = life.disposeLifecycleFinding(s, disposition); assert.deepEqual(life.lifecycleFindingBlocks(s), []);
 s = life.ingestLifecycleFinding(s, { ...finding(), at: "later-again" });
 assert.equal(s.ledger[0]?.observations.length, 3); assert.ok(life.lifecycleFindingBlocks(s).length > 0);
 const forA = { ...disposition, observationHash: s.ledger[0]!.observations.at(-1)!.hash, reason: "Evidencia para A" };
 s = life.disposeLifecycleFinding(s, forA);
 s = life.disposeLifecycleFinding(s, { ...forA, status: "human-required", evidenceIds: [], reason: "Una duda nueva" });
 s = life.disposeLifecycleFinding(s, forA);
 assert.equal(s.ledger[0]?.dispositions.at(-1)?.status, "refuted-with-evidence"); assert.deepEqual(life.lifecycleFindingBlocks(s), []);
});

test("trabajo activo de autorización consume tiempo y bloquea efecto al agotar presupuesto", async t => {
 const base = await stored(t); const block = { ...config(), budget: { ...config().budget, activeSeconds: 60 } };
 let s = life.applyLifecyclePin(ready(), pin(block)); s = life.checkpointLifecycleActivity(life.beginLifecycleActivity(s, "prev", owner), "prev", owner, 59000, "closed");
 await updateWorkflow(base.checkout, 42, 0, saved => { assert.ok(saved?.version === 2); return { ...saved, revision: 1, lifecycle: s }; });
 let clock = 0, calls = 0;
 await assert.rejects(performLifecycleOperation({ checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => clock,
  authorize: async () => { clock = 10000; return decision(intent(), lifecycleHash(block)); }, execute: async () => { calls++; clock++; return receipt(); } }, intent()), /tiempo/);
 assert.equal(calls, 0); const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.budget.activeMilliseconds, 69000);
});

test("margen de recibos no puede gastarse en escrituras intermedias del store", async t => {
 const base = await stored(t);
 const execute = async () => {
  const current = await readWorkflow(base.checkout, 42); assert.ok(current);
  const proof = { id: "fixture", kind: "verification" as const, command: "fixture", stepId: null, caseId: null, exitCode: 0, outcome: "passed" as const, output: "x".repeat(12000), fingerprint: "fixture", head: "b".repeat(40), startedAt: at, finishedAt: at };
  let low = 0, high = 1000;
  const candidate = (count: number) => ({ ...current, revision: current.revision + 1, evidence: Array.from({ length: count }, (_, i) => ({ ...proof, id: `proof-${i}` })) });
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(candidate(middle), null, 2) + "\n") <= 8 * 1024 * 1024 - 1000) low = middle; else high = middle - 1; }
  const full = candidate(low); assert.ok(Buffer.byteLength(JSON.stringify(full, null, 2)) > 8 * 1024 * 1024 - 32000);
  await assert.rejects(updateWorkflow(base.checkout, 42, current.revision, () => full), /recibo|espacio/);
  return receipt();
 };
 await performLifecycleOperation({ checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => 100, authorize: async () => decision(), execute }, intent());
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled"); assert.equal(after.lifecycle.operations[0]?.status, "confirmed");
});

test("unknown reserva espacio de historial para confirmar sin recortar entradas", () => {
 let s = life.markLifecycleUnknown(reserve(), "op1", "primera duda", at); const op = s.operations[0]; assert.ok(op?.status === "unknown");
 op.history = [{ status: "pending", at }, ...Array.from({ length: 998 }, () => ({ status: "unknown" as const, at }))];
 assert.throws(() => life.markLifecycleUnknown(s, "op1", "otra duda", "later"), /historial|recibo/);
 s = life.confirmLifecycleOperation(s, receipt()); assert.equal(s.operations[0]?.history.length, 1000); assert.equal(s.operations[0]?.status, "confirmed");
});

test("autorización distingue espera humana de sus lecturas activas y conserva ambos checkpoints", async t => {
 const base = await stored(t); let clock = 0;
 const authorize = async (_state: unknown, _intent: unknown, activity: { setMode: (mode: "active" | "human-wait") => Promise<void> }) => {
  clock = 10; await activity.setMode("human-wait"); clock = 100000; await activity.setMode("active"); clock = 100010; return decision();
 };
 await performLifecycleOperation({ checkout: base.checkout, issue: 42, owner, now: () => at, monotonic: () => clock, authorize, execute: async () => { clock = 100020; return receipt(); } }, intent());
 const after = await readWorkflow(base.checkout, 42); assert.ok(after?.lifecycle.status === "enabled");
 assert.equal(after.lifecycle.budget.activeMilliseconds, 30); assert.equal(after.lifecycle.budget.attemptsUsed, 1); assert.equal(after.lifecycle.segments[0]?.mode, "closed");
});
