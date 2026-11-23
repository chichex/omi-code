import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { assessCorrectionScope, correctionScopeMatches } from "../src/tui/development-correction-scope.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";
import type { WorkflowV2 } from "../src/harness/model.ts";
import { disposeLifecycleFinding } from "../src/harness/lifecycle-state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DevelopmentSession } from "../src/tui/development-session.ts";
import { fixLifecycle } from "../src/tui/development-lifecycle-fix.ts";
import { testIo } from "./helpers/io.ts";

test("fix host auto abre C por política observada y conserva TDD, sin push", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: b => {
  b.continuity = { ...autoContinuity, review: "manual", fix: "manual" }; b.review.mode = "auto"; b.corrections.mode = "auto";
 } });
 gh.inline.push({ id: 501, body: "Cubrir manejo de error del valor", commit_id: head, path: "value.cjs", line: 1 });
 await f.command("adopt"); await f.command("review");
 Reflect.set(f.context, "model", { provider: "mock", id: "mock", contextWindow: 200000 });
 Reflect.set(f.context.modelRegistry, "streamSimple", (_model: unknown, context: { tools: unknown[]; messages: { content: { text: string }[] }[] }, options: { toolChoice: string; cacheRetention: string }) => {
  assert.deepEqual(context.tools, []); assert.equal(options.toolChoice, "none"); assert.equal(options.cacheRetention, "none");
  const prompt = JSON.parse(context.messages[0]!.content[0]!.text) as { material: string; findings: { id: string }[] };
  assert.match(prompt.material, /diff --git/);
  return { result: async () => ({ role: "assistant", provider: "mock", model: "mock", stopReason: "stop", usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: JSON.stringify({ verdict: "pass", findings: prompt.findings.map(f => ({ id: f.id, withinScope: true, risk: "low", humanRequired: false, reason: "Manejo del valor aprobado en el código actual" })) }) }] }) };
 });
 // Segunda instancia real del host sobre el mismo estado durable; sin pedir que el fixture exponga privados.
 const pi = { appendEntry: (type: string, data: unknown) => f.manager.appendCustomEntry(type, data), events: { emit: () => {} } } as unknown as ExtensionAPI;
 const session = new DevelopmentSession(pi, testIo({ homeDir: f.home, cwd: f.checkout.root }), [], { runner: f.runner });
 await session.restore(f.context);
 assert.equal(await fixLifecycle(session, f.context, { source: "chain" }), true);
 const state = session.current(f.context); assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
 assert.equal(state.phase, "implement"); assert.equal(state.lifecycle.budget.roundsUsed, 1);
 assert.equal(state.lifecycle.corrections?.at(-1)?.scopeSource, "policy");
 assert.match(state.lifecycle.corrections?.at(-1)?.authorityHash ?? "", /^[a-f0-9]{64}$/);
 assert.equal(state.steps.at(-1)?.red, null); assert.equal(state.steps.at(-1)?.commit, null);
 assert.equal(f.prompts.filter(p => /Corregir .*hallazgo/.test(p)).length, 0);
 assert.deepEqual(gh.mutations, []); assert.equal(f.remote.pushed.size, 0);
});

for (const verdict of ["pass", "unknown", "high-risk", "out-of-scope", "cancel", "invalid", "human-required", "stale", "changed"] as const) {
 test(`scope auto: ${verdict} sólo hechos actuales completos habilitan ronda`, async t => {
  const { f, gh, head } = await continuityFixture(t, { historical: true, change: b => {
   b.continuity = { ...autoContinuity, review: "manual", fix: "manual" }; b.review.mode = "auto"; b.corrections.mode = "auto";
  } });
  gh.inline.push({ id: 501, body: "Cubrir error del valor aprobado", commit_id: head, path: "value.cjs", line: 1 });
  await f.command("adopt"); await f.command("review");
  const original = await f.state(); assert.ok(original.version === 2 && original.lifecycle.status === "enabled");
  const state: WorkflowV2 = structuredClone(original), s = state.lifecycle; assert.ok(s.status === "enabled");
  if (verdict === "human-required") {
   const finding = s.ledger[0]!, observation = finding.observations.at(-1)!;
   const disposed = disposeLifecycleFinding(s, { findingId: finding.id, subjectId: s.currentSubject!, observationHash: observation.hash, status: "human-required", evidenceIds: [], reason: "Decisión humana pendiente", at: observation.at });
   s.ledger = disposed.ledger;
  }
  if (verdict === "stale") s.ledger[0]!.observations.at(-1)!.subjectId = "old-head";
  const signal = new AbortController(); let calls = 0;
  if (verdict === "cancel") signal.abort();
  const prompt = "diff íntegro del checkout aprobado";
  const result = await assessCorrectionScope(state, {
   model: { provider: "mock", id: "mock", contextWindow: 200000 }, signal: signal.signal, timeoutSeconds: 60,
   snapshot: async () => ({ head, fingerprint: verdict === "changed" ? "0".repeat(64) : s.subjects.at(-1)!.contentHash, clean: true }),
   material: async () => ({ prompt, materialHash: createHash("sha256").update(prompt).digest("hex"), complete: true, diffBaseSha: "a".repeat(40), fileCount: 1 }),
   call: async (context) => {
    calls++; assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1);
    assert.match(context.systemPrompt ?? "", /datos/); assert.match(JSON.stringify(context), /Devolver 2/);
    const assessment = { verdict: verdict === "unknown" ? "unknown" : "pass", findings: s.ledger.map(finding => ({ id: finding.id, withinScope: verdict !== "out-of-scope", risk: verdict === "high-risk" ? "high" : "low", humanRequired: false, reason: "La corrección corresponde al valor aprobado, sin cambios de infraestructura" })) };
    return { role: "assistant", provider: "mock", model: "mock", stopReason: "stop", content: [{ type: "text", text: verdict === "invalid" ? '{"verdict":"pass","findings":[]}' : JSON.stringify(assessment) }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0 } };
   },
  });
  assert.equal(result.status, verdict === "pass" ? "safe" : "paused");
  if (result.status === "safe") {
   assert.match(result.authorityHash, /^[a-f0-9]{64}$/); assert.equal(correctionScopeMatches(state, result), true);
   const altered = structuredClone(state); altered.recipe!.scope.push("infra"); assert.equal(correctionScopeMatches(altered, result), false);
   const changedGroup = structuredClone(state); assert.ok(changedGroup.lifecycle.status === "enabled"); changedGroup.lifecycle.ledger[0]!.observations.at(-1)!.sequence++;
   assert.equal(correctionScopeMatches(changedGroup, result), false);
  }
  if (["human-required", "stale", "cancel", "changed"].includes(verdict)) assert.equal(calls, 0);
  assert.equal(s.corrections?.length ?? 0, 0); assert.deepEqual(gh.mutations, []); assert.equal(f.remote.pushed.size, 0);
 });
}
