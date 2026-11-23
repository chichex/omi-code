import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLifecycleConfig, checkLifecycleConfig, lifecycleHash, parseLifecycleConfig, renderLifecycleBlock } from "../src/harness/lifecycle-config.ts";
import { initializeLifecycle, bindLifecycleSubject, reserveLifecycleOperation, confirmLifecycleOperation, ingestLifecycleFinding } from "../src/harness/lifecycle-state.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash } from "../src/harness/model.ts";
import type { ContinuityInput } from "../src/harness/lifecycle-continuity.ts";

const modulePath = "../src/harness/lifecycle-continuity.ts";
const module = await import(modulePath).catch((error: NodeJS.ErrnoException) => {
 if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
 return null;
});
// Pre-implementation fallback: behavioral mismatch instead of an import crash.
const select = (input: ContinuityInput) => module?.selectLifecycleContinuation(input) ?? { kind: "pause", reason: "not-implemented" };
const repo = "acme/app", at = "2026-01-01T00:00:00Z";
const allAuto = { entry: "auto", review: "auto", fix: "auto", land: "auto", ship: "auto" } as const;
const legacy = () => defaultLifecycleConfig(repo, "main");
const config = () => ({ ...legacy(), continuity: { ...allAuto } });
function workflow() {
 const source = { number: 81, title: "Continuity", body: "Pedido", hash: sourceHash("Continuity", "Pedido"), url: `https://github.com/${repo}/issues/81` };
 const w = createWorkflow(source, { root: "/repo", commonDir: "/repo/.git", branch: "feat/work", baseCommit: "a".repeat(40) }, "work81", at);
 return { ...w, phase: "pr" as const, publication: { status: "opened" as const, number: 82, head: "b".repeat(40), url: `https://github.com/${repo}/pull/82` } };
}
function input(): ContinuityInput {
 const w = workflow(), block = config();
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "perillas", author: "Ada", date: at, acceptedAt: at } };
 const lifecycle = bindLifecycleSubject(initializeLifecycle({ workflowId: w.id, issue: 81, repo }, pin), { id: "head1", repo, number: 82, branch: "feat/work", base: "main", headSha: "b".repeat(40), baseSha: "a".repeat(40), contentHash: "c".repeat(64), mergedSha: null }, { id: "adopt1", source: "publication", at });
 return { workflow: { ...w, phase: "review", lifecycle }, config: block, trigger: "advance", reviewObserved: null };
}
function enabled(i: ContinuityInput) { const s = i.workflow.lifecycle; assert.ok(s?.status === "enabled"); return s; }
function reviewed(): ContinuityInput {
 const i = input(), s = enabled(i);
 const intent = { id: "review1", key: "review1", kind: "review", subjectId: "head1", targetId: null, correlationId: "correlation1", retryOf: null };
 let next = reserveLifecycleOperation(s, intent, { id: "decision1", kind: "review", subjectId: "head1", targetId: null, configHash: s.pinHash, source: "person", at }, "owner", at);
 next = confirmLifecycleOperation(next, { operationId: "review1", correlationId: "correlation1", subjectId: "head1", targetId: null, externalId: "external1", outcome: "succeeded", verifiedSubjectId: "head1", at });
 return { ...i, workflow: { ...i.workflow, lifecycle: next }, reviewObserved: { operationId: "review1", subjectId: "head1" } };
}
function action(i: ContinuityInput, expected: string, mode = "auto", stage = expected) {
 assert.deepEqual(select(i), { kind: "action", action: expected, stage, mode });
}
function pause(i: ContinuityInput, reason: string) { assert.equal(select(i).kind, "pause"); assert.equal(select(i).reason, reason); }
function finding(i: ContinuityInput) {
 i.workflow.lifecycle = ingestLifecycleFinding(enabled(i), { id: "finding1", provider: "local", externalId: "f1", operationId: "review1", subjectId: "head1", text: "Fix error", severity: "medium", resolved: false, outdated: false, at });
}
const round = () => ({ operationId: "correction1", subjectId: "head1", findings: [], startHead: "b".repeat(40), startFingerprint: "c".repeat(64), scopeHash: "d".repeat(64), scopeSource: "person" as const, evidenceOffset: 0, reviewOffset: 0, at, stepId: "C2" });

test("continuity is optional, complete, closed and independent from effect modes", () => {
 const old = legacy(), hash = lifecycleHash(old);
 const parsed = parseLifecycleConfig(renderLifecycleBlock(old), repo);
 assert.equal(parsed.status, "valid");
 if (parsed.status === "valid") { assert.equal(parsed.hash, hash); assert.equal(Object.hasOwn(parsed.block, "continuity"), false); }
 for (const mode of ["auto", "ask", "manual"] as const) {
  const continuity = { entry: mode, review: mode, fix: mode, land: mode, ship: mode };
  const result = checkLifecycleConfig({ ...old, continuity });
  assert.ok("block" in result, `continuity ${mode} must validate`);
  if ("block" in result) { assert.deepEqual(result.block.continuity, continuity); assert.notEqual(lifecycleHash(result.block), hash); }
 }
 for (const continuity of [{}, { ...allAuto, entry: undefined }, { ...allAuto, unexpected: "auto" }, { ...allAuto, fix: "AUTO" }, null]) assert.ok("reason" in checkLifecycleConfig({ ...old, continuity }));
 for (const field of ["review", "corrections", "land"] as const) assert.ok("reason" in checkLifecycleConfig({ ...old, [field]: { ...old[field], mode: "manual" } }));
});

test("legacy stops at draft; opt-in entry needs a newly confirmed publication trigger", () => {
 const i = input(); i.workflow = workflow();
 pause({ ...i, config: legacy(), trigger: "publication-confirmed" }, "manual");
 action({ ...i, trigger: "publication-confirmed" }, "adopt", "auto", "entry");
 pause({ ...i, trigger: "advance" }, "entry-trigger-required");
 i.config = { ...config(), continuity: { ...allAuto, entry: "ask" } };
 action({ ...i, trigger: "publication-confirmed" }, "adopt", "ask", "entry");
 i.workflow.publication = { status: "none" }; pause({ ...i, trigger: "publication-confirmed" }, "publication-required");
});

// Restaurar no es un disparador: el host no llama al selector al cargar (lo cubren los tests de integración con
// session_tree). El tipo no ofrece otro trigger; agregar uno rompe el typecheck de este registro exhaustivo.
test("only a confirmed publication or an explicit advance can trigger continuity", () => {
 const triggers = { "publication-confirmed": true, advance: true } satisfies Record<ContinuityInput["trigger"], true>;
 assert.deepEqual(Object.keys(triggers).sort(), ["advance", "publication-confirmed"]);
});

test("review continuation selects modes without granting effect authorization", () => {
 const i = input(); action(i, "review");
 const s = enabled(i); s.pins[0]!.accepted.block.continuity!.review = "ask"; action(i, "review", "ask");
 s.pins[0]!.accepted.block.continuity!.review = "manual"; pause(i, "manual");
 delete s.pins[0]!.accepted.block.continuity; pause(i, "manual");
 assert.equal(s.pins[0]!.accepted.block.review.mode, "ask");
 assert.equal(s.pins[0]!.accepted.block.corrections.mode, "ask");
});

test("land requires current observed review facts; stale or receipt-only observations stop", () => {
 const i = reviewed(); action(i, "land");
 pause({ ...i, reviewObserved: null }, "review-facts-required");
 pause({ ...i, reviewObserved: { operationId: "review1", subjectId: "old-head" } }, "review-facts-required");
 pause({ ...i, reviewObserved: { operationId: "missing", subjectId: "head1" } }, "review-facts-required");
 const s = enabled(i); s.currentSubject = "new-head"; pause(i, "subject-required");
});

test("unresolved findings select fix, human-required findings pause, no mutation", () => {
 const i = reviewed(); finding(i);
 const before = JSON.stringify(i); action(i, "fix"); assert.equal(JSON.stringify(i), before);
 const f = enabled(i).ledger[0]!;
 f.dispositions.push({ findingId: f.id, subjectId: "head1", observationHash: f.observations[0]!.hash, observationSequence: 1, reason: "needs person", at, status: "human-required", evidenceIds: [] });
 pause(i, "human-required");
});

test("pending/unknown operations are never replayed, failed effects stop", () => {
 for (const status of ["pending", "unknown", "failed"] as const) {
  const i = reviewed(), s = enabled(i), op = s.operations[0]!;
  if (status === "failed" && op.status === "confirmed") op.receipt.outcome = "failed";
  else if (status === "pending") s.operations = [{ ...op, status: "pending" }];
  else if (status === "unknown") s.operations = [{ ...op, status: "unknown", reason: "lost response" }];
  pause(i, status === "failed" ? "operation-failed" : "operation-unsettled");
 }
});

test("existing attempts/time limits stop; rounds limit applies to new fixes only", () => {
 for (const budget of [{ attemptsUsed: 12 }, { activeMilliseconds: 7200000 }]) {
  const i = input(); Object.assign(enabled(i).budget, budget); pause(i, "budget-exhausted");
 }
 const i = reviewed(); enabled(i).budget.roundsUsed = 2; action(i, "land");
 // Ingest against the valid baseline, then project exhausted accounting into the pure selector.
 enabled(i).budget.roundsUsed = 0; finding(i);
 enabled(i).budget.roundsUsed = 2; pause(i, "rounds-exhausted");
});

test("active correction yields model implement/verify; correction PR follows fix, not entry", () => {
 const i = reviewed(), s = enabled(i), r = round();
 s.corrections = [{ ...r, status: "coding" }]; s.stage = "corrections";
 for (const phase of ["implement", "verify"] as const) {
  i.workflow.phase = phase; assert.deepEqual(select(i), { kind: "yield", reason: "correction-model" });
 }
 // Publicar la corrección es push, no otra ronda: el selector lo distingue para el diálogo de continuidad.
 i.workflow.phase = "pr"; action(i, "push", "auto", "fix");
 s.budget.roundsUsed = 2; action(i, "push", "auto", "fix");
 s.corrections = [{ ...r, status: "verified", newSubjectId: "head2", head: "e".repeat(40), fingerprint: "f".repeat(64) }]; action(i, "push", "auto", "fix");
 enabled(i).pins[0]!.accepted.block.continuity!.fix = "ask"; action(i, "push", "ask", "fix");
 enabled(i).pins[0]!.accepted.block.continuity!.fix = "manual"; pause(i, "manual");
 s.corrections = [{ ...r, status: "failed", failedHead: r.startHead, failedFingerprint: r.startFingerprint, reason: "verification failed" }]; pause(i, "correction-failed");
});

test("workflow pauses/blocks and terminal or unconfigured Ship never invent effects", () => {
 const i = input(); i.workflow.status = "paused"; pause(i, "workflow-paused");
 i.workflow.status = "waiting"; pause(i, "workflow-waiting");
 i.workflow.status = "active"; i.workflow.blockedReason = "Need facts"; pause(i, "workflow-blocked");
 i.workflow.blockedReason = ""; const s = enabled(i); s.stage = "paused"; pause(i, "lifecycle-paused");
 s.stage = "ship"; pause(i, "ship-unconfigured");
 s.pins[0]!.accepted.block.ship = { status: "not-applicable", targets: [] }; action(i, "ship");
 for (const stage of ["complete", "delivered"] as const) { s.stage = stage; assert.deepEqual(select(i), { kind: "complete" }); }
});

test("each continuation stage independently honors ask/manual without changing effect policy", () => {
 for (const stage of ["fix", "land", "ship"] as const) {
  const i = reviewed(), s = enabled(i);
  if (stage === "fix") finding(i);
  const current = enabled(i);
  if (stage === "ship") { current.stage = "ship"; current.pins[0]!.accepted.block.ship = { status: "not-applicable", targets: [] }; }
  const block = current.pins[0]!.accepted.block;
  block.continuity![stage] = "ask"; action(i, stage, "ask");
  block.continuity![stage] = "manual"; pause(i, "manual");
  assert.equal(block.corrections.mode, "ask"); assert.equal(block.land.mode, "ask");
  assert.equal(s.budget.attemptsUsed, 1);
 }
});

test("new HEAD requires its own Review, pushed correction never replays fix", () => {
 const i = reviewed(), s = enabled(i), previous = s.subjects[0]!;
 s.subjects.push({ ...previous, id: "head2", headSha: "e".repeat(40) }); s.currentSubject = "head2";
 s.corrections = [{ ...round(), status: "pushed", newSubjectId: "head2", head: "e".repeat(40), fingerprint: "f".repeat(64), pushOperationId: "push1" }];
 action(i, "review");
});

test("last admitted correction can finish model work, but exhausted attempts cannot reserve push", () => {
 const i = reviewed(), s = enabled(i), op = s.operations[0]!, r = round();
 s.stage = "corrections";
 s.corrections = [{ ...r, status: "coding" }];
 s.operations.push({ ...op, id: r.operationId, kind: "correction", status: "pending" });
 s.budget.attemptsUsed = s.pins[0]!.accepted.block.budget.maxAttempts;
 for (const phase of ["implement", "verify"] as const) {
  i.workflow.phase = phase;
  assert.deepEqual(select(i), { kind: "yield", reason: "correction-model" });
 }
 i.workflow.phase = "pr"; pause(i, "budget-exhausted");
 i.workflow.phase = "implement";
 s.budget.activeMilliseconds = s.pins[0]!.accepted.block.budget.activeSeconds * 1000;
 pause(i, "budget-exhausted");
});

test("reobserved corrected findings can reach human confirmation without another round", () => {
 const i = reviewed(); finding(i); const s = enabled(i), f = s.ledger[0]!;
 s.evidence.push({ id: "verified1", subjectId: "head1", operationId: "review1", kind: "verification", outcome: "pass", at });
 f.dispositions.push({ findingId: f.id, subjectId: "old-head", observationHash: f.observations[0]!.hash, observationSequence: 1, reason: "fixed before review", at, status: "corrected", evidenceIds: ["verified1"] });
 s.budget.roundsUsed = s.pins[0]!.accepted.block.corrections.maxRounds;
 action(i, "fix");
 s.evidence = []; pause(i, "rounds-exhausted");
});

test("the reserved coding correction yields without replay; PR continues fix, unknown never does", () => {
 const i = reviewed(), s = enabled(i), r = round(), op = s.operations[0]!;
 s.corrections = [{ ...r, status: "coding" }]; s.stage = "corrections";
 s.operations.push({ ...op, id: r.operationId, kind: "correction", status: "pending" });
 i.workflow.phase = "implement";
 assert.deepEqual(select(i), { kind: "yield", reason: "correction-model" });
 i.workflow.phase = "verify";
 assert.deepEqual(select(i), { kind: "yield", reason: "correction-model" });
 i.workflow.phase = "pr"; action(i, "push", "auto", "fix");
 s.operations[1] = { ...op, id: r.operationId, kind: "correction", status: "unknown", reason: "uncertain" };
 pause(i, "operation-unsettled");
});

// S2.3 · Un stack publicado no entra a la cadena.
const stackPull = (index: number, base: string) => ({ title: `Parte ${index}`, steps: [`C${index}`], branch: `feat/work-${index}`, base, head: String(index).repeat(40),
 number: 80 + index, url: `https://github.com/${repo}/pull/${80 + index}`, status: "draft" as const });
test("a published stack pauses entry as stack-unsupported without offering adopt, whatever entry asks", () => {
 const i = input(), published = workflow(); i.workflow = published;
 const single = published.publication;
 i.workflow.publication = { ...single, stack: [stackPull(1, "main"), stackPull(2, "feat/work-1")] };
 for (const entry of ["auto", "ask"] as const) {
  const selected = select({ ...i, config: { ...config(), continuity: { ...allAuto, entry } }, trigger: "publication-confirmed" });
  assert.deepEqual(selected, { kind: "pause", reason: "stack-unsupported", stage: "entry" }, `entry ${entry}`);
 }
 // Sin stack, la misma publicación sigue ofreciendo la adopción.
 i.workflow.publication = single;
 action({ ...i, trigger: "publication-confirmed" }, "adopt", "auto", "entry");
});

// S2.3 · «Ya corregidos» y Review no observada en la cadena.
test("rounds exhausted: confirming already corrected findings is offered only while some are still pending", () => {
 const i = reviewed(); finding(i);
 // Queda otro hallazgo nuevo, sin corregir.
 i.workflow.lifecycle = ingestLifecycleFinding(enabled(i), { id: "finding2", provider: "local", externalId: "f2", operationId: "review1", subjectId: "head1", text: "Otro error", severity: "medium", resolved: false, outdated: false, at });
 const s = enabled(i), corrected = s.ledger[0]!;
 s.evidence.push({ id: "verified1", subjectId: "head1", operationId: "review1", kind: "verification", outcome: "pass", at });
 corrected.dispositions.push({ findingId: corrected.id, subjectId: "old-head", observationHash: corrected.observations[0]!.hash, observationSequence: 1, reason: "fixed before review", at, status: "corrected", evidenceIds: ["verified1"] });
 s.budget.roundsUsed = s.pins[0]!.accepted.block.corrections.maxRounds;
 action(i, "fix"); // Todavía hay uno ya corregido para confirmar, sin otra ronda.
 // Ya confirmado en el HEAD actual: deja de estar pendiente y no hay ronda para el que queda.
 corrected.dispositions.push({ findingId: corrected.id, subjectId: "head1", observationHash: corrected.observations[0]!.hash, observationSequence: 1, reason: "confirmado por la persona", at, status: "corrected", evidenceIds: ["verified1"] });
 pause(i, "rounds-exhausted");
});

test("a Review not observed in this session names the next step from the findings already recorded", () => {
 const i = reviewed();
 assert.deepEqual(select({ ...i, reviewObserved: null }), { kind: "pause", reason: "review-facts-required", stage: "land" }, "sin hallazgos: Land relee GitHub");
 finding(i);
 assert.deepEqual(select({ ...i, reviewObserved: null }), { kind: "pause", reason: "review-facts-required", stage: "fix" }, "con hallazgos: fix");
 const f = enabled(i).ledger[0]!;
 f.dispositions.push({ findingId: f.id, subjectId: "head1", observationHash: f.observations[0]!.hash, observationSequence: 1, reason: "needs person", at, status: "human-required", evidenceIds: [] });
 pause({ ...i, reviewObserved: null }, "human-required");
 // ready/land también: sin la Review observada no se ofrece Land, pero el próximo paso es Land.
 const ready = reviewed(); enabled(ready).stage = "ready";
 assert.deepEqual(select({ ...ready, reviewObserved: null }), { kind: "pause", reason: "review-facts-required", stage: "land" });
});
