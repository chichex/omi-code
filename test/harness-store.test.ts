import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, stat, symlink, readdir } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { sourceHash, type Workflow } from "../src/harness/model.ts";
import { workflowPath, readWorkflow, updateWorkflow, WorkflowConflictError } from "../src/harness/store.ts";

async function fixture() { const dir = await realpath(await mkdtemp(join(tmpdir(), "omi-state-"))); const checkout = { root: dir, commonDir: join(dir, ".git"), branch: "work", baseCommit: "base" }; await mkdir(checkout.commonDir); const source = { number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") }; return { dir, checkout, state: createWorkflow(source, checkout, "id", "now") }; }
const pause = (s: Workflow | undefined) => { assert.ok(s); return transition(s, { type: "pause", reason: "later" }, "later"); };

test("store path is common to worktrees; missing reads do not create files", async () => {
 const f = await fixture(); try { assert.equal(workflowPath(f.checkout, 7), join(f.checkout.commonDir, "omi/development/7.json")); assert.equal(await readWorkflow(f.checkout, 7), undefined); assert.deepEqual(await readdir(f.checkout.commonDir), []); assert.throws(() => workflowPath(f.checkout, 0)); assert.throws(() => workflowPath(f.checkout, NaN)); } finally { await rm(f.dir, { recursive: true }); }
});
test("atomic private persistence survives a fresh read and optimistic revisions", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); assert.equal((await stat(workflowPath(f.checkout, 7))).mode & 0o777, 0o600); assert.deepEqual(await readWorkflow(f.checkout, 7), f.state); await assert.rejects(updateWorkflow(f.checkout, 7, undefined, () => f.state), WorkflowConflictError); await assert.rejects(updateWorkflow(f.checkout, 7, 8, pause), WorkflowConflictError); const updated = await updateWorkflow(f.checkout, 7, 0, pause); assert.equal(updated.revision, 1); assert.equal((await readWorkflow(f.checkout, 7))?.status, "paused"); assert.deepEqual((await readdir(join(f.checkout.commonDir, "omi/development"))).sort(), ["7.json"]); } finally { await rm(f.dir, { recursive: true }); }
});
test("all checkout identity fields and issue number are checked", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); for (const field of ["root", "branch", "baseCommit"] as const) await assert.rejects(readWorkflow({ ...f.checkout, [field]: `${f.checkout[field]}-other` }, 7)); const path = workflowPath(f.checkout, 7); await writeFile(path, JSON.stringify({ ...f.state, checkout: { ...f.checkout, commonDir: "/other" } })); await assert.rejects(readWorkflow(f.checkout, 7)); await writeFile(path, JSON.stringify({ ...f.state, source: { ...f.state.source, number: 8 } })); await assert.rejects(readWorkflow(f.checkout, 7)); } finally { await rm(f.dir, { recursive: true }); }
});
test("corruption, oversized files, and invalid changes cannot replace saved state", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); const path = workflowPath(f.checkout, 7); const initial = await readFile(path, "utf8"); await assert.rejects(updateWorkflow(f.checkout, 7, 0, () => ({ ...f.state, revision: 0 }))); assert.equal(await readFile(path, "utf8"), initial); await assert.rejects(updateWorkflow(f.checkout, 7, 0, () => { throw new Error("adapter"); })); assert.equal((await updateWorkflow(f.checkout, 7, 0, pause)).revision, 1); await writeFile(path, "{broken"); await assert.rejects(readWorkflow(f.checkout, 7)); await assert.rejects(updateWorkflow(f.checkout, 7, undefined, () => f.state)); await writeFile(path, " ".repeat(9 * 1024 * 1024)); await assert.rejects(readWorkflow(f.checkout, 7)); } finally { await rm(f.dir, { recursive: true }); }
});
test("concurrent writers cannot both consume the same revision", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); const results = await Promise.allSettled([updateWorkflow(f.checkout, 7, 0, pause), updateWorkflow(f.checkout, 7, 0, pause)]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1); assert.equal((await readWorkflow(f.checkout, 7))?.revision, 1); } finally { await rm(f.dir, { recursive: true }); }
});
test("symlinks in state, directories and lock are refused without touching targets", async () => {
 for (const target of ["state", "directory", "lock"]) { const f = await fixture(); try { const outside = join(f.dir, "outside"); await writeFile(outside, "untouched"); const directory = join(f.checkout.commonDir, "omi/development"); if (target === "directory") { await symlink(f.dir, join(f.checkout.commonDir, "omi")); } else { await mkdir(directory, { recursive: true }); await symlink(outside, target === "state" ? workflowPath(f.checkout, 7) : `${workflowPath(f.checkout, 7)}.lock`); } await assert.rejects(updateWorkflow(f.checkout, 7, undefined, () => f.state)); if (target !== "lock") await assert.rejects(readWorkflow(f.checkout, 7)); assert.equal(await readFile(outside, "utf8"), "untouched"); } finally { await rm(f.dir, { recursive: true }); } }
});
test("an existing owner lock is not stolen, even after a restart or old timestamp", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); const lock = `${workflowPath(f.checkout, 7)}.lock`; await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: hostname(), at: "1970-01-01" })); await assert.rejects(updateWorkflow(f.checkout, 7, 0, pause), WorkflowConflictError); assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, 99999999); assert.equal((await readWorkflow(f.checkout, 7))?.revision, 0); } finally { await rm(f.dir, { recursive: true }); }
});
test("a held lock names the file a person must inspect before removing it", async () => {
 const f = await fixture(); try { await updateWorkflow(f.checkout, 7, undefined, () => f.state); const lock = `${workflowPath(f.checkout, 7)}.lock`; await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: hostname() }));
  await assert.rejects(updateWorkflow(f.checkout, 7, 0, pause), (error: unknown) => error instanceof WorkflowConflictError && error.message.includes(lock) && /PID/.test(error.message)); } finally { await rm(f.dir, { recursive: true }); }
});
