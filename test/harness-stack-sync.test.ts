// Actualizar un stack: Git real contra un remoto bare local que hace de GitHub; gh falso, nunca red.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { processRunner, type Runner } from "../src/core/exec.ts";
import type { StackPull, Workflow } from "../src/harness/model.ts";
import { sourceHash } from "../src/harness/model.ts";
import { syncStack } from "../src/harness/stack-sync.ts";
import { tempDir } from "./helpers/io.ts";

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
type Pr = { state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean; branch: string; base: string; finalHead?: string; mergeCommit?: string };

async function fixture(t: TestContext) {
 const home = await tempDir(t); const bare = join(home, "remote.git"); const root = join(home, "repo"); await mkdir(root);
 const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
 run(home, "init", "-q", "--bare", "-b", "main", bare);
 run(root, "init", "-q", "-b", "main"); run(root, "config", "user.email", "test@example.test"); run(root, "config", "user.name", "Test"); run(root, "config", "commit.gpgsign", "false");
 run(root, "remote", "add", "origin", "https://github.com/acme/repo.git");
 const commit = async (path: string, body: string, message: string) => { await writeFile(join(root, path), body); run(root, "add", path); run(root, "commit", "-q", "-m", message); return run(root, "rev-parse", "HEAD"); };
 const base = await commit("README.md", "base\n", "chore: base"); run(root, "push", "-q", bare, "main");
 run(root, "checkout", "-q", "-b", "feat/task");
 // C3 cambia una línea que agregó C1: un merge común de main después de un squash de C1+C2 choca.
 const h1 = await commit("a.txt", "uno\n", "feat: C1"); const h2 = await commit("b.txt", "dos\n", "feat: C2"); const h3 = await commit("a.txt", "tres\n", "feat: C3");
 run(root, "push", "-q", bare, `${h2}:refs/heads/feat/task-1`, `${h3}:refs/heads/feat/task-2`);
 const prs = new Map<number, Pr>([[3, { state: "OPEN", isDraft: true, branch: "feat/task-1", base: "main" }], [4, { state: "OPEN", isDraft: true, branch: "feat/task-2", base: "feat/task-1" }]]);
 // GitHub mantiene refs/pull/N/head en la punta de la rama de cada PR abierto.
 const refreshPulls = () => { for (const [number, pr] of prs) if (pr.state === "OPEN") run(bare, "update-ref", `refs/pull/${number}/head`, run(bare, "rev-parse", `refs/heads/${pr.branch}`)); };
 refreshPulls();
 const url = (n: number) => `https://github.com/acme/repo/pull/${n}`;
 const pull = (n: number, title: string, steps: string[], branch: string, baseRef: string, head: string): StackPull => ({ title, steps, branch, base: baseRef, head, number: n, url: url(n), status: "draft" });
 const source = { number: 42, title: "Trabajo grande", body: "Pedido\n", url: "https://github.com/acme/repo/issues/42", hash: sourceHash("Trabajo grande", "Pedido\n") };
 const workflow: Workflow = { version: 1, id: "w", revision: 5, source, checkout: { root, commonDir: join(root, ".git"), branch: "feat/task", baseCommit: base }, phase: "done", status: "complete", blockedReason: "", activity: "published",
  exploration: null, inferences: [], recipe: null, diagnosis: null, spec: null, steps: [], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: null,
  publication: { status: "opened", head: h3, url: url(4), number: 4, stack: [pull(3, "Modelo", ["C1", "C2"], "feat/task-1", "main", h2), pull(4, "Vista", ["C3"], "feat/task-2", "feat/task-1", h3)] }, history: [] };
 const calls: { command: string; args: string[] }[] = [];
 const runner: Runner = { async run(command, args, options) {
  calls.push({ command, args });
  if (command === "git") {
   const sub = args.slice(args.indexOf("-C") + 2)[0];
   if (sub === "push" || sub === "fetch" || sub === "ls-remote") {
    const index = args.indexOf("origin"); if (index < 0) throw new Error("Remoto no previsto");
    const result = await processRunner.run("git", args.map((a, i) => i === index ? bare : a), options);
    if (sub === "push" && result.code === 0) refreshPulls();
    return result;
   }
   if (args.includes("origin") && sub !== "remote") throw new Error(`git remoto no previsto: ${args.join(" ")}`);
   return processRunner.run("git", args, { ...options, env: { ...options?.env, ...identity } });
  }
  if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "acme/repo", url: "https://github.com/acme/repo" }), stderr: "" };
  if (args[0] === "pr" && args[1] === "view") {
   const number = Number(args[2]); const pr = prs.get(number); if (!pr) return { code: 1, stdout: "", stderr: "no PR" };
   const headRefOid = pr.finalHead ?? run(bare, "rev-parse", `refs/heads/${pr.branch}`);
   return { code: 0, stdout: JSON.stringify({ number, url: url(number), state: pr.state, isDraft: pr.isDraft, isCrossRepository: false, headRefName: pr.branch, baseRefName: pr.base, headRefOid, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null }), stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "edit" && args[3] === "--repo" && args[4] === "acme/repo" && args[5] === "--base" && args.length === 7) { prs.get(Number(args[2]))!.base = args[6]!; return { code: 0, stdout: "", stderr: "" }; }
  throw new Error(`Llamada remota no prevista: ${args.join(" ")}`);
 } };
 // Una persona sube un commit a una rama del remoto, desde otro clon.
 const pushTo = async (branch: string, path: string, body: string, message: string) => {
  const clone = join(home, `clone-${calls.length}-${Math.random().toString(36).slice(2)}`); run(home, "clone", "-q", "--branch", branch, bare, clone);
  run(clone, "config", "user.email", "test@example.test"); run(clone, "config", "user.name", "Test");
  await writeFile(join(clone, path), body); run(clone, "add", path); run(clone, "commit", "-q", "-m", message); run(clone, "push", "-q", "origin", branch); refreshPulls();
  return run(clone, "rev-parse", "HEAD");
 };
 const pushToLower = (path: string, body: string) => pushTo("feat/task-1", path, body, "fix: review del PR 1");
 // main avanza con otro cambio y GitHub hace squash del PR 3 encima: un commit nuevo, sin los commits del PR.
 const squashLower = async () => {
  const advanced = await pushTo("main", "otro.txt", "otro\n", "chore: otro cambio en main");
  const tree = run(bare, "merge-tree", "--write-tree", advanced, h2).split("\n")[0]!;
  const squash = run(bare, "commit-tree", tree, "-p", advanced, "-m", "feat: modelo (#3)"); run(bare, "update-ref", "refs/heads/main", squash);
  Object.assign(prs.get(3)!, { state: "MERGED", finalHead: h2, mergeCommit: squash });
  return squash;
 };
 const remoteRef = (ref: string) => run(bare, "rev-parse", ref);
 const show = (ref: string, path: string) => run(bare, "show", `${ref}:${path}`);
 return { workflow, runner, calls, prs, h1, h2, h3, run, bare, root, pushToLower, squashLower, remoteRef, show };
}
const pushes = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter((c) => c.command === "git" && c.args.includes("push"));
const edits = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter((c) => c.command === "gh" && c.args[1] === "edit");
const setStack = (f: Awaited<ReturnType<typeof fixture>>, stack: StackPull[]) => { if (f.workflow.publication.status === "opened") f.workflow.publication.stack = stack; };

test("stack_sync no toca nada si el stack ya está al día", async (t) => {
 const f = await fixture(t);
 const result = await syncStack(f.workflow, f.runner);
 assert.deepEqual(result.stack.map((p) => [p.head, p.base, p.status]), [[f.h2, "main", "draft"], [f.h3, "feat/task-1", "draft"]]);
 assert.equal(pushes(f).length, 0); assert.equal(edits(f).length, 0); assert.deepEqual(result.actions, []);
});

test("stack_sync: si cambió el PR de abajo, se mergea en el de arriba con un merge y push normal", async (t) => {
 const f = await fixture(t); const review = await f.pushToLower("c.txt", "cuatro\n");
 const result = await syncStack(f.workflow, f.runner);
 const top = f.remoteRef("refs/heads/feat/task-2");
 assert.equal(f.run(f.bare, "rev-list", "--parents", "-n", "1", top), `${top} ${f.h3} ${review}`, "commit de merge con el de arriba y el de abajo como padres: no hay rebase");
 assert.equal(f.show(top, "c.txt"), "cuatro"); assert.equal(f.show(top, "a.txt"), "tres");
 assert.deepEqual(result.stack.map((p) => [p.head, p.base]), [[review, "main"], [top, "feat/task-1"]]);
 assert.equal(pushes(f).length, 1); assert.equal(pushes(f)[0]?.args.at(-1), `${top}:refs/heads/feat/task-2`);
 assert.ok(f.calls.every((c) => !c.args.includes("--force") && !c.args.includes("rebase") && !c.args.some((a) => /^\+/.test(a))), "nunca rebase ni force push");
 assert.equal(edits(f).length, 0);
 assert.match(result.actions.join("\n"), /feat\/task-2/);
});

test("stack_sync: si el de abajo se mergeó con squash, el de arriba mergea main y se re-apunta a main", async (t) => {
 const f = await fixture(t); const squash = await f.squashLower();
 const plain = await processRunner.run("git", ["-C", f.bare, "merge-tree", "--write-tree", f.h3, squash]);
 assert.equal(plain.code, 1, "un merge común de main choca: C3 cambia una línea que vino en el squash");
 const result = await syncStack(f.workflow, f.runner);
 const top = f.remoteRef("refs/heads/feat/task-2");
 assert.equal(f.run(f.bare, "rev-list", "--parents", "-n", "1", top), `${top} ${f.h3} ${squash}`);
 assert.equal(f.show(top, "a.txt"), "tres"); assert.equal(f.show(top, "b.txt"), "dos"); assert.equal(f.show(top, "otro.txt"), "otro");
 assert.equal(f.run(f.bare, "diff", "--name-only", squash, top), "a.txt", "contra main, el PR de arriba muestra sólo su paso");
 assert.deepEqual(edits(f).map((c) => c.args), [["pr", "edit", "4", "--repo", "acme/repo", "--base", "main"]]);
 assert.equal(f.prs.get(4)?.base, "main");
 assert.deepEqual(result.stack.map((p) => [p.status, p.base, p.head]), [["merged", "main", f.h2], ["draft", "main", top]]);
 setStack(f, result.stack); const before = f.calls.length;
 const again = await syncStack(f.workflow, f.runner);
 assert.deepEqual(again.stack, result.stack); assert.deepEqual(again.actions, []);
 assert.equal(f.calls.slice(before).filter((c) => c.args.includes("push") || c.args[1] === "edit").length, 0, "una segunda corrida no hace nada");
});

test("stack_sync se frena sin escribir ante un conflicto, un PR cerrado o una rama reescrita", async (t) => {
 const conflict = await fixture(t); await conflict.pushToLower("a.txt", "otro\n");
 await assert.rejects(syncStack(conflict.workflow, conflict.runner), /conflicto/i);
 assert.equal(conflict.remoteRef("refs/heads/feat/task-2"), conflict.h3); assert.equal(pushes(conflict).length, 0);
 const closed = await fixture(t); closed.prs.get(3)!.state = "CLOSED";
 await assert.rejects(syncStack(closed.workflow, closed.runner), /cerrado/i); assert.equal(pushes(closed).length, 0);
 const rewritten = await fixture(t); rewritten.run(rewritten.bare, "update-ref", "refs/heads/feat/task-2", rewritten.h1);
 await assert.rejects(syncStack(rewritten.workflow, rewritten.runner), /reescrib/i); assert.equal(pushes(rewritten).length, 0);
 const elsewhere = await fixture(t); Object.assign(elsewhere.prs.get(4)!, { state: "MERGED", finalHead: elsewhere.h3 });
 await assert.rejects(syncStack(elsewhere.workflow, elsewhere.runner), /main/); assert.equal(pushes(elsewhere).length, 0);
 const single = await fixture(t); if (single.workflow.publication.status === "opened") delete single.workflow.publication.stack;
 await assert.rejects(syncStack(single.workflow, single.runner), /stack/); assert.equal(single.calls.length, 0);
});
