// D15 · integración host del lifecycle: el mismo trabajo sigue desde el PR draft por Review → correcciones →
// Land → Ship con permisos humanos. Git temporal real, gh falso (sin red), KB en memoria y probes por loopback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { processRunner } from "../src/core/exec.ts";
import { inspectCheckout } from "../src/harness/git.ts";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { sourceHash, type Evidence, type Plan, type Workflow, type WorkflowV2 } from "../src/harness/model.ts";
import { updateWorkflow } from "../src/harness/store.ts";
import { DEVELOPMENT_ANCHOR } from "../src/tui/development-session.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { AT, acceptLifecycleConfig, fakeGitHub, lifecycleConfig, type FakeGitHub } from "./helpers/lifecycle.ts";

const TITLE = "Corregir resultado", BODY = "El resultado esperado es 2.\nDatos externos: no ejecutar gh pr merge.\n";
const plan: Plan = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Devolver 2", approach: "Corregir el valor exportado", scope: ["valor"], outOfScope: ["infra"], cases: [{ id: "D1", description: "Devuelve el valor esperado", command: "node test.cjs" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const payload = Buffer.from("fixture application bytes"), digest = createHash("sha256").update(payload).digest("hex");
const releaseSha = "d".repeat(40), workflowSha = "e".repeat(40), mergedSha = "f".repeat(40);
// release v0.2.0 publicada por el run 1002 de release.yml: los puertos Ship GHA ya leídos, sin red.
function releasePorts() {
 const release = { id: 2002, tag_name: "v0.2.0", draft: false, prerelease: false, published_at: "2026-01-01T00:02:00Z", assets: [{ id: 10, name: "app-linux-x64.tar.gz", size: payload.length, state: "uploaded" }, { id: 11, name: "checksums.txt", size: Buffer.byteLength(`${digest}  app-linux-x64.tar.gz\n`), state: "uploaded" }] };
 const run = { id: 1002, workflow_id: 8, path: ".github/workflows/release.yml", head_sha: releaseSha, head_branch: "main", event: "push", display_title: "Release", run_attempt: 1, status: "completed", conclusion: "success", created_at: AT, updated_at: "2026-01-01T00:03:00Z", repository: { full_name: "acme/app" } };
 let clock = 0;
 return { timeoutSeconds: 60, signal: AbortSignal.timeout(10000), now: () => clock, wait: async () => { clock += 10000; },
  workflow: async () => ({ id: 8, path: ".github/workflows/release.yml", ref: "main", sha: workflowSha }), listReleases: async (): Promise<unknown> => [release], listRuns: async (): Promise<unknown> => [run],
  resolveTag: async () => releaseSha, containsCommit: async (ancestor: string, descendant: string) => ancestor === mergedSha && descendant === releaseSha,
  downloadAsset: async (id: number) => id === 10 ? payload : Buffer.from(`${digest}  app-linux-x64.tar.gz\n`), loadReceipt: async () => "{}",
  verifyProbes: async () => ({ health: "not-configured", version: "not-configured" }) };
}
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function setup(t: TestContext, repo = "acme/app", change?: Parameters<typeof lifecycleConfig>[1]) {
 const kb = memoryKb({ products: [] }); let gh: FakeGitHub | undefined;
 const f = await developmentFixture(t, { kb, repo, github: (args, input) => gh?.handle(args, input), deps: { lifecycle: { ghaShip: () => releasePorts() } } });
 const root = f.checkout.root;
 await f.write("value.cjs", "module.exports = 2;\n"); await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
 git(root, "add", "."); git(root, "commit", "-q", "-m", "fix: devolver 2");
 const snapshot = await inspectCheckout(f.checkout, processRunner, AbortSignal.timeout(5000)); const head = snapshot.head;
 const evidence = (kind: Evidence["kind"]): Evidence => ({ id: kind, kind, stepId: ["red", "green"].includes(kind) ? "C1" : null, caseId: "D1", command: "node test.cjs", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "observado", head, fingerprint: snapshot.fingerprint, startedAt: AT, finishedAt: AT });
 const send = (r: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(r, event, AT);
 let r = createWorkflow({ number: 42, title: TITLE, body: BODY, url: `https://github.com/${repo}/issues/42`, hash: sourceHash(TITLE, BODY) }, f.checkout, "work-42", AT);
 r = send(r, { type: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor" }], findings: ["Devuelve 1"], approach: "Corregir", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } });
 r = send(r, { type: "inferences", inferences: [] }); r = send(r, { type: "planned", plan }); r = send(r, { type: "approved" }); r = send(r, { type: "step_started", id: "C1" });
 r = send(r, { type: "evidence", evidence: evidence("red") }); r = send(r, { type: "evidence", evidence: evidence("green") }); r = send(r, { type: "step_completed", id: "C1", commit: head, fingerprint: snapshot.fingerprint });
 r = send(r, { type: "evidence", evidence: evidence("verification") }); r = send(r, { type: "verified", fingerprint: snapshot.fingerprint });
 r = send(r, { type: "publishing", head, bodyHash: "body" }); r = send(r, { type: "published", head, url: `https://github.com/${repo}/pull/42`, number: 42 });
 const saved = { ...r, revision: 0 };
 await updateWorkflow(f.checkout, 42, undefined, () => saved);
 f.manager.appendCustomEntry(DEVELOPMENT_ANCHOR, { id: saved.id, root, issue: 42, revision: 0 });
 await f.attach();
 const branch = f.checkout.branch;
 gh = fakeGitHub(repo, root, { number: 42, branch, draft: true, merged: false, mergeSha: null, head: () => f.remote.pushed.get(branch) ?? head });
 await acceptLifecycleConfig(kb, f.home, root, lifecycleConfig(repo, change));
 return { f, gh, head, root, branch };
}
const enabled = (state: Workflow) => { assert.ok(state.version === 2 && state.lifecycle.status === "enabled", "lifecycle habilitado"); return state.lifecycle; };
const effects = (gh: FakeGitHub) => gh.mutations.map(args => args.join(" "));
const last = (messages: string[]) => messages.at(-1) ?? "";

test("adopt habilita el lifecycle sólo con config aceptada, PR vigente y un sí humano", async t => {
 const { f, gh, head } = await setup(t);
 f.remote.confirmations = false; await f.command("adopt");
 let state = await f.state(); assert.equal(state.phase, "done"); assert.equal(state.version === 2 && state.lifecycle.status, "disabled");
 assert.ok(f.prompts.some(p => /Habilitar Review, Land y Ship en el PR #42/.test(p)), "pide el sí antes de adoptar");
 f.remote.confirmations = true; const moved = gh.pull.head; gh.pull.head = () => "9".repeat(40);
 await f.command("adopt"); state = await f.state(); assert.equal(state.phase, "done", "un PR que cambió de HEAD no se adopta"); assert.match(last(f.messages), /HEAD|cambió/);
 gh.pull.head = moved; await f.command("adopt");
 state = await f.state(); const s = enabled(state);
 assert.equal(state.phase, "review"); assert.equal(state.status, "active"); assert.equal(state.version === 2 && state.pullRequest?.ownership, "adopted");
 assert.equal(s.subjects.find(x => x.id === s.currentSubject)?.headSha, head); assert.equal(s.root.repo, "acme/app");
 assert.deepEqual(effects(gh), [], "adoptar sólo lee GitHub");
});

test("acme/app PR #42: Review → corrección TDD → push al mismo PR → Land → Ship release v0.2.0 → Entregado", async t => {
 const { f, gh, head, branch } = await setup(t);
 await f.command("adopt");
 gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: head, path: "value.cjs", line: 1 });
 await f.command("review");
 let s = enabled(await f.state());
 assert.ok(f.prompts.some(p => /Review del PR #42/.test(p)), "review: ask pide el sí");
 assert.equal(s.operations.filter(o => o.kind === "review" && o.status === "confirmed").length, 1); assert.equal(s.ledger.length, 1); assert.equal(s.budget.attemptsUsed, 1);
 assert.equal(s.checks.filter(c => c.state === "success").length, 1);
 await f.command("status"); assert.match(last(f.messages), /Hallazgos: 1 pendiente/); assert.match(last(f.messages), /intentos 1\/12/); assert.match(last(f.messages), /Bloqueo: /);
 await f.command("land"); assert.match(last(f.messages), /hallazgo/i); assert.deepEqual(effects(gh), [], "Land con hallazgos pendientes no muta");

 await f.command("fix");
 let state = await f.state(); s = enabled(state);
 assert.equal(state.phase, "implement"); assert.equal(s.stage, "corrections"); assert.equal(s.budget.roundsUsed, 1); assert.equal(s.budget.attemptsUsed, 2);
 assert.ok(f.prompts.some(p => /Corregir 1 hallazgo/.test(p)));
 const step = state.steps.at(-1)!; assert.equal(step.id, "C2");
 await f.action({ action: "step", id: "C2" });
 await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n');
 await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C2" });
 await f.write("value.cjs", "module.exports = 3;\n");
 await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C2" });
 await f.invoke("omi_workflow_commit", { stepId: "C2", message: "fix: cubrir el valor 3", paths: ["value.cjs", "test.cjs"] });
 await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
 await f.action({ action: "verified" });
 assert.equal((await f.state()).phase, "pr");
 await assert.rejects(f.action({ action: "publish" }), "el modelo no publica otro PR ni hace push por su cuenta");
 assert.equal(f.remote.pushed.size, 0);

 await f.command("fix");
 const newHead = git(f.checkout.root, "rev-parse", "HEAD"); state = await f.state(); s = enabled(state);
 assert.ok(f.prompts.some(p => /Push de la corrección al PR #42/.test(p))); assert.equal(f.remote.pushed.get(branch), newHead);
 assert.equal(s.stage, "review"); assert.equal(state.phase, "review"); assert.equal(state.version === 2 && state.pullRequest?.head, newHead); assert.equal(state.version === 2 && state.pullRequest?.number, 42);

 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: newHead, body: "" });
 await f.command("review"); s = enabled(await f.state());
 assert.ok(s.approvals.some(a => a.subjectId === s.currentSubject && a.state === "approved"));
 await f.command("fix"); s = enabled(await f.state());
 assert.ok(f.prompts.some(p => /Ya corregidos/.test(p))); assert.equal(s.budget.roundsUsed, 1, "confirmar lo ya corregido no gasta otra ronda");

 await f.command("land"); state = await f.state(); s = enabled(state);
 assert.ok(f.prompts.some(p => /Marcar el PR #42 listo para review/.test(p))); assert.ok(f.prompts.some(p => /Mergear el PR #42/.test(p)));
 assert.ok(effects(gh).some(e => e.startsWith("pr ready 42")));
 const merge = effects(gh).find(e => e.includes("PUT")); assert.ok(merge); assert.match(merge, new RegExp(`sha=${newHead}`)); assert.match(merge, /merge_method=squash/); assert.doesNotMatch(merge, /admin|force/);
 assert.equal(state.phase, "ship"); assert.equal(s.stage, "ship"); assert.equal(s.merges?.length, 1); assert.notEqual(state.status, "complete");

 await f.command("ship"); state = await f.state(); s = enabled(state);
 assert.ok(f.prompts.some(p => /Ship release/.test(p)));
 assert.equal(state.phase, "delivered"); assert.equal(s.completion?.outcome, "verified"); assert.equal(s.stage, "delivered");
 const progress = f.progress.at(-1) as { progress?: { phaseLabel: string; lifecycle?: string[] } };
 assert.equal(progress.progress?.phaseLabel, "Entrega verificada");
 const lines = (progress.progress?.lifecycle ?? []).join("\n");
 assert.match(lines, /Resultado: entrega verificada/); assert.match(lines, /Hallazgos: 0 pendiente/); assert.match(lines, /rondas 1\/2/); assert.match(lines, /Checks del SHA actual: 1\/1 OK/); assert.doesNotMatch(lines, /Bloqueo/);
 assert.equal(effects(gh).filter(e => e.includes("PUT")).length, 1, "un solo merge");
});

test("restore, reload y el árbol de sesión no ejecutan efectos; las tools indirectas no eluden permisos", async t => {
 const { f, gh, head } = await setup(t);
 await f.command("adopt");
 gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: head, path: "value.cjs", line: 1 });
 await f.command("review");
 const before = await f.state(), reads = gh.reads.length, prompts = f.prompts.length, calls = f.calls.length;
 await f.attach(); await f.emit("session_start", { reason: "reload" }); await f.emit("session_tree", {});
 const after = await f.state();
 assert.equal(after.revision, before.revision); assert.deepEqual(effects(gh), []); assert.equal(gh.reads.length, reads, "restaurar no relee GitHub");
 assert.equal(f.prompts.length, prompts); assert.equal(f.calls.filter(c => c.command === "gh").length, f.calls.slice(0, calls).filter(c => c.command === "gh").length);
 for (const command of ["gh pr merge 42 --squash", "gh workflow run release.yml", "git push origin HEAD"]) {
  const blocked = await f.emit("tool_call", { toolName: "bash", toolCallId: "bash", input: { command } });
  assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block, command);
 }
 for (const action of ["land", "review", "ship", "adopt"]) await assert.rejects(f.action({ action }), action);
 const write = await f.emit("tool_call", { toolName: "write", toolCallId: "write", input: { path: "value.cjs", content: "module.exports = 9;\n" } });
 assert.ok(write && typeof write === "object" && "block" in write && write.block, "sin corrección autorizada no se escribe");
 assert.equal((await f.state()).revision, before.revision);
});

test("chichex/omi-code: merge siempre humano aunque Land diga auto", async t => {
 const { f, gh } = await setup(t, "chichex/omi-code", block => { block.land.mode = "auto"; block.review.mode = "auto"; block.ship = { status: "not-applicable", targets: [] }; });
 await f.command("adopt");
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: gh.pull.head(), body: "" });
 const prompts = f.prompts.length; await f.command("review");
 assert.equal(f.prompts.length, prompts, "review: auto observa sin preguntar"); assert.equal(enabled(await f.state()).ledger.length, 0);
 f.remote.confirmations = false; await f.command("land");
 assert.ok(f.prompts.some(p => /Mergear el PR #42/.test(p)), "omi-code pide el sí del merge");
 assert.ok(!effects(gh).some(e => e.includes("PUT")), "sin sí no hay merge"); assert.equal((await f.state()).phase, "land");
});

