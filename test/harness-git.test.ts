import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/core/exec.ts";
import type { Evidence } from "../src/harness/model.ts";
import { inspectCheckout, validateReferences, readWorkflowDiff, assertStepCommit } from "../src/harness/git.ts";

async function fixture(t: import("node:test").TestContext) {
 const root = await mkdtemp(join(tmpdir(), "omi-harness-git-")); await mkdir(join(root, ".git"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const checkout = { root, commonDir: join(root, ".git"), branch: "feat/task", baseCommit: "a".repeat(40) };
 const state = { branch: "feat/task", head: "b".repeat(40), status: " M a\0", paths: "a\0", untracked: "", diff: "diff content", failure: "", parent: "b".repeat(40) };
 const calls: string[][] = [];
 const runner: Runner = { async run(command, args) {
  assert.equal(command, "git"); calls.push(args);
  const a = args.slice(args.indexOf("-C") + 2); const key = a[0];
  let stdout = "";
  if (key === state.failure) return { code: 1, stdout: "", stderr: "failed" };
  if (key === "rev-parse") stdout = a.includes("--show-toplevel") ? root : a.includes("--git-common-dir") ? checkout.commonDir : a.includes("HEAD^") ? state.parent : state.head;
  else if (key === "symbolic-ref") stdout = `refs/heads/${state.branch}`;
  else if (key === "rev-list") stdout = `${state.head} ${state.parent}`;
  else if (key === "status") stdout = state.status;
  else if (key === "diff") stdout = a.includes("--name-only") ? state.paths : state.diff;
  else if (key === "ls-files") stdout = state.untracked;
  return { code: 0, stdout, stderr: "" };
 } };
 return { checkout, state, calls, runner };
}

test("fingerprint hashes content, remains stable through stage and commit, detects deletion and mode", async (t) => {
 const f = await fixture(t); await writeFile(join(f.checkout.root, "a"), "one\ntwo\n");
 const first = await inspectCheckout(f.checkout, f.runner);
 f.state.status = "M  a\0"; assert.equal((await inspectCheckout(f.checkout, f.runner)).fingerprint, first.fingerprint);
 f.state.status = ""; f.state.head = "c".repeat(40);
 const committed = await inspectCheckout(f.checkout, f.runner); assert.equal(committed.fingerprint, first.fingerprint); assert.equal(committed.clean, true);
 await chmod(join(f.checkout.root, "a"), 0o755); assert.notEqual((await inspectCheckout(f.checkout, f.runner)).fingerprint, first.fingerprint);
 await writeFile(join(f.checkout.root, "a"), "changed"); assert.notEqual((await inspectCheckout(f.checkout, f.runner)).fingerprint, first.fingerprint);
 await rm(join(f.checkout.root, "a")); assert.notEqual((await inspectCheckout(f.checkout, f.runner)).fingerprint, first.fingerprint);
 assert.ok(f.calls.filter(a => a.includes("diff")).every(a => a.includes("--no-ext-diff") && a.includes("--no-textconv")));
 assert.ok(f.calls.every(a => !a.includes("add") && !a.includes("hash-object")));
});

test("identity errors and Git errors never become clean", async (t) => {
 const f = await fixture(t); await writeFile(join(f.checkout.root, "a"), "one");
 for (const branch of ["main", "master", "HEAD", "other"]) { f.state.branch = branch; await assert.rejects(inspectCheckout(f.checkout, f.runner)); }
 f.state.branch = f.checkout.branch; f.state.failure = "merge-base"; await assert.rejects(inspectCheckout(f.checkout, f.runner));
 f.state.failure = "status"; await assert.rejects(inspectCheckout(f.checkout, f.runner));
});

test("untracked content and symlink targets contribute without following external links", async (t) => {
 const f = await fixture(t); f.state.paths = ""; f.state.untracked = "link\0";
 await symlink("/outside/secret", join(f.checkout.root, "link"));
 const a = await inspectCheckout(f.checkout, f.runner);
 await rm(join(f.checkout.root, "link")); await symlink("/other/secret", join(f.checkout.root, "link"));
 assert.notEqual((await inspectCheckout(f.checkout, f.runner)).fingerprint, a.fingerprint);
 await assert.rejects(validateReferences(f.checkout, [{ path: "link", line: 1, detail: "bad" }]));
});

test("references must point to real local lines; oversized review fails closed", async (t) => {
 const f = await fixture(t); await writeFile(join(f.checkout.root, "a"), "one\ntwo\n");
 await validateReferences(f.checkout, [{ path: "a", line: 2, detail: "exists" }]);
 await assert.rejects(validateReferences(f.checkout, [{ path: "../secret", line: 1, detail: "bad" }]));
 await assert.rejects(validateReferences(f.checkout, [{ path: "a", line: 4, detail: "bad" }]));
 f.state.diff = "x".repeat(50001); await assert.rejects(readWorkflowDiff(f.checkout, f.runner), /humana|achicar/i);
});

test("step commits require green evidence of the same tree and immediate parent", async (t) => {
 const f = await fixture(t); await writeFile(join(f.checkout.root, "a"), "one"); f.state.status = "";
 const snapshot = await inspectCheckout(f.checkout, f.runner);
 const evidence: Evidence = { id: "e", kind: "green", stepId: "s", caseId: "c", command: "test", exitCode: 0, outcome: "passed", output: "ok", fingerprint: snapshot.fingerprint, head: f.state.parent, startedAt: "now", finishedAt: "now" };
 f.state.head = "c".repeat(40); await assertStepCommit(f.checkout, evidence, f.state.head, f.runner);
 await assert.rejects(assertStepCommit(f.checkout, { ...evidence, head: "d".repeat(40) }, f.state.head, f.runner));
 await assert.rejects(assertStepCommit(f.checkout, { ...evidence, fingerprint: "stale" }, f.state.head, f.runner));
});
