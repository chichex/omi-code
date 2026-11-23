// Después del PR draft el agente no corre Review, Land ni Ship: se los pasa a la persona como comandos /omi-work,
// con el próximo paso del estado. Caso real: «corré las reviews con GHA» terminó en comandos de terminal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { sourceHash, type Evidence, type Plan, type WorkflowV2 } from "../src/harness/model.ts";
import { lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { adoptPostPrWorkflow } from "../src/harness/lifecycle-corrections.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import { afterDraftCheckError, afterDraftToolBlock } from "../src/harness/after-draft-guide.ts";
import { AT, lifecycleConfig } from "./helpers/lifecycle.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";

const repo = "acme/app", base = "a".repeat(40), head = "b".repeat(40), fingerprint = "c".repeat(64);
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Feature", approach: "Extend", scope: ["app"], outOfScope: ["infra"], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const send = (r: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(r, event, AT);
const evidence = (kind: Evidence["kind"]): Evidence => ({ id: kind, kind, stepId: ["red", "green"].includes(kind) ? "C1" : null, caseId: "D1", command: "npm test", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "observed", head, fingerprint, startedAt: AT, finishedAt: AT });
function draft(): WorkflowV2 {
 let r = createWorkflow({ number: 42, title: "Feature", body: "Scope", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Feature", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", AT);
 r = send(r, { type: "explored", exploration: { references: [{ path: "app.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" } }); r = send(r, { type: "inferences", inferences: [] }); r = send(r, { type: "planned", plan }); r = send(r, { type: "approved" }); r = send(r, { type: "step_started", id: "C1" });
 r = send(r, { type: "evidence", evidence: evidence("red") }); r = send(r, { type: "evidence", evidence: evidence("green") }); r = send(r, { type: "step_completed", id: "C1", commit: head, fingerprint }); r = send(r, { type: "evidence", evidence: evidence("verification") }); r = send(r, { type: "verified", fingerprint });
 r = send(r, { type: "publishing", head, bodyHash: "body" }); return send(r, { type: "published", head, url: `https://github.com/${repo}/pull/42`, number: 42 });
}
const subject = { id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: fingerprint, mergedSha: null };
function adopted(change?: Parameters<typeof lifecycleConfig>[1]): WorkflowV2 {
 const block = lifecycleConfig(repo, change);
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: AT, acceptedAt: AT } };
 return adoptPostPrWorkflow(draft(), pin, subject, { id: "adopt", source: "person", at: AT });
}
/** Review confirmada con un hallazgo pendiente, sin la Review observada en esta sesión. */
function reviewed(change?: Parameters<typeof lifecycleConfig>[1]): WorkflowV2 {
 const r = adopted(change); assert.ok(r.lifecycle.status === "enabled");
 let s = life.reserveLifecycleOperation(r.lifecycle, { id: "review1", key: "review1", kind: "review", subjectId: "subject", targetId: null, correlationId: "review-correlation-1", retryOf: null }, { id: "review-decision", kind: "review", subjectId: "subject", targetId: null, configHash: r.lifecycle.pinHash, source: "person", at: AT }, "process", AT);
 s = life.confirmLifecycleOperation(s, { operationId: "review1", correlationId: "review-correlation-1", subjectId: "subject", targetId: null, verifiedSubjectId: "subject", externalId: "github:42", outcome: "succeeded", at: AT });
 s = life.ingestLifecycleFinding(s, { id: "F1", provider: "github", externalId: "501", operationId: "review1", subjectId: "subject", text: "Falta manejar el error", severity: "unknown", resolved: false, outdated: false, at: AT });
 return { ...r, lifecycle: s };
}
const next = (text: string) => /Próximo paso para la persona: ([^\n]*)/.exec(text)?.[1];

test("PR draft abierto: Review, Land y Ship son /omi-work adopt y /omi-work review, nunca workflows ni terminal", () => {
 const text = developmentInstructions(draft());
 assert.match(text, /\/omi-work adopt/); assert.match(text, /\/omi-work review/);
 assert.match(text, /GHA[^.\n]*\/omi-work review/, "una Review con GHA también es /omi-work review");
 assert.match(text, /No dispares workflows/);
 assert.match(text, /ni le pases comandos de terminal/);
 assert.equal(next(text), "corré /omi-work adopt y después /omi-work review; si la continuidad está configurada, adopt ya sigue con la Review.");
});

test("PR adoptado: el próximo paso sale del estado guardado, sin repetir la Review", () => {
 const fresh = developmentInstructions(adopted());
 assert.match(fresh, /\/omi-work review \| fix \| land \| ship/);
 assert.match(fresh, /No dispares workflows/);
 assert.equal(next(fresh), "corré /omi-work review.");
 assert.equal(next(developmentInstructions(reviewed())), "corré /omi-work fix; usa los hallazgos ya registrados.", "con hallazgos registrados no pide otra Review");
});

test("stack publicado: la guía no manda a /omi-work adopt ni review, que no adoptan stacks", () => {
 const r = draft(); assert.ok(r.publication.status === "opened");
 const pull = (index: number, base: string) => ({ title: `Parte ${index}`, steps: ["C1"], branch: `feat/work-${index}`, base, head, number: 40 + index, url: `https://github.com/${repo}/pull/${40 + index}`, status: "draft" as const });
 const stacked: WorkflowV2 = { ...r, publication: { ...r.publication, stack: [pull(1, "main"), pull(2, "feat/work-1")] } };
 const texts = { instrucciones: developmentInstructions(stacked), bash: afterDraftToolBlock(stacked, "bash"), check: afterDraftCheckError(stacked) };
 for (const [where, text] of Object.entries(texts)) {
  assert.doesNotMatch(text, /\/omi-work (adopt|review)/, where);
  assert.match(text, /el lifecycle no adopta stacks/i, where);
  assert.match(text, /No dispares workflows|no dispara workflows/, where);
  assert.equal(next(text), "mergealos en orden con su sí.", where);
 }
 assert.match(texts.instrucciones, /omi_workflow action stack/, "conserva cómo sincronizar el stack");
});

test("con una pausa vigente, el próximo paso es el de la pausa", () => {
 const paused = { ...adopted(), continuityPause: { reason: "declined", stage: "review", subjectId: "subject", at: AT } } as WorkflowV2;
 const text = developmentInstructions(paused);
 assert.match(text, /Continuidad en pausa · Dijiste que no a seguir con Review: cuando quieras, \/omi-work review/);
 assert.equal(next(text), "cuando quieras, /omi-work review.");
});

test("PR adoptado con la continuidad de fix: el push lo hace la cadena, sin pedir /omi-work fix", () => {
 for (const fix of ["auto", "ask"] as const) {
  const text = developmentInstructions(adopted(block => { block.continuity = { ...autoContinuity, fix }; }));
  assert.doesNotMatch(text, /pedile a la persona \/omi-work fix/, fix);
  assert.match(text, /verified, la continuidad hace el push al mismo PR/, fix);
 }
 for (const change of [undefined, (block: Parameters<NonNullable<Parameters<typeof lifecycleConfig>[1]>>[0]) => { block.continuity = { ...autoContinuity, fix: "manual" }; }]) {
  assert.match(developmentInstructions(adopted(change)), /verified, pedile a la persona \/omi-work fix para el push al mismo PR/);
 }
});

test("bash bloqueado después del draft: el motivo guía a /omi-work y al próximo paso, no a omi_workflow_check", async t => {
 const { f } = await continuityFixture(t, { historical: true });
 assert.equal((await f.state()).phase, "done");
 const block = (await f.emit("tool_call", { toolName: "bash", input: { command: "gh workflow run claude-review.yml -f pr=42" } })) as { block?: boolean; reason?: string } | undefined;
 assert.equal(block?.block, true);
 const reason = block?.reason ?? "";
 assert.doesNotMatch(reason, /Usá omi_workflow y omi_workflow_check/);
 assert.match(reason, /después del PR draft/); assert.match(reason, /No dispares workflows/);
 assert.equal(next(reason), "corré /omi-work adopt y después /omi-work review; si la continuidad está configurada, adopt ya sigue con la Review.");
 await f.command("adopt");
 const adoptedReason = ((await f.emit("tool_call", { toolName: "bash", input: { command: "gh pr merge 42" } })) as { reason?: string } | undefined)?.reason ?? "";
 assert.match(adoptedReason, /\/omi-work review \| fix \| land \| ship/);
 assert.equal(next(adoptedReason), "corré /omi-work review.");
});

test("PR adoptado en Abrir PR draft: la guía de la etapa no manda a publish", () => {
 const state = adopted(block => { block.continuity = { ...autoContinuity }; });
 const text = developmentInstructions({ ...state, phase: "pr" });
 assert.doesNotMatch(text, /Usá publish ahora/);
 assert.match(text, /verified, la continuidad hace el push al mismo PR/);
});

test("publish con el PR adoptado y fix en la continuidad: no pide /omi-work fix para el push", async t => {
 const { f } = await continuityFixture(t, { historical: true, change: block => { block.continuity = { ...autoContinuity, entry: "manual", review: "manual" }; } });
 await f.command("adopt");
 assert.equal((await f.state()).phase, "review");
 await assert.rejects(f.action({ action: "publish" }), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /^El PR ya es del lifecycle/);
  assert.doesNotMatch(error.message, /con \/omi-work fix/);
  assert.match(error.message, /la continuidad hace el push al mismo PR/);
  return true;
 });
});
