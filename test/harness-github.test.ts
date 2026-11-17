import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, CommandOptions } from "../src/core/exec.ts";
import { artifactHash, sourceHash, type Workflow } from "../src/harness/model.ts";
import { readIssueSource, renderWorkflowArtifact, renderPullRequestBody, syncIssueArtifact, publishDraft } from "../src/harness/github.ts";

type Comment = { id: number; body: string; user: { login: string }; html_url: string };
async function fixture(t: import("node:test").TestContext) {
 const root = await mkdtemp(join(tmpdir(), "omi-harness-gh-")); await mkdir(join(root, ".git")); t.after(() => rm(root, { recursive: true, force: true }));
 const head = "b".repeat(40); const checkout = { root, commonDir: join(root, ".git"), branch: "feat/task", baseCommit: "a".repeat(40) };
 const source = { number: 42, title: "$(touch unsafe)", body: "Original\n", url: "https://github.com/acme/repo/issues/42", hash: sourceHash("$(touch unsafe)", "Original\n") };
 const workflow: Workflow = { version: 1, id: "w", revision: 0, source, checkout, phase: "pr", status: "active", blockedReason: "", activity: "testing", exploration: null, inferences: [], recipe: null, diagnosis: null, spec: null, steps: [], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: { sourceHash: source.hash, recipeHash: "approved", at: "now" }, publication: { status: "pending", head, bodyHash: "body", at: "now" }, history: [] };
 if (workflow.publication.status === "pending") workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(workflow));
 const calls: { command: string; args: string[]; options?: CommandOptions }[] = [];
 const state = { issue: { number: 42, title: source.title, body: source.body, url: source.url }, prs: [] as unknown[], comments: [] as Comment[], createError: false, postError: false, storePost: true, remote: "git@github.com:acme/repo.git", head, changeHeadOnList: false, changeHeadOnPush: false, editHumanOnComments: false, pushError: false };
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
  else if (args[0] === "repo") stdout = JSON.stringify({ nameWithOwner: "acme/repo", url: "https://github.com/acme/repo" });
  else if (args[0] === "pr" && args[1] === "list") { stdout = JSON.stringify(state.prs); if (state.changeHeadOnList) state.head = "c".repeat(40); }
  else if (args[0] === "pr" && args[1] === "create") { pr.body = options?.input ?? ""; state.prs = [pr]; if (state.createError) return { code: 1, stdout: "", stderr: "ambiguous" }; stdout = pr.url; }
  else if (args.join(" ") === "api user") stdout = JSON.stringify({ login: "test" });
  else if (args.join(" ") === "api --paginate --slurp repos/acme/repo/issues/42/comments?per_page=100") { stdout = JSON.stringify([[], state.comments]); if (state.editHumanOnComments) state.issue.body = "human concurrent edit"; }
  else if (args.join(" ") === "api repos/acme/repo/issues/42/comments --method POST --input -") {
   const body = JSON.parse(options?.input ?? "{}").body; assert.equal(typeof body, "string");
   const comment = { id: state.comments.length + 1, body, user: { login: "test" }, html_url: `${source.url}#issuecomment-${state.comments.length + 1}` };
   if (state.storePost) state.comments.push(comment);
   if (state.postError) return { code: 1, stdout: "", stderr: "secret must not leak" };
   stdout = JSON.stringify(comment);
  } else throw new Error(`Unexpected remote call: ${args.join(" ")}`);
  return { code: 0, stdout, stderr: "" };
 } };
 return { workflow, state, calls, runner, pr };
}
const posts = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.args.includes("POST"));

test("issue source preserves original bytes and ignores only one well-formed legacy owned block", async (t) => {
 const f = await fixture(t); const first = await readIssueSource(f.workflow.checkout, 42, f.runner);
 f.state.issue.body += "<!-- omi-development:start -->\nartifact\n<!-- omi-development:end -->";
 assert.deepEqual(await readIssueSource(f.workflow.checkout, 42, f.runner), first);
 for (const body of ["<!-- omi-development:start -->", "<!-- omi-development:end -->", "<!-- omi-development:start --><!-- omi-development:start --><!-- omi-development:end -->", "<!-- omi-development:start", "<!-- omi-development:unknown -->"]) {
  f.state.issue.body = body; await assert.rejects(readIssueSource(f.workflow.checkout, 42, f.runner));
 }
});

test("issue artifact appends an owned comment, deduplicates exact body and never mutates issue", async (t) => {
 const f = await fixture(t); const original = structuredClone(f.workflow.source); await syncIssueArtifact(f.workflow, f.runner); await syncIssueArtifact(f.workflow, f.runner);
 assert.equal(posts(f).length, 1); assert.equal(f.state.comments.length, 1); assert.equal(f.state.issue.body, original.body); assert.deepEqual(f.workflow.source, original);
 const body = f.state.comments[0]!.body; assert.ok(body.includes(renderWorkflowArtifact(f.workflow))); assert.ok(body.includes(f.workflow.id)); assert.ok(body.includes(artifactHash(renderWorkflowArtifact(f.workflow))));
 assert.ok(!f.calls.some(c => c.args.includes("edit") || c.args.includes("PATCH") || c.args.includes("DELETE")));
 f.state.comments[0]!.user.login = "someone-else"; await syncIssueArtifact(f.workflow, f.runner); assert.equal(posts(f).length, 2);
 f.state.comments[1]!.body += "human change"; await syncIssueArtifact(f.workflow, f.runner); assert.equal(posts(f).length, 3);
});

test("issue sync checks fresh source but concurrent human edits cannot be overwritten", async (t) => {
 const f = await fixture(t); f.state.issue.body = "human edited"; await assert.rejects(syncIssueArtifact(f.workflow, f.runner)); assert.equal(posts(f).length, 0);
 f.state.issue.body = f.workflow.source.body; f.state.editHumanOnComments = true; await syncIssueArtifact(f.workflow, f.runner);
 assert.equal(f.state.issue.body, "human concurrent edit"); assert.equal(posts(f).length, 1);
});

test("ambiguous comment POST recovers exact owned comment before any retry", async (t) => {
 const f = await fixture(t); f.state.postError = true; await syncIssueArtifact(f.workflow, f.runner); await syncIssueArtifact(f.workflow, f.runner);
 assert.equal(posts(f).length, 1); assert.equal(f.state.comments.length, 1);
 const failed = await fixture(t); failed.state.postError = true; failed.state.storePost = false;
 await assert.rejects(syncIssueArtifact(failed.workflow, failed.runner), error => error instanceof Error && !error.message.includes("secret")); assert.equal(posts(failed).length, 1);
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

test("mandatory spec/inferences are complete or fail asking to divide; oversized bodies never POST", async (t) => {
 const f = await fixture(t); const long = "x".repeat(13000) + "MANDATORY-END"; f.workflow.spec = { why: long, steps: [], playbook: [] };
 assert.ok(renderWorkflowArtifact(f.workflow).includes(long));
 f.workflow.inferences = [{ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer: "y".repeat(70000) }];
 assert.throws(() => renderWorkflowArtifact(f.workflow), /dividir/i); await assert.rejects(syncIssueArtifact(f.workflow, f.runner), /dividir/i); assert.equal(posts(f).length, 0);
 await assert.rejects(publishDraft(f.workflow, f.runner), /dividir/i); assert.equal(f.calls.some(c => c.args.includes("push") || c.args.includes("create")), false);
});

test("mandatory recipe and inferences are never silently bounded by presentation budgets", async (t) => {
 const f = await fixture(t); const objective = "o".repeat(12500) + "RECIPE-END"; const answer = "a".repeat(7000) + "INFERENCE-END";
 f.workflow.recipe = { route: "direct", classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective, approach: "Fix", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Test", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
 f.workflow.inferences = [{ id: "I1", kind: "what", question: "Q", recommended: "R", confidence: 90, irreversible: false, references: [], resolution: "answered", answer }];
 const body = renderWorkflowArtifact(f.workflow); assert.ok(body.includes(objective)); assert.ok(body.includes(answer));
 await syncIssueArtifact(f.workflow, f.runner); assert.ok(f.state.comments[0]?.body.includes(objective)); assert.ok(f.state.comments[0]?.body.includes(answer));
});

test("GitHub body limit includes comment and PR ownership wrappers before any remote write", async (t) => {
 const f = await fixture(t); f.workflow.source.body = "";
 const base = Buffer.byteLength(renderWorkflowArtifact(f.workflow)); f.workflow.source.body = "x".repeat(65530 - base);
 assert.equal(Buffer.byteLength(renderWorkflowArtifact(f.workflow)), 65530);
 if (f.workflow.publication.status === "pending") f.workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(f.workflow));
 await assert.rejects(syncIssueArtifact(f.workflow, f.runner), /dividir/i); await assert.rejects(publishDraft(f.workflow, f.runner), /dividir/i);
 assert.equal(f.calls.length, 0);
});

test("large evidence lists may be summarized explicitly without losing mandatory artifact", async (t) => {
 const f = await fixture(t); f.workflow.evidence = Array.from({ length: 120 }, (_, i) => ({ id: `E${i}`, kind: "verification" as const, command: "npm test", stepId: null, caseId: null, exitCode: 0, outcome: "passed" as const, output: "z".repeat(12000), fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }));
 const body = renderWorkflowArtifact(f.workflow); assert.ok(body.includes("estado local completo")); assert.ok(body.includes("npm test")); assert.ok(body.length < 65536);
});

test("command output never leaves the machine: issue comments and PR carry exit codes, not output", async (t) => {
 const f = await fixture(t); f.workflow.evidence = [{ id: "E1", kind: "verification", command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed", output: "GITHUB_TOKEN=ghp_PRINTED_BY_A_TEST\nok", fingerprint: "fp", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }];
 const body = renderWorkflowArtifact(f.workflow);
 assert.ok(body.includes("npm test")); assert.match(body, /"exitCode": 0/); assert.doesNotMatch(body, /ghp_PRINTED_BY_A_TEST|"output"/);
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
