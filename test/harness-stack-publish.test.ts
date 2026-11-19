// Publicar un stack: cada PR con las mismas validaciones que el PR único, contra un GitHub falso.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOptions, Runner } from "../src/core/exec.ts";
import { artifactHash, sourceHash, type Workflow } from "../src/harness/model.ts";
import { renderPullRequestBody } from "../src/harness/github.ts";
import { renderWorkflowArtifact } from "../src/harness/pr-body.ts";
import { publishStack } from "../src/harness/stack-publish.ts";

const h1 = "1".repeat(40); const h2 = "2".repeat(40); const base = "a".repeat(40);
async function fixture(t: TestContext) {
 const root = await mkdtemp(join(tmpdir(), "omi-stack-gh-")); await mkdir(join(root, ".git")); t.after(() => rm(root, { recursive: true, force: true }));
 const checkout = { root, commonDir: join(root, ".git"), branch: "feat/task", baseCommit: base };
 const source = { number: 42, title: "Trabajo grande", body: "Pedido\n", url: "https://github.com/acme/repo/issues/42", hash: sourceHash("Trabajo grande", "Pedido\n") };
 const step = (id: string, commit: string) => ({ id, title: `Paso ${id}`, cases: ["D1"], status: "done" as const, red: null, green: null, commit });
 const stack = [{ title: "Modelo", steps: ["C1"], branch: "feat/task-1", base: "main", head: h1, number: null, url: null, status: "planned" as const }, { title: "Vista", steps: ["C2"], branch: "feat/task-2", base: "feat/task-1", head: h2, number: null, url: null, status: "planned" as const }];
 const workflow: Workflow = { version: 1, id: "w", revision: 0, source, checkout, phase: "pr", status: "active", blockedReason: "", activity: "testing", exploration: null, inferences: [], recipe: null, diagnosis: null,
  spec: { why: "grande", steps: [{ id: "C1", title: "Paso C1", cases: ["D1"] }, { id: "C2", title: "Paso C2", cases: ["D1"] }], playbook: ["probar"], stack: [{ title: "Modelo", steps: ["C1"] }, { title: "Vista", steps: ["C2"] }] },
  steps: [step("C1", h1), step("C2", h2)], evidence: [], reviews: [], round: 0, maxRounds: 3, approval: { sourceHash: source.hash, recipeHash: "approved", at: "now" },
  publication: { status: "pending", head: h2, bodyHash: "body", at: "now", stack }, history: [] };
 if (workflow.publication.status === "pending") workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(workflow));
 const calls: { command: string; args: string[]; options?: CommandOptions }[] = [];
 const pushed = new Map<string, string>();
 type Pr = { number: number; url: string; state: string; isDraft: boolean; isCrossRepository: boolean; headRefName: string; baseRefName: string; headRefOid: string; body: string };
 const state = { issue: { number: 42, title: source.title, body: source.body, url: source.url }, prs: [] as Pr[], head: h2, ancestors: new Set([`${h1} ${h2}`]), createErrorOn: "", };
 const runner: Runner = { async run(command, args, options) {
  calls.push({ command, args, ...(options ? { options } : {}) }); let stdout = "";
  if (command === "git") {
   const a = args.slice(args.indexOf("-C") + 2);
   if (a[0] === "rev-parse") stdout = a.includes("--show-toplevel") ? root : a.includes("--git-common-dir") ? checkout.commonDir : state.head;
   else if (a[0] === "symbolic-ref") stdout = `refs/heads/${checkout.branch}`;
   else if (a[0] === "remote") stdout = "git@github.com:acme/repo.git";
   else if (a[0] === "merge-base" && a[1] === "--is-ancestor") { if (a[2] !== base && a[2] !== a[3] && !state.ancestors.has(`${a[2]} ${a[3]}`)) return { code: 1, stdout: "", stderr: "" }; }
   else if (a[0] === "push") { const [sha, ref] = a.at(-1)!.split(":"); pushed.set(ref!.replace("refs/heads/", ""), sha!); }
  } else if (args[0] === "issue" && args[1] === "view") stdout = JSON.stringify(state.issue);
  else if (args[0] === "repo") stdout = JSON.stringify({ nameWithOwner: "acme/repo", url: "https://github.com/acme/repo" });
  else if (args[0] === "pr" && args[1] === "list") { const head = args[args.indexOf("--head") + 1]; const baseRef = args[args.indexOf("--base") + 1]; stdout = JSON.stringify(state.prs.filter((p) => p.headRefName === head && p.baseRefName === baseRef)); }
  else if (args[0] === "pr" && args[1] === "create") {
   const head = args[args.indexOf("--head") + 1]!; const number = 3 + state.prs.length;
   state.prs.push({ number, url: `https://github.com/acme/repo/pull/${number}`, state: "OPEN", isDraft: args.includes("--draft"), isCrossRepository: false, headRefName: head, baseRefName: args[args.indexOf("--base") + 1]!, headRefOid: pushed.get(head) ?? "", body: options?.input ?? "" });
   if (state.createErrorOn === head) { state.createErrorOn = ""; return { code: 1, stdout: "", stderr: "ambiguous" }; }
   stdout = `https://github.com/acme/repo/pull/${number}`;
  } else throw new Error(`Llamada remota no prevista: ${args.join(" ")}`);
  return { code: 0, stdout, stderr: "" };
 } };
 return { workflow, state, calls, runner, pushed };
}
const creates = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create");
const pushes = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter((c) => c.command === "git" && c.args.includes("push"));

test("stack_publish abre un draft por grupo, en orden: el primero sobre main y cada uno sobre la rama de abajo", async (t) => {
 const f = await fixture(t);
 const receipt = await publishStack(f.workflow, f.runner);
 assert.deepEqual(receipt, { number: 4, url: "https://github.com/acme/repo/pull/4", head: h2, stack: [{ number: 3, url: "https://github.com/acme/repo/pull/3" }, { number: 4, url: "https://github.com/acme/repo/pull/4" }] });
 assert.deepEqual(pushes(f).map((c) => c.args.at(-1)), [`${h1}:refs/heads/feat/task-1`, `${h2}:refs/heads/feat/task-2`], "cada rama apunta al commit del último paso de su grupo");
 assert.ok(pushes(f).every((c) => !c.args.includes("--force") && !c.args.some((a) => a.startsWith("+"))), "push normal, nunca forzado");
 const [first, second] = creates(f);
 assert.ok(first?.args.includes("--draft") && second?.args.includes("--draft"));
 assert.deepEqual([first?.args[first.args.indexOf("--base") + 1], first?.args[first.args.indexOf("--head") + 1]], ["main", "feat/task-1"]);
 assert.deepEqual([second?.args[second.args.indexOf("--base") + 1], second?.args[second.args.indexOf("--head") + 1]], ["feat/task-1", "feat/task-2"]);
 assert.match(first?.args[first.args.indexOf("--title") + 1] ?? "", /^Trabajo grande · PR 1\/2: Modelo$/);
 const [low, top] = [first?.options?.input ?? "", second?.options?.input ?? ""];
 assert.match(low, /^Refs #42$/m); assert.doesNotMatch(low, /Closes/, "el de abajo sólo referencia el issue");
 assert.match(top, /^Closes #42$/m, "sólo el último PR cierra el issue");
 assert.match(low, /^Stack: PR 1 de 2 · pasos C1 · base `main`$/m);
 assert.match(top, /^Stack: PR 2 de 2 · pasos C2 · sobre #3 \(rama `feat\/task-1`\)$/m);
 assert.ok(low.includes(`head=${h1}`) && top.includes(`head=${h2}`), "cada PR liga su propio head");
 assert.equal(top, renderPullRequestBody(f.workflow, { index: 1, below: 3 }));
});

test("stack_publish recupera un stack a medias sin duplicar ningún PR", async (t) => {
 const f = await fixture(t); f.state.createErrorOn = "feat/task-2";
 const first = await publishStack(f.workflow, f.runner);
 const again = await publishStack(f.workflow, f.runner);
 assert.deepEqual(again, first);
 assert.equal(creates(f).length, 2, "ni el create ambiguo ni la segunda corrida duplican");
 const partial = await fixture(t);
 partial.pushed.set("feat/task-1", h1);
 partial.state.prs.push({ number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: "feat/task-1", baseRefName: "main", headRefOid: h1, body: renderPullRequestBody(partial.workflow, { index: 0 }) });
 const receipt = await publishStack(partial.workflow, partial.runner);
 assert.equal(receipt.stack[0]?.number, 3); assert.equal(creates(partial).length, 1, "el PR 1 de una corrida anterior se recupera");
});

test("stack_publish exige a cada PR las validaciones del PR único y falla antes de escribir lo que puede", async (t) => {
 const foreign = await fixture(t);
 foreign.state.prs.push({ number: 9, url: "https://github.com/acme/repo/pull/9", state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: "feat/task-1", baseRefName: "main", headRefOid: h1, body: "PR ajeno en la misma rama" });
 await assert.rejects(publishStack(foreign.workflow, foreign.runner), /ajeno|duplica/); assert.equal(creates(foreign).length, 0); assert.equal(pushes(foreign).length, 0);
 const unrelated = await fixture(t); unrelated.state.ancestors.clear();
 await assert.rejects(publishStack(unrelated.workflow, unrelated.runner), /stack/); assert.equal(pushes(unrelated).length, 0, "un head que no está debajo del de arriba no se publica");
 const raced = await fixture(t); raced.state.head = "c".repeat(40);
 await assert.rejects(publishStack(raced.workflow, raced.runner), /HEAD/); assert.equal(pushes(raced).length, 0);
 const changed = await fixture(t); changed.state.issue.body = "Otro pedido\n";
 await assert.rejects(publishStack(changed.workflow, changed.runner), /pedido/); assert.equal(pushes(changed).length, 0);
 // El cuerpo del PR único entra justo en GitHub con su marcador, pero no con el Refs y la línea del stack de cada PR.
 const big = await fixture(t); big.workflow.source.body = "";
 const marker = "<!-- omi-development:pr identity= source= head= artifact= -->".length + 4 * 64;
 big.workflow.source.body = "x".repeat(65536 - 1 - marker - Buffer.byteLength(renderWorkflowArtifact(big.workflow)));
 if (big.workflow.publication.status === "pending") big.workflow.publication.bodyHash = artifactHash(renderWorkflowArtifact(big.workflow));
 await assert.rejects(publishStack(big.workflow, big.runner), /dividir/); assert.equal(big.calls.length, 0, "un cuerpo que no entra falla antes de cualquier llamada");
 const single = await fixture(t); if (single.workflow.publication.status === "pending") delete single.workflow.publication.stack;
 await assert.rejects(publishStack(single.workflow, single.runner), /stack/); assert.equal(single.calls.length, 0);
});
