import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { readReceiptZip } from "../src/harness/gha-artifact.ts";
import { GitHubReadClient } from "../src/harness/lifecycle-github-read.ts";
import { createGhaReviewPorts, resolveGhaReviewRequest, reviewArtifactName, persistGhaReviewRequest } from "../src/harness/gha-review-io.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash } from "../src/harness/model.ts";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { mkdir } from "node:fs/promises";
import * as life from "../src/harness/lifecycle-state.ts";
import { fakeRunner } from "./helpers/runner.ts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runReadonlyGhaReview } from "../scripts/review-runner.ts";
import { inspectReviewSubject, prepareReviewMaterial } from "../scripts/review-workflow.ts";
import { parseReviewDispatchInputs, buildReviewArtifact, validateGhaReview, selectCorrelatedReviewRun, reviewRunName, observeGhaReview, startGhaReview, type GhaReviewPorts } from "../src/harness/lifecycle-gha-review.ts";

const repo = "acme/app", head = "b".repeat(40), base = "a".repeat(40), workflowSha = "e".repeat(40), correlationId = "12345678-1234-4234-8234-123456789abc";
const at = "2026-01-01T00:00:00Z";
const request = () => ({ repo, pr: 42, headSha: head, baseSha: base, correlationId, createdAfter: at, workflow: { id: 7, path: ".github/workflows/review.yml", ref: "main", sha: workflowSha } });
const metadata = () => ({ repo, pr: 42, headSha: head, baseSha: base, diffBaseSha: base, materialHash: "f".repeat(64), materialComplete: true, fileCount: 1, correlationId, workflowSha, runId: 1001, runAttempt: 1 });
const artifact = () => ({ version: 1, contract: "omi-review-v1", ...metadata(), state: "complete", verdict: "pass", findings: [] });
const run = () => ({ id: 1001, workflow_id: 7, path: ".github/workflows/review.yml", head_sha: workflowSha, head_branch: "main", event: "workflow_dispatch", display_title: `omi-review-v1 PR #42 ${correlationId}`, run_attempt: 1, status: "completed", conclusion: "success", created_at: at, repository: { full_name: repo } });
const current = () => ({ repo, pr: 42, headSha: head, baseSha: base });
const finding = (id = "F1") => ({ id, severity: "high", message: "Falta manejar error", path: "src/app.ts", line: 10 });
function reserved(source: "person" | "policy" = "person", ownerRepo = repo) {
 const block = defaultLifecycleConfig(ownerRepo, "main"); block.review = { mode: source === "person" ? "ask" : "auto", provider: { kind: "gha", workflow: "review.yml", ref: "main", contract: "omi-review-v1" }, timeoutSeconds: 60 };
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo: ownerRepo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let lifecycle = life.initializeLifecycle({ workflowId: "root", issue: 42, repo: ownerRepo }, pin);
 lifecycle = life.bindLifecycleSubject(lifecycle, { id: "subject", repo: ownerRepo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: "c".repeat(64), mergedSha: null }, { id: "adoption", source: "person", at });
 lifecycle = life.reserveLifecycleOperation(lifecycle, { id: "review-op", key: "review", kind: "review", subjectId: "subject", targetId: null, correlationId, retryOf: null }, { id: "decision", kind: "review", subjectId: "subject", targetId: null, configHash: pin.accepted.blockHash, source, at }, "process", at);
 const issue = { number: 42, title: "Review", body: "Issue", url: `https://github.com/${ownerRepo}/issues/42`, hash: sourceHash("Review", "Issue") };
 return { ...createWorkflow(issue, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at), lifecycle };
}
function ports(): GhaReviewPorts & { runner: ReturnType<typeof fakeRunner> } {
 let clock = Date.parse(at); const runner = fakeRunner();
 return { runner, beforeDispatch: async () => {}, recordRequest: async () => {}, timeoutSeconds: 60, now: () => clock, wait: async () => { clock += 10000; }, signal: AbortSignal.timeout(5000), listRuns: async () => [run()], loadArtifact: async () => JSON.stringify(artifact()), currentSubject: async () => current() };
}

test("inputs nuevos se exigen juntos sin quitar pr manual legacy ni tolerar inyección", () => {
 assert.deepEqual(parseReviewDispatchInputs({ pr: "42" }), { kind: "legacy", pr: 42 });
 assert.deepEqual(parseReviewDispatchInputs({ pr: "42", expected_head_sha: head, correlation_id: correlationId }), { kind: "strong", pr: 42, headSha: head, correlationId });
 for (const input of [{ pr: "42", expected_head_sha: head }, { pr: "42", correlation_id: correlationId }, { pr: "$(run)" }, { pr: "0" }, { pr: "42", expected_head_sha: "main", correlation_id: correlationId }, { pr: "42", expected_head_sha: head, correlation_id: "bad\nname" }]) assert.throws(() => parseReviewDispatchInputs(input));
});

test("recibo fuerte prueba checkout PR aunque run.head_sha sea main", () => {
 const req = request(); assert.equal(reviewRunName(req), run().display_title);
 assert.equal(validateGhaReview(req, run(), JSON.stringify(artifact()), current()).status, "pass");
 assert.notEqual(run().head_sha, head);
});

test("producer construye metadata host y no acepta identidad/completitud declaradas por modelo", () => {
 const receipt = buildReviewArtifact(metadata(), JSON.stringify({ verdict: "pass", findings: [] }), "success");
 assert.deepEqual(receipt, artifact());
 const attempted = buildReviewArtifact(metadata(), JSON.stringify({ verdict: "pass", findings: [], headSha: "f".repeat(40), runId: 9, state: "complete" }), "success");
 assert.equal(attempted.headSha, head); assert.notEqual(attempted.state, "complete");
 for (const output of ["{broken", "", JSON.stringify({ verdict: "pass" })]) assert.equal(buildReviewArtifact(metadata(), output, "success").verdict, "unknown");
 assert.equal(buildReviewArtifact(metadata(), JSON.stringify({ verdict: "pass", findings: [] }), "failure").verdict, "unknown");
});

test("success con hallazgos nunca pass; duplicado idéntico se deduplica, conflictivo incompleto", () => {
 const receipt = buildReviewArtifact(metadata(), JSON.stringify({ verdict: "pass", findings: [finding(), finding()] }), "success");
 assert.equal(receipt.findings.length, 1); assert.equal(receipt.verdict, "findings");
 assert.equal(validateGhaReview(request(), run(), JSON.stringify(receipt), current()).status, "findings");
 const conflict = buildReviewArtifact(metadata(), JSON.stringify({ verdict: "pass", findings: [finding(), { ...finding(), message: "Otro hallazgo con mismo ID" }] }), "success");
 assert.equal(conflict.verdict, "unknown");
});

for (const field of ["repo", "pr", "headSha", "baseSha", "correlationId", "runId", "runAttempt", "workflowSha"] as const) test(`artefacto con ${field} ajeno no acredita`, () => {
 const bad = { ...artifact(), [field]: typeof artifact()[field] === "number" ? 999 : "f".repeat(40) };
 assert.equal(validateGhaReview(request(), run(), JSON.stringify(bad), current()).status, "unknown");
});

test("workflow/ref/run/attempt/HEAD actual y base se validan por separado", () => {
 for (const badRun of [{ ...run(), workflow_id: 8 }, { ...run(), path: ".github/workflows/other.yml" }, { ...run(), head_branch: "untrusted" }, { ...run(), head_sha: "f".repeat(40) }, { ...run(), run_attempt: 2 }, { ...run(), repository: { full_name: "other/app" } }, { ...run(), event: "push" }, { ...run(), conclusion: "failure" }]) assert.equal(validateGhaReview(request(), badRun, JSON.stringify(artifact()), current()).status, "unknown");
 for (const now of [{ ...current(), headSha: "f".repeat(40) }, { ...current(), baseSha: "f".repeat(40) }]) assert.equal(validateGhaReview(request(), run(), JSON.stringify(artifact()), now).status, "unknown");
});

test("legacy, sin artifact, incompleto, futuro o unknown no equivalen a revisión aprobada", () => {
 for (const raw of [null, "", "{broken", JSON.stringify({ ...artifact(), state: "incomplete" }), JSON.stringify({ ...artifact(), verdict: "unknown" }), JSON.stringify({ ...artifact(), version: 2 })]) assert.equal(validateGhaReview(request(), run(), raw, current()).status, "unknown");
 assert.equal(selectCorrelatedReviewRun(request(), [{ ...run(), display_title: "Claude Review PR42" }]).status, "unknown");
});

test("correlación ausente/duplicada/truncada no elige último run ni dispara otra vez", () => {
 assert.equal(selectCorrelatedReviewRun(request(), []).status, "unknown");
 assert.equal(selectCorrelatedReviewRun(request(), [run(), { ...run(), id: 1002 }]).status, "unknown");
 assert.equal(selectCorrelatedReviewRun(request(), Array.from({ length: 1001 }, () => run())).status, "unknown");
});

test("respuesta de dispatch perdida se reconcilia por correlación única sin replay", async () => {
 const p = ports(); p.runner = fakeRunner(() => ({ code: 1, stderr: "respuesta perdida" }));
 assert.equal((await startGhaReview(reserved(), request(), p)).status, "pass");
 assert.equal(p.runner.commands.length, 1); assert.deepEqual(p.runner.commands[0]?.args.slice(0, 2), ["workflow", "run"]);
 assert.ok(p.runner.commands[0]?.args.includes(`expected_head_sha=${head}`)); assert.ok(p.runner.commands[0]?.args.includes(`correlation_id=${correlationId}`));
});

test("observación timeout/sin artefacto/duplicidad permanece unknown sin redispatch", async () => {
 const p = ports(); assert.equal((await observeGhaReview(request(), { ...p, listRuns: async () => [] })).status, "unknown");
 assert.equal((await observeGhaReview(request(), { ...p, loadArtifact: async () => "" })).status, "unknown");
 assert.equal((await observeGhaReview(request(), { ...p, listRuns: async () => [run(), { ...run(), id: 1002 }] })).status, "unknown");
 assert.equal(p.runner.commands.length, 0);
});

test("dispatch necesita pending/decisión vigente y en omi-code siempre persona", async () => {
 const p = ports(); const root = reserved();
 await assert.rejects(startGhaReview({ ...root, lifecycle: { ...root.lifecycle, operations: [] } }, request(), p));
 await assert.rejects(startGhaReview(reserved("policy", "chichex/omi-code"), { ...request(), repo: "chichex/omi-code" }, p), /persona|humana/);
 assert.equal(p.runner.commands.length, 0);
});

test("workflow conserva legacy y agrega ruta fuerte con productor trusted y tools desactivadas", async () => {
 const workflow = await readFile(new URL("../.github/workflows/claude-review.yml", import.meta.url), "utf8");
 for (const required of ["expected_head_sha:", "correlation_id:", "run-name:", "omi-review-v1", "scripts/review-workflow.ts", "actions/upload-artifact@", "persist-credentials: false"]) assert.ok(workflow.includes(required), required);
 assert.match(workflow, /pr:\s*\n\s*description:/); assert.match(workflow, /gh pr comment/);
 const runner = await readFile(new URL("../scripts/review-runner.ts", import.meta.url), "utf8");
 for (const guard of ["tools: []", "settingSources: []", "strictMcpConfig: true", "mcpServers: {}", "ModelReviewSchema", "structured_output"]) assert.ok(runner.includes(guard), guard);
});

test("runner SDK fuerte observa opciones sin tools/settings/MCP y nunca pone credenciales en prompt", async () => {
 let captured: Options | undefined; let prompt = "";
 const query = (input: { prompt: string; options: Options }) => { captured = input.options; prompt = input.prompt; return (async function* () { yield { type: "system", subtype: "init", tools: ["StructuredOutput"] }; yield { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", structured_output: { verdict: "pass", findings: [] }, usage: { input_tokens: 5, output_tokens: 2 } }; })(); };
 const result = await runReadonlyGhaReview({ material: "Diff completo fixture", cwd: "/trusted", model: "claude-opus-5-5", effort: "xhigh", signal: AbortSignal.timeout(1000), env: { PATH: "/bin", HOME: "/isolated", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth", GH_TOKEN: "fixture-gh", ANTHROPIC_API_KEY: "fixture-other" }, query });
 assert.equal(result.conclusion, "success"); assert.ok(captured); assert.deepEqual(captured.tools, []); assert.deepEqual(captured.settingSources, []); assert.deepEqual(captured.mcpServers, {}); assert.equal(captured.strictMcpConfig, true);
 assert.deepEqual(captured.skills, []); assert.deepEqual(captured.plugins, []); assert.equal(captured.persistSession, false);
 assert.equal(captured.env?.CLAUDE_CODE_OAUTH_TOKEN, "fixture-oauth"); assert.equal(captured.env?.GH_TOKEN, undefined); assert.equal(captured.env?.ANTHROPIC_API_KEY, undefined);
 assert.ok(!prompt.includes("fixture-oauth") && !prompt.includes("fixture-gh") && !String(captured.systemPrompt).includes("fixture-oauth"));
 const permission = await captured.canUseTool?.("Bash", { command: "echo not-executed" }, { signal: AbortSignal.timeout(1000), toolUseID: "tool1", requestId: "request1" }); assert.equal(permission?.behavior, "deny");
});

test("runner no acredita truncamiento, error, tools inesperadas o salida sin schema", async () => {
 for (const problem of ["max_tokens", "contradictory", "aborted", "declaration", "tool", "error", "schema"]) {
  const query = () => (async function* () {
   if (problem === "tool") yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "not-executed" } }] } };
   if (problem === "declaration") yield { type: "system", subtype: "init", tools: ["Bash"] };
   yield { type: "result", subtype: problem === "error" ? "error_during_execution" : "success", is_error: problem === "error", stop_reason: problem === "max_tokens" || problem === "contradictory" ? "max_tokens" : "end_turn", terminal_reason: problem === "contradictory" ? "completed" : problem === "aborted" ? "aborted_streaming" : undefined, structured_output: problem === "schema" ? { fake: true } : { verdict: "pass", findings: [] } };
  })();
  assert.equal((await runReadonlyGhaReview({ material: "fixture", cwd: "/trusted", model: "claude-opus-5-5", effort: "xhigh", signal: AbortSignal.timeout(1000), env: {}, query })).conclusion, "failure");
 }
});

test("producer usa Git temporal: SHA trusted separado, merge-base único y diff completo sin mover HEAD", async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), "omi-review-material-"))); t.after(() => rm(root, { recursive: true, force: true }));
 const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" } }).trim();
 git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
 await writeFile(join(root, "app.ts"), "export const value = 1;\n"); git("add", "--", "app.ts"); git("commit", "-m", "feat: base"); const baseSha = git("rev-parse", "HEAD");
 git("switch", "-c", "work"); await writeFile(join(root, "app.ts"), "export const value = 2;\n"); git("commit", "-am", "fix: value"); const headSha = git("rev-parse", "HEAD");
 git("switch", "main"); const prRoot = join(root, "pr-checkout"); git("worktree", "add", "--detach", prRoot, headSha);
 const context = { repo, pr: 42, headSha, workflowSha: baseSha, correlationId, runId: 1001, runAttempt: 1 };
 const inspection = await inspectReviewSubject(context, async () => ({ number: 42, state: "open", draft: true, head: { sha: headSha, ref: "work", repo: { full_name: repo } }, base: { sha: baseSha, ref: "main", repo: { full_name: repo } }, merged: false, merge_commit_sha: null }));
 const material = await prepareReviewMaterial({ trustedRoot: root, prRoot, inspection });
 assert.equal(material.metadata.materialComplete, true); assert.equal(material.metadata.diffBaseSha, baseSha); assert.equal(material.metadata.fileCount, 1);
 assert.match(material.prompt, /value = 1/); assert.match(material.prompt, /value = 2/);
 assert.equal(material.metadata.materialHash, createHash("sha256").update(material.prompt).digest("hex")); assert.equal(git("rev-parse", "HEAD"), baseSha); assert.notEqual(headSha, baseSha);
 await assert.rejects(prepareReviewMaterial({ trustedRoot: root, prRoot, inspection: { ...inspection, workflowSha: headSha } }));
 for (const [index, path] of [".claude/.credentials.json", ".git-credentials", ".docker/config.json", ".aws/credentials", ".config/gh/hosts.yml"].entries()) {
  const credentialRoot = join(root, `credential-fixture-${index}`); git("worktree", "add", "--detach", credentialRoot, headSha);
  await mkdir(join(credentialRoot, path, ".."), { recursive: true }); await writeFile(join(credentialRoot, path), "fixture-not-a-real-credential");
  git("-C", credentialRoot, "add", "--", path); git("-C", credentialRoot, "commit", "-m", "test: fixture credentials"); const credentialHead = git("-C", credentialRoot, "rev-parse", "HEAD");
  const protectedMaterial = await prepareReviewMaterial({ trustedRoot: root, prRoot: credentialRoot, inspection: { ...inspection, headSha: credentialHead } });
  assert.equal(protectedMaterial.metadata.materialComplete, false, `No enviar credenciales del path ${path}`);
  assert.equal(protectedMaterial.prompt.includes("fixture-not-a-real-credential"), false, "El payload preparado tampoco contiene valores del archivo sensible");
  assert.equal(buildReviewArtifact(protectedMaterial.metadata, JSON.stringify({ verdict: "pass", findings: [] }), "success").state, "incomplete");
 }
});

test("material incompleto o demasiado grande nunca se ofrece al modelo ni acredita pass", async () => {
 const incomplete = { ...metadata(), materialComplete: false, fileCount: 2000 };
 assert.equal(buildReviewArtifact(incomplete, JSON.stringify({ verdict: "pass", findings: [] }), "success").state, "incomplete");
 assert.equal(validateGhaReview(request(), run(), JSON.stringify({ ...artifact(), materialComplete: false }), current()).status, "unknown");
 let calls = 0; const query = () => { calls++; return (async function* () {})(); };
 assert.equal((await runReadonlyGhaReview({ material: "x".repeat(120001), cwd: "/trusted", model: "claude-opus-5-5", effort: "xhigh", signal: AbortSignal.timeout(1000), env: {}, query })).conclusion, "failure"); assert.equal(calls, 0);
});

function receiptZip(data: Buffer, path = "review.json", method = 8): Buffer {
 const name = Buffer.from(path); const compressed = method === 8 ? deflateRawSync(data) : data; const crc = crc32(data);
 const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
 const central = Buffer.alloc(46 + name.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100600 << 16) >>> 0, 38); name.copy(central, 46);
 const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + compressed.length, 16);
 return Buffer.concat([local, compressed, central, end]);
}

test("ZIP de artefacto por ID se lee sin extraer archivos y verifica bytes/CRC/digest", async () => {
 const data = Buffer.from(JSON.stringify(artifact()));
 for (const method of [0, 8]) { const bytes = receiptZip(data, "review.json", method); assert.equal(await readReceiptZip(bytes, "review.json", `sha256:${createHash("sha256").update(bytes).digest("hex")}`), data.toString()); }
 const corrupt = receiptZip(data, "review.json", 0); corrupt[41] = corrupt[41]! ^ 1; await assert.rejects(readReceiptZip(corrupt, "review.json"));
 await assert.rejects(readReceiptZip(receiptZip(data), "review.json", `sha256:${"0".repeat(64)}`));
});

test("ZIPs incompletos, múltiples, paths ajenos, symlinks y bombas no dan recibo", async () => {
 const data = Buffer.from(JSON.stringify(artifact()));
 for (const bytes of [Buffer.from("not zip"), receiptZip(data, "../review.json"), Buffer.alloc(8 * 1024 * 1024 + 1)]) await assert.rejects(readReceiptZip(bytes, "review.json"));
 const many = receiptZip(data); many.writeUInt16LE(2, many.length - 12); await assert.rejects(readReceiptZip(many, "review.json"));
 const symlink = receiptZip(data); const central = symlink.readUInt32LE(symlink.length - 6); symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38); await assert.rejects(readReceiptZip(symlink, "review.json"));
 const bomb = receiptZip(Buffer.alloc(8 * 1024 * 1024 + 1, "x")); const c = bomb.readUInt32LE(bomb.length - 6); bomb.writeUInt32LE(1, 22); bomb.writeUInt32LE(1, c + 24); await assert.rejects(readReceiptZip(bomb, "review.json"));
});

test("puertos GHA reales con transporte falso resuelven ref, paginan runs y descargan ID/attempt exactos", async () => {
 const bytes = receiptZip(Buffer.from(JSON.stringify(artifact()))); let duplicate = false, expired = false, tagExists = false; let downloads = 0;
 const runner = fakeRunner((_cmd, args) => {
  const endpoint = args.find(arg => arg.startsWith("repos/")); assert.ok(endpoint); const url = new URL(`https://api.github.com/${endpoint}`);
  let body: unknown; let code = 200;
  if (url.pathname.endsWith("/actions/workflows/review.yml")) body = { id: 7, path: ".github/workflows/review.yml", state: "active" };
  else if (url.pathname.endsWith("/git/ref/heads/main")) body = { object: { type: "commit", sha: workflowSha } };
  else if (url.pathname.endsWith("/git/ref/tags/main")) { code = tagExists ? 200 : 404; body = { object: { type: "commit", sha: workflowSha } }; }
  else if (url.pathname.endsWith("/actions/workflows/7/runs")) { assert.equal(url.searchParams.get("event"), "workflow_dispatch"); assert.ok(url.searchParams.get("created")?.startsWith(">=")); body = { total_count: 1, workflow_runs: [run()] }; }
  else if (url.pathname.endsWith("/pulls/42")) body = { number: 42, state: "open", draft: true, merged: false, merge_commit_sha: null, head: { sha: head, ref: "feat/work", repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } };
  else if (url.pathname.endsWith("/actions/runs/1001/artifacts")) {
   const a = { id: 999, name: reviewArtifactName(request(), run()), size_in_bytes: bytes.length, expired, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 1001, head_sha: workflowSha } };
   body = { total_count: duplicate ? 2 : 1, artifacts: duplicate ? [a, { ...a, id: 1000 }] : [a] };
  } else throw new Error(`Unexpected fixture endpoint ${endpoint}`);
  return { code: code === 200 ? 0 : 1, stdout: `HTTP/2.0 ${code} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` };
 });
 const client = new GitHubReadClient({ repo, cwd: "/fixture", runner, delay: async () => {} });
 const req = await resolveGhaReviewRequest(reserved(), "review-op", client, AbortSignal.timeout(1000)); assert.equal(req.workflow.sha, workflowSha); assert.equal(req.correlationId, correlationId);
 const p = createGhaReviewPorts(req, { client, timeoutSeconds: 60, signal: AbortSignal.timeout(1000), downloadArtifact: async (ownerRepo, artifactId) => { assert.equal(ownerRepo, repo); assert.equal(artifactId, 999); downloads++; return bytes; } });
 assert.equal((await observeGhaReview(req, p)).status, "pass"); assert.equal(downloads, 1);
 duplicate = true; assert.equal((await observeGhaReview(req, p)).status, "unknown"); assert.equal(downloads, 1);
 duplicate = false; expired = true; assert.equal((await observeGhaReview(req, p)).status, "unknown"); assert.equal(downloads, 1);
 tagExists = true; await assert.rejects(resolveGhaReviewRequest(reserved(), "review-op", client, AbortSignal.timeout(1000)), /ambiguo/);
 assert.ok(runner.commands.every(c => c.args[c.args.indexOf("--method") + 1] === "GET"));
});

test("rechazar el gate vivo antes de dispatch no ejecuta comandos ni busca otro proveedor", async () => {
 const p = ports(); let gates = 0;
 await assert.rejects(startGhaReview(reserved(), request(), { ...p, beforeDispatch: async () => { gates++; throw new Error("KB nueva/no aceptada"); } }));
 assert.equal(gates, 1); assert.equal(p.runner.commands.length, 0);
});

test("timeout cancela señal efectiva y no acredita lecturas que terminaron fuera del deadline", async () => {
 const p = ports(); let clock = 0, loads = 0; let observedSignal: AbortSignal | undefined;
 p.now = () => clock; p.listRuns = async signal => { observedSignal = signal; clock = 61000; return [run()]; };
 p.loadArtifact = async () => { loads++; return JSON.stringify(artifact()); };
 const result = await observeGhaReview(request(), p); assert.equal(result.status, "unknown"); assert.match(result.reason, /timeout/i); assert.equal(loads, 0); assert.equal(observedSignal?.aborted, true);
});

test("request/resolved SHA se persiste antes del dispatch y sobrevive al cambio del ref tras crash", async t => {
 const dir = await realpath(await mkdtemp(join(tmpdir(), "omi-gha-request-"))); t.after(() => rm(dir, { recursive: true, force: true })); await mkdir(join(dir, ".git"));
 const root = reserved(); root.checkout = { ...root.checkout, root: dir, commonDir: join(dir, ".git") };
 await updateWorkflow(root.checkout, 42, undefined, () => root); let recorded = 0;
 const p = ports(); const recorder = fakeRunner();
 p.runner = { ...recorder, async run(command, args, options) { const state = await readWorkflow(root.checkout, 42); assert.ok(state?.lifecycle.status === "enabled"); assert.deepEqual(state.lifecycle.operations[0]?.providerRequest, request()); return recorder.run(command, args, options); } };
 const recordRequest = async (req: unknown) => { recorded++; await persistGhaReviewRequest(root.checkout, 42, "review-op", req); };
 assert.equal((await startGhaReview(root, request(), { ...p, recordRequest })).status, "pass"); assert.equal(recorded, 1);
 await assert.rejects(startGhaReview(root, request(), { ...p, recordRequest }), /reservad|fijad|observar/);
 assert.equal(p.runner.commands.length, 1);
 const reloaded = await readWorkflow(root.checkout, 42); assert.ok(reloaded?.lifecycle.status === "enabled"); assert.deepEqual(reloaded.lifecycle.operations[0]?.providerRequest, request());
 const client = new GitHubReadClient({ repo, cwd: dir, runner: fakeRunner(() => { throw new Error("no resolver el ref móvil de nuevo"); }) });
 assert.deepEqual(await resolveGhaReviewRequest(reloaded, "review-op", client, AbortSignal.timeout(1000)), request());
 await assert.rejects(persistGhaReviewRequest(root.checkout, 42, "review-op", { ...request(), workflow: { ...request().workflow, sha: "f".repeat(40) } }));
});

test("workflow: el contexto runner sólo aparece dentro de steps; en el env de un job GitHub invalida el archivo entero", async () => {
 const workflow = await readFile(new URL("../.github/workflows/claude-review.yml", import.meta.url), "utf8");
 // GitHub no ofrece `runner` en jobs.<id>.env: el archivo no valida y cada push deja un run fallido.
 const offending: string[] = []; let jobEnv = false;
 for (const line of workflow.split("\n")) {
  const indent = line.length - line.trimStart().length;
  if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
  if (indent <= 4) jobEnv = /^ {4}env:\s*$/.test(line);
  else if (jobEnv && /\$\{\{\s*runner\./.test(line)) offending.push(line.trim());
 }
 assert.deepEqual(offending, []);
});
