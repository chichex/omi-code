import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, CommandOptions } from "../src/core/exec.ts";
import { artifactHash, sourceHash, type Workflow } from "../src/harness/model.ts";
import { readIssueSource, renderWorkflowArtifact, renderPullRequestBody, syncIssueSection, publishDraft } from "../src/harness/github.ts";
import { parseIssueBody, renderIssueSection } from "../src/harness/issue-section.ts";

async function fixture(t: import("node:test").TestContext) {
 const root = await mkdtemp(join(tmpdir(), "omi-harness-gh-")); await mkdir(join(root, ".git")); t.after(() => rm(root, { recursive: true, force: true }));
 const head = "b".repeat(40); const checkout = { root, commonDir: join(root, ".git"), branch: "feat/task", baseCommit: "a".repeat(40) };
 const source = { number: 42, title: "$(touch unsafe)", body: "Original\n", url: "https://github.com/acme/repo/issues/42", hash: sourceHash("$(touch unsafe)", "Original\n") };
 const workflow: Workflow = { version: 1, id: "w", revision: 0, source, checkout, phase: "pr", status: "active", blockedReason: "", activity: "testing", exploration: null, inferences: [], recipe: null, diagnosis: null, spec: null, steps: [], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: { sourceHash: source.hash, recipeHash: "approved", at: "now" }, publication: { status: "pending", head, bodyHash: "body", at: "now" }, history: [] };
 if (workflow.publication.status === "pending") workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(workflow));
 const calls: { command: string; args: string[]; options?: CommandOptions }[] = [];
 const state = { issue: { number: 42, title: source.title, body: source.body, url: source.url }, prs: [] as unknown[], createError: false, dropEdit: false, remote: "git@github.com:acme/repo.git", head, changeHeadOnList: false, changeHeadOnPush: false, pushError: false };
 const pr = { number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: checkout.branch, baseRefName: "main", headRefOid: head, body: "" };
 const runner: Runner = { async run(command, args, options) {
  calls.push({ command, args, ...(options ? { options } : {}) }); let stdout = "";
  if (command === "git") {
   const a = args.slice(args.indexOf("-C") + 2);
   if (a[0] === "rev-parse") stdout = a.includes("--show-toplevel") ? root : a.includes("--git-common-dir") ? checkout.commonDir : state.head;
   if (a[0] === "symbolic-ref") stdout = `refs/heads/${checkout.branch}`;
   if (a[0] === "remote") stdout = state.remote;
   if (a[0] === "push" && state.changeHeadOnPush) state.head = "c".repeat(40);
   if (a[0] === "push" && state.pushError) return { code: 1, stdout: "", stderr: "! [rejected] feat/task (non-fast-forward)" };
  } else if (args[0] === "issue" && args[1] === "view") stdout = JSON.stringify(state.issue);
  else if (args.join(" ") === "issue edit 42 --repo acme/repo --body-file -") { if (!state.dropEdit) state.issue.body = options?.input ?? ""; }
  else if (args[0] === "repo") stdout = JSON.stringify({ nameWithOwner: "acme/repo", url: "https://github.com/acme/repo" });
  else if (args[0] === "pr" && args[1] === "list") { stdout = JSON.stringify(state.prs); if (state.changeHeadOnList) state.head = "c".repeat(40); }
  else if (args[0] === "pr" && args[1] === "create") { pr.body = options?.input ?? ""; state.prs = [pr]; if (state.createError) return { code: 1, stdout: "", stderr: "ambiguous" }; stdout = pr.url; }
  else throw new Error(`Unexpected remote call: ${args.join(" ")}`);
  return { code: 0, stdout, stderr: "" };
 } };
 return { workflow, state, calls, runner, pr };
}
const edits = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.args[0] === "issue" && c.args[1] === "edit");

test("issue source preserves original bytes and ignores only one well-formed legacy owned block", async (t) => {
 const f = await fixture(t); const first = await readIssueSource(f.workflow.checkout, 42, f.runner);
 f.state.issue.body += "<!-- omi-development:start -->\nartifact\n<!-- omi-development:end -->";
 assert.deepEqual(await readIssueSource(f.workflow.checkout, 42, f.runner), first);
 for (const body of ["<!-- omi-development:start -->", "<!-- omi-development:end -->", "<!-- omi-development:start --><!-- omi-development:start --><!-- omi-development:end -->", "<!-- omi-development:start", "<!-- omi-development:unknown -->"]) {
  f.state.issue.body = body; await assert.rejects(readIssueSource(f.workflow.checkout, 42, f.runner));
 }
});

test("the request contrast ignores the managed harness section and whatever is written inside it", async (t) => {
 const f = await fixture(t); const first = await readIssueSource(f.workflow.checkout, 42, f.runner);
 f.state.issue.body = `${first.body}\n\n<!-- omi:harness:start -->\n## Harness · #42\nReceta vieja\n<!-- omi:harness:end -->`;
 assert.deepEqual(await readIssueSource(f.workflow.checkout, 42, f.runner), first, "escribir la sección no invalida el trabajo");
 f.state.issue.body = f.state.issue.body.replace("Receta vieja", "Una persona tocó la sección");
 assert.deepEqual(await readIssueSource(f.workflow.checkout, 42, f.runner), first);
 f.state.issue.body = f.state.issue.body.replace("Original", "Original editado");
 assert.notEqual((await readIssueSource(f.workflow.checkout, 42, f.runner)).hash, first.hash, "un cambio del pedido de arriba sí cuenta");
 f.state.issue.body = `${first.body}\n\n<!-- omi:harness:start -->\nsin cierre`;
 await assert.rejects(readIssueSource(f.workflow.checkout, 42, f.runner), /marcadores/i);
});

test("the harness section goes below the request, byte for byte, and is rewritten in place without comments", async (t) => {
 const f = await fixture(t); f.workflow.phase = "verify";
 await syncIssueSection(f.workflow, f.runner);
 const first = f.state.issue.body; const parts = parseIssueBody(first);
 assert.ok(first.startsWith("Original\n")); assert.equal(parts.human, "Original\n"); assert.match(parts.section ?? "", /^\n## Harness · #42\n/);
 const edit = edits(f)[0]; assert.equal(edit?.options?.input, first, "el cuerpo viaja por stdin, nunca como argumento");
 await syncIssueSection(f.workflow, f.runner); assert.equal(edits(f).length, 1, "una sección igual no se vuelve a escribir");
 f.state.issue.body += "\n\nNota humana debajo"; f.workflow.phase = "pr";
 // Lo que agrega una persona debajo de la sección es pedido: un punto de control lo contrasta antes de reescribir.
 await assert.rejects(syncIssueSection(f.workflow, f.runner), /pedido/i); assert.equal(edits(f).length, 1);
 f.workflow.source = await readIssueSource(f.workflow.checkout, 42, f.runner);
 await syncIssueSection(f.workflow, f.runner);
 assert.equal(edits(f).length, 2); assert.ok(f.state.issue.body.startsWith("Original\n")); assert.ok(f.state.issue.body.endsWith("\n\nNota humana debajo"), "lo de fuera de los marcadores no se toca");
 assert.equal(f.state.issue.body.split("<!-- omi:harness:start -->").length, 2, "una sola sección");
 assert.equal((await readIssueSource(f.workflow.checkout, 42, f.runner)).hash, sourceHash(f.workflow.source.title, "Original\n\n\nNota humana debajo"));
 assert.ok(!f.calls.some(c => c.args.includes("POST") || c.args.includes("comment") || c.args.join(" ") === "api user"), "no se crean comentarios");
});

test("the section is not written when the request changed, the markers are broken or GitHub does not confirm", async (t) => {
 const f = await fixture(t); f.state.issue.body = "human edited";
 await assert.rejects(syncIssueSection(f.workflow, f.runner), /pedido/i); assert.equal(edits(f).length, 0);
 f.state.issue.body = "Original\n\n<!-- omi:harness:start -->\nsin cierre";
 await assert.rejects(syncIssueSection(f.workflow, f.runner), /marcadores/i); assert.equal(edits(f).length, 0);
 f.state.issue.body = "Original\n"; f.state.dropEdit = true;
 await assert.rejects(syncIssueSection(f.workflow, f.runner), /confirmar/i); assert.equal(edits(f).length, 1, "no se reintenta solo");
});

test("a section that does not fit next to the request is summarized and says so; the request is never touched", async (t) => {
 const f = await fixture(t); const setHuman = (human: string) => { f.state.issue.body = human; f.workflow.source.body = human; f.workflow.source.hash = sourceHash(f.workflow.source.title, human); };
 const human = "x".repeat(60000); setHuman(human); f.workflow.phase = "verify";
 f.workflow.recipe = { route: "direct", classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Fix", approach: "Fix", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Test", command: "npm test" }], lenses: ["quality"], executor: { mode: "inline", writers: 0 } };
 const proof = { id: "E", kind: "verification" as const, command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed" as const, output: "", fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" };
 f.workflow.evidence = [...Array.from({ length: 30 }, (_, i) => ({ ...proof, id: `R${i}`, kind: "red" as const, stepId: `C${i + 1}`, caseId: null, command: `node t${i}.js`, exitCode: 1, outcome: "failed" as const })), proof];
 f.workflow.reviews = [{ lens: "quality", fingerprint: "fp", verdict: "fail", findings: Array.from({ length: 20 }, (_, i) => `hallazgo ${i} ` + "h".repeat(400)), at: "now" }];
 await syncIssueSection(f.workflow, f.runner);
 let parts = parseIssueBody(f.state.issue.body);
 assert.ok(f.state.issue.body.length <= 65536); assert.equal(parts.human, human, "el pedido no se toca");
 assert.match(parts.section ?? "", /\*\*Resumida\*\*/); assert.match(parts.section ?? "", /\| D1 \| ✅ exit 0 \|/); assert.doesNotMatch(parts.section ?? "", /C1 · rojo/);
 f.workflow.recipe = { ...f.workflow.recipe, objective: "o".repeat(8000) }; setHuman(human);
 await syncIssueSection(f.workflow, f.runner);
 parts = parseIssueBody(f.state.issue.body); assert.equal(parts.human, human); assert.match(parts.section ?? "", /no entra en el cuerpo del issue/); assert.ok(f.state.issue.body.length <= 65536);
 const full = "y".repeat(65500); setHuman(full);
 await assert.rejects(syncIssueSection(f.workflow, f.runner), /límite/i); assert.equal(f.state.issue.body, full);
});

test("before any approval the section is only kept up to date if the issue already has one", async (t) => {
 const f = await fixture(t);
 assert.equal(await syncIssueSection(f.workflow, f.runner, undefined, { onlyIfPresent: true }), false); assert.equal(edits(f).length, 0);
 f.state.issue.body = "Original\n\n\n<!-- omi:harness:start -->\nvieja\n<!-- omi:harness:end -->";
 assert.equal(await syncIssueSection(f.workflow, f.runner, undefined, { onlyIfPresent: true }), true); assert.match(f.state.issue.body, /## Harness · #42/);
});

test("publication creates draft with immutable SHA/stdin and recovers ambiguous create without duplicate", async (t) => {
 const f = await fixture(t); f.state.createError = true;
 assert.deepEqual(await publishDraft(f.workflow, f.runner), { number: 3, url: f.pr.url, head: f.pr.headRefOid });
 assert.deepEqual(await publishDraft(f.workflow, f.runner), { number: 3, url: f.pr.url, head: f.pr.headRefOid });
 assert.equal(f.calls.filter(c => c.args[0] === "pr" && c.args[1] === "create").length, 1);
 const push = f.calls.find(c => c.args.includes("push")); assert.ok(push); assert.ok(push.args.includes(`${"b".repeat(40)}:refs/heads/feat/task`)); assert.ok(!push.args.includes("--force"));
 const create = f.calls.find(c => c.args[1] === "create"); assert.ok(create?.args.includes("--draft")); assert.ok(create?.options?.input?.includes("Refs #42")); assert.ok(!create?.options?.input?.includes("Closes"));
 assert.ok(f.calls.filter(c => c.args[0] === "pr" && c.args[1] === "list").every(c => c.args[c.args.indexOf("--json") + 1]?.split(",").includes("body")));
 assert.ok(f.calls.every(c => !["sh", "bash"].includes(c.command)));
});

test("publication rechecks snapshot immediately before push and cannot push raced HEAD", async (t) => {
 const f = await fixture(t); f.state.changeHeadOnList = true; await assert.rejects(publishDraft(f.workflow, f.runner)); assert.equal(f.calls.some(c => c.args.includes("push")), false);
 const race = await fixture(t); race.state.changeHeadOnPush = true; await assert.rejects(publishDraft(race.workflow, race.runner));
 const push = race.calls.find(c => c.args.includes("push")); assert.ok(push?.args.includes(`${"b".repeat(40)}:refs/heads/feat/task`)); assert.ok(!push?.args.includes("HEAD:refs/heads/feat/task"));
});

test("publication refuses wrong remote, nonpending phase and unrelated same-SHA draft", async (t) => {
 const f = await fixture(t); f.state.remote = "git@github.com:other/repo.git"; await assert.rejects(publishDraft(f.workflow, f.runner));
 assert.equal(f.calls.some(c => c.args.includes("push")), false);
 f.state.remote = "git@github.com:acme/repo.git";
 for (const pr of [{ ...f.pr, isDraft: false }, { ...f.pr, state: "CLOSED" }, { ...f.pr, headRefOid: "c".repeat(40) }, { ...f.pr, isCrossRepository: true }, { ...f.pr, body: "Unrelated human draft, same head" }]) { f.state.prs = [pr]; await assert.rejects(publishDraft(f.workflow, f.runner)); }
 await assert.rejects(publishDraft({ ...f.workflow, phase: "verify" }, f.runner)); assert.equal(f.calls.some(c => c.args.includes("push")), false);
});

test("publication identity binds workflow, source, head and exact artifact; human PR edits are not recovered", async (t) => {
 const f = await fixture(t); await publishDraft(f.workflow, f.runner);
 const body = f.pr.body; assert.equal(body, renderPullRequestBody(f.workflow)); assert.ok(body.includes(f.workflow.source.hash)); assert.ok(body.includes("b".repeat(40))); assert.ok(body.includes(artifactHash(renderWorkflowArtifact(f.workflow))));
 f.pr.body += "human edit"; await assert.rejects(publishDraft(f.workflow, f.runner)); f.pr.body = body;
 await assert.rejects(publishDraft({ ...f.workflow, id: "another-workflow" }, f.runner));
 f.workflow.inferences.push({ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer: "A" });
 await assert.rejects(publishDraft(f.workflow, f.runner)); assert.equal(f.calls.filter(c => c.args.includes("create")).length, 1);
});

test("artifact hashing ignores publishing activity but preserves phase and status", async (t) => {
 const f = await fixture(t); const before = renderWorkflowArtifact(f.workflow); f.workflow.activity = "publishing";
 assert.equal(renderWorkflowArtifact(f.workflow), before); f.workflow.status = "waiting"; assert.notEqual(renderWorkflowArtifact(f.workflow), before);
 f.workflow.status = "active"; f.workflow.phase = "verify"; assert.notEqual(renderWorkflowArtifact(f.workflow), before);
});

test("mandatory spec/inferences are complete or fail asking to divide; oversized PR bodies never push", async (t) => {
 const f = await fixture(t); const long = "x".repeat(13000) + "MANDATORY-END"; f.workflow.spec = { why: long, steps: [], playbook: [] };
 assert.ok(renderWorkflowArtifact(f.workflow).includes(long));
 f.workflow.inferences = [{ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer: "y".repeat(70000) }];
 assert.throws(() => renderWorkflowArtifact(f.workflow), /dividir/i);
 await assert.rejects(publishDraft(f.workflow, f.runner), /dividir/i); assert.equal(f.calls.some(c => c.args.includes("push") || c.args.includes("create")), false);
});

test("mandatory recipe and inferences are never silently bounded by presentation budgets", async (t) => {
 const f = await fixture(t); const objective = "o".repeat(12500) + "RECIPE-END"; const answer = "a".repeat(7000) + "INFERENCE-END";
 f.workflow.recipe = { route: "direct", classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective, approach: "Fix", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Test", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
 f.workflow.inferences = [{ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer }];
 const body = renderWorkflowArtifact(f.workflow); assert.ok(body.includes(objective)); assert.ok(body.includes(answer));
});

test("GitHub body limit includes the PR ownership wrapper before any remote write", async (t) => {
 const f = await fixture(t); f.workflow.source.body = "";
 const base = Buffer.byteLength(renderWorkflowArtifact(f.workflow)); f.workflow.source.body = "x".repeat(65530 - base);
 assert.equal(Buffer.byteLength(renderWorkflowArtifact(f.workflow)), 65530);
 if (f.workflow.publication.status === "pending") f.workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(f.workflow));
 await assert.rejects(publishDraft(f.workflow, f.runner), /dividir/i);
 assert.equal(f.calls.length, 0);
});

test("large evidence lists may be summarized explicitly without losing mandatory artifact", async (t) => {
 const f = await fixture(t); f.workflow.evidence = Array.from({ length: 120 }, (_, i) => ({ id: `E${i}`, kind: "verification" as const, command: "npm test", stepId: null, caseId: null, exitCode: 0, outcome: "passed" as const, output: "z".repeat(12000), fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }));
 const body = renderWorkflowArtifact(f.workflow); assert.ok(body.includes("estado local completo")); assert.ok(body.includes("npm test")); assert.ok(body.length < 65536);
});

test("command output never leaves the machine: the issue section and the PR carry exit codes, not output", async (t) => {
 const f = await fixture(t); f.workflow.evidence = [{ id: "E1", kind: "verification", command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed", output: "GITHUB_TOKEN=ghp_PRINTED_BY_A_TEST\nok", fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }];
 const body = renderWorkflowArtifact(f.workflow);
 assert.ok(body.includes("npm test")); assert.match(body, /"exitCode": 0/); assert.doesNotMatch(body, /ghp_PRINTED_BY_A_TEST|"output"/);
 const section = renderIssueSection(f.workflow); assert.match(section, /\| D1 \| ✅ exit 0 \|/); assert.doesNotMatch(section, /ghp_PRINTED_BY_A_TEST/);
});

test("a rejected push explains the likely cause instead of a generic Git verification error", async (t) => {
 const f = await fixture(t); f.state.pushError = true;
 await assert.rejects(publishDraft(f.workflow, f.runner), /push.*(autenticación|protegida|non-fast-forward)/i);
 assert.equal(f.calls.filter(c => c.args[0] === "pr" && c.args[1] === "create").length, 0);
});

test("lens findings in the artifact are bounded explicitly so publishing cannot fail on their size", async (t) => {
 const f = await fixture(t); f.workflow.reviews = Array.from({ length: 18 }, (_, i) => ({ lens: "quality" as const, fingerprint: `fp${i}`, verdict: "fail" as const, findings: Array.from({ length: 50 }, () => "h".repeat(4000)), at: "now" }));
 const body = renderWorkflowArtifact(f.workflow); assert.ok(body.includes("estado local completo")); assert.ok(Buffer.byteLength(body) < 65536);
});

test("lens warnings are listed in a readable section that says they do not block, bounded explicitly", async (t) => {
 const f = await fixture(t);
 f.workflow.recipe = { route: "direct", classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Fix", approach: "Fix", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Test", command: "npm test" }], lenses: ["compliance", "security", "quality"], executor: { mode: "inline", writers: 0 } };
 f.workflow.evidence = [{ id: "E1", kind: "verification", command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed", output: "ok", fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }];
 f.workflow.reviews = [{ lens: "compliance", fingerprint: "fp", verdict: "unknown", findings: ["No hay historial rojo/verde"], at: "now" }, { lens: "security", fingerprint: "fp", verdict: "pass", findings: [], at: "now" }];
 const body = renderWorkflowArtifact(f.workflow);
 assert.match(body, /## Avisos de los lentes/); assert.match(body, /no bloquean/i);
 assert.match(body, /compliance · unknown/); assert.match(body, /No hay historial rojo\/verde/); assert.match(body, /security · pass/); assert.match(body, /quality · sin correr/);
 f.workflow.reviews = [{ lens: "compliance", fingerprint: "fp", verdict: "fail", findings: Array.from({ length: 100 }, () => "h".repeat(4000)), at: "now" }];
 const bounded = renderWorkflowArtifact(f.workflow); assert.match(bounded, /Avisos de los lentes/); assert.ok(bounded.includes("estado local completo")); assert.ok(Buffer.byteLength(bounded) < 65536);
});
