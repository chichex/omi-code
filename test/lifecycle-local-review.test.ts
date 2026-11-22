import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash } from "../src/harness/model.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { reviewLocalChange } from "../src/harness/lifecycle-local-review.ts";
import { createLocalReviewCall } from "../src/tui/development-local-review.ts";
import { fixedReviewMaterial } from "../src/harness/review-material.ts";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { GitHubReadClient } from "../src/harness/lifecycle-github-read.ts";

const repo = "acme/app", at = "2026-01-01T00:00:00Z", nonce = "12345678-1234-4234-8234-123456789abc";
const model = { provider: "fixture", id: "reviewer", contextWindow: 200000 };
const usage = { input: 123, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 168 };
const materialHash = createHash("sha256").update("FULL_DIFF_FIXTURE").digest("hex");
const answer = (value: unknown = { verdict: "pass", findings: [] }) => ({ role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text: JSON.stringify(value) }], usage, stopReason: "stop" });
const finding = { id: "F1", severity: "high", message: "Error reproducible", path: "app.ts", line: 1 };
function root(provider: "local" | "gha" | "github" = "local") {
 const block = defaultLifecycleConfig(repo, "main");
 if (provider === "gha") block.review.provider = { kind: "gha", workflow: "review.yml", ref: "main", contract: "omi-review-v1" };
 if (provider === "github") block.review.provider = { kind: "github", reviewers: ["ada"] };
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let lifecycle = life.initializeLifecycle({ workflowId: "root", issue: 42, repo }, pin);
 lifecycle = life.bindLifecycleSubject(lifecycle, { id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: "b".repeat(40), baseSha: "a".repeat(40), contentHash: "c".repeat(64), mergedSha: null }, { id: "adopt", source: "person", at });
 lifecycle = life.reserveLifecycleOperation(lifecycle, { id: "review-op", key: "review", kind: "review", subjectId: "subject", targetId: null, correlationId: nonce, retryOf: null }, { id: "decision", kind: "review", subjectId: "subject", targetId: null, configHash: lifecycle.pinHash, source: "person", at }, "process", at);
 return { ...createWorkflow({ number: 42, title: "Feature", body: "IMPLEMENTER_CONVERSATION_MUST_NOT_LEAK", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Feature", "IMPLEMENTER_CONVERSATION_MUST_NOT_LEAK") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: "a".repeat(40) }, "root", at), lifecycle };
}
function ports() {
 let calls = 0, claims = 0; let clock = 0;
 return { model, signal: AbortSignal.timeout(5000), timeoutSeconds: 60, now: () => clock,
  beforeReview: async () => {},
  snapshot: async () => ({ repo, pr: 42, headSha: "b".repeat(40), baseSha: "a".repeat(40), contentHash: "c".repeat(64), clean: true }),
  material: async () => ({ prompt: "FULL_DIFF_FIXTURE", materialHash, diffBaseSha: "a".repeat(40), fileCount: 1, complete: true }),
  recordRequest: async () => { claims++; }, call: async (_context: unknown, _options: unknown): Promise<unknown> => { calls++; return answer(); },
  calls: () => calls, claims: () => claims, advance: (ms: number) => { clock += ms; },
 };
}

test("review local usa un contexto nuevo sin conversación/tools/lentes y emite metadata+uso host", async () => {
 const p = ports(); let context: unknown;
 p.call = async (ctx, options) => { context = ctx; assert.ok(options && typeof options === "object" && "signal" in options); return answer(); };
 const result = await reviewLocalChange(root(), "review-op", p);
 assert.equal(result.status, "pass"); assert.ok(result.receipt); assert.equal(result.receipt.provider, "local"); assert.equal(result.receipt.headSha, "b".repeat(40)); assert.equal(result.receipt.baseSha, "a".repeat(40)); assert.equal(result.receipt.materialHash, materialHash);
 assert.deepEqual(result.usage, usage); assert.equal(p.claims(), 1);
 assert.ok(context && typeof context === "object" && "messages" in context && "tools" in context); assert.deepEqual(context.tools, []); assert.ok(Array.isArray(context.messages)); assert.equal(context.messages.length, 1);
 assert.match(JSON.stringify(context), /FULL_DIFF_FIXTURE/); assert.doesNotMatch(JSON.stringify(context), /IMPLEMENTER_CONVERSATION_MUST_NOT_LEAK|lenses|Evidencia observada/);
 assert.equal(root().lifecycle.budget.roundsUsed, 0);
});

for (const provider of ["gha", "github"] as const) test(`fallo de integración ${provider} no hace fallback al reviewer local`, async () => {
 const p = ports(); const result = await reviewLocalChange(root(provider), "review-op", p); assert.equal(result.status, "unknown"); assert.equal(p.calls(), 0); assert.equal(p.claims(), 0);
});

test("material incompleto, muy grande o sin ventana conocida no consume modelo ni acredita fragmentos", async () => {
 for (const problem of ["incomplete", "oversize", "context", "hash"]) {
  const p = ports(); p.material = async () => ({ prompt: problem === "oversize" ? "x".repeat(120001) : "FULL_DIFF_FIXTURE", materialHash: problem === "hash" ? "bad" : materialHash, diffBaseSha: "a".repeat(40), fileCount: 1, complete: problem !== "incomplete" });
  if (problem === "context") p.model = { ...model, contextWindow: 0 };
  assert.equal((await reviewLocalChange(root(), "review-op", p)).status, "unknown"); assert.equal(p.calls(), 0); assert.equal(p.claims(), 0);
 }
});

for (const problem of ["length", "error", "toolUse", "tool-content", "schema", "metadata", "identity", "usage", "duplicate", "empty-findings", "error-message", "raw-length", "endturn"]) test(`salida ${problem} no demuestra revisión completa`, async () => {
 const p = ports(); p.call = async () => {
  const response = answer(problem === "schema" ? { verdict: "pass" } : problem === "metadata" ? { verdict: "pass", findings: [], headSha: "f".repeat(40) } : problem === "duplicate" ? { verdict: "findings", findings: [finding, { ...finding, message: "conflicto" }] } : problem === "empty-findings" ? { verdict: "findings", findings: [] } : undefined);
  if (["length", "error", "toolUse"].includes(problem)) response.stopReason = problem;
  if (problem === "identity") response.model = "other";
  if (problem === "tool-content") return { ...response, content: [{ type: "toolCall", name: "bash", arguments: { command: "NOT_EXECUTED" } }] };
  if (problem === "usage") return { ...response, usage: null };
  if (problem === "error-message") return { ...response, errorMessage: "Falló el proveedor" };
  if (problem === "raw-length") return { ...response, rawStopReason: "max_tokens" };
  if (problem === "endturn") return { ...response, endTurn: false };
  return response;
 };
 assert.equal((await reviewLocalChange(root(), "review-op", p)).status, "unknown");
});

test("pass con hallazgos queda findings, conserva IDs y nunca implica aprobación GitHub", async () => {
 const p = ports(); p.call = async () => answer({ verdict: "pass", findings: [finding, finding] });
 const result = await reviewLocalChange(root(), "review-op", p); assert.equal(result.status, "findings"); assert.deepEqual(result.receipt?.findings, [finding]); assert.equal("githubApproval" in (result.receipt ?? {}), false);
});

test("gate vivo, HEAD sucio/cambiado y deadline pausado no acreditan; el uso observado se conserva", async () => {
 for (const problem of ["gate", "dirty", "changed", "timeout"]) {
  const p = ports(); let modelCompleted = false;
  if (problem === "gate") p.beforeReview = async () => { throw new Error("KB inaccesible/no aceptada"); };
  p.snapshot = async () => ({ repo, pr: 42, headSha: problem === "changed" && modelCompleted ? "f".repeat(40) : "b".repeat(40), baseSha: "a".repeat(40), contentHash: "c".repeat(64), clean: problem !== "dirty" });
  p.call = async () => { modelCompleted = true; if (problem === "timeout") p.advance(61000); return answer(); };
  const result = await reviewLocalChange(root(), "review-op", p); assert.equal(result.status, "unknown");
  if (["timeout", "changed"].includes(problem)) assert.deepEqual(result.usage, usage); else assert.equal(p.claims(), 0);
 }
});

test("una aceptación invalidada durante la lectura del diff impide el claim y el modelo", async () => {
 const p = ports(); let accepted = true; const prepare = p.material;
 p.beforeReview = async () => { if (!accepted) throw new Error("Revisión KB pendiente"); };
 p.material = async () => { const material = await prepare(); accepted = false; return material; };
 const result = await reviewLocalChange(root(), "review-op", p); assert.equal(result.status, "unknown"); assert.equal(p.calls(), 0); assert.equal(p.claims(), 0);
});

test("cancelar devuelve unknown aunque el proveedor no resuelva ni coopere con la señal", async () => {
 const p = ports(), controller = new AbortController(); p.signal = controller.signal; let observedAbort = false;
 p.call = async (_context, options) => { assert.ok(options && typeof options === "object" && "signal" in options && options.signal instanceof AbortSignal); options.signal.addEventListener("abort", () => { observedAbort = true; }); queueMicrotask(() => controller.abort()); return new Promise(() => {}); };
 const result = await Promise.race([reviewLocalChange(root(), "review-op", p), new Promise<"hung">(resolve => setImmediate(() => resolve("hung")))]);
 assert.notEqual(result, "hung", "El host no espera indefinidamente a un SDK que ignoró abort"); assert.ok(result !== "hung"); assert.equal(result.status, "unknown"); assert.equal(observedAbort, true); assert.equal(p.claims(), 1);
});

test("bridge aislado sin uso observado se detecta antes del claim y de invocar el proveedor", async () => {
 const p = ports(); p.model = { ...model, provider: "claude-bridge" };
 const result = await reviewLocalChange(root(), "review-op", p); assert.equal(result.status, "unknown"); assert.equal(p.claims(), 0); assert.equal(p.calls(), 0); assert.match(result.reason, /uso|usage/i);
 assert.throws(() => createLocalReviewCall({ streamSimple: () => { throw new Error("NO INVOCAR"); } }, p.model), /uso|usage/i);
});

test("adaptador Pi llama sólo streamSimple con contexto explícito, cache none y sin AgentSession", async () => {
 let calls = 0;
 const registry = { streamSimple: (_model: unknown, context: unknown, options: unknown) => { calls++; assert.deepEqual(context, { systemPrompt: "external review", messages: [], tools: [] }); assert.ok(options && typeof options === "object" && "cacheRetention" in options && options.cacheRetention === "none"); return { result: async () => answer() }; } };
 const call = createLocalReviewCall(registry, model);
 assert.deepEqual(await call({ systemPrompt: "external review", messages: [], tools: [] }, { signal: AbortSignal.timeout(1000), maxTokens: 8192 }), answer()); assert.equal(calls, 1);
});

// Git temporal real, sin remotos ni configuración global. El material no sale del proceso de test.
test("material local proviene del SHA fijo completo y el claim privado sobrevive reload sin repetir modelo", async t => {
 const dir = await realpath(await mkdtemp(join(tmpdir(), "omi-local-review-"))); t.after(() => rm(dir, { recursive: true, force: true }));
 const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" } }).trim();
 git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); await writeFile(join(dir, "app.ts"), "export const value = 1;\n"); git("add", "."); git("commit", "-m", "feat: base"); const base = git("rev-parse", "HEAD");
 git("switch", "-c", "feat/work"); await writeFile(join(dir, "app.ts"), "export const value = 2;\n"); git("commit", "-am", "fix: value"); const head = git("rev-parse", "HEAD");
 const r = root(); r.checkout = { root: dir, commonDir: join(dir, ".git"), branch: "feat/work", baseCommit: base };
 r.lifecycle.subjects[0]!.headSha = head; r.lifecycle.subjects[0]!.baseSha = base;
 await updateWorkflow(r.checkout, 42, undefined, () => r); let calls = 0;
 const { material: _material, recordRequest: _recordRequest, ...p } = ports();
 const options = { ...p, workflowStore: { checkout: r.checkout, issue: 42, operationId: "review-op" },
  snapshot: async () => ({ repo, pr: 42, headSha: head, baseSha: base, contentHash: "c".repeat(64), clean: true }),
  call: async (context: unknown) => { const saved = await readWorkflow(r.checkout, 42); assert.ok(saved?.lifecycle.status === "enabled" && saved.lifecycle.operations[0]?.providerRequest); calls++; assert.match(JSON.stringify(context), /value = 1/); assert.match(JSON.stringify(context), /value = 2/); return answer(); },
 };
 const result = await reviewLocalChange(r, "review-op", options); assert.equal(result.status, "pass"); assert.equal(calls, 1);
 const reloaded = await readWorkflow(r.checkout, 42); assert.ok(reloaded); assert.equal((await reviewLocalChange(reloaded, "review-op", options)).status, "unknown"); assert.equal(calls, 1);
 // El mismo parser durable sigue pudiendo leer requests GHA: no se degrada a inferencias del modelo.
 assert.ok(new GitHubReadClient({ repo, cwd: dir }));
 git("update-index", "--add", "--cacheinfo", `160000,${base},vendor`); git("commit", "-m", "test: gitlink base"); const submoduleBase = git("rev-parse", "HEAD");
 git("update-index", "--cacheinfo", `160000,${head},vendor`); git("commit", "-m", "test: gitlink head"); const submoduleHead = git("rev-parse", "HEAD"); git("config", "diff.ignoreSubmodules", "all");
 const material = await fixedReviewMaterial(dir, { repo, pr: 42, headSha: submoduleHead, baseSha: submoduleBase, correlationId: nonce });
 assert.equal(material.fileCount, 1, "La configuración local no oculta un gitlink cambiado"); assert.match(material.prompt, /vendor/); assert.match(material.prompt, new RegExp(base)); assert.match(material.prompt, new RegExp(head));
});
