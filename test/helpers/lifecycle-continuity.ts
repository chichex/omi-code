// Host real y Git temporal; sólo GitHub y KB son falsos. La publicación pasa por /omi-work pr.
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { processRunner } from "../../src/core/exec.ts";
import { inspectCheckout } from "../../src/harness/git.ts";
import { sourceHash, type Evidence, type Plan, type WorkflowV2 } from "../../src/harness/model.ts";
import { createWorkflow, transition } from "../../src/harness/state.ts";
import { updateWorkflow } from "../../src/harness/store.ts";
import { DEVELOPMENT_ANCHOR } from "../../src/tui/development-session.ts";
import { developmentFixture } from "./development.ts";
import { memoryKb } from "./mock-kb.ts";
import { AT, acceptLifecycleConfig, fakeGitHub, lifecycleConfig, type FakeGitHub } from "./lifecycle.ts";
import type { LifecycleConfig } from "../../src/harness/lifecycle-config.ts";

export const autoContinuity = { entry: "auto", review: "auto", fix: "auto", land: "auto", ship: "auto" } as const;
export async function continuityFixture(t: TestContext, options: {
 repo?: string; historical?: boolean; change?: (block: LifecycleConfig) => void;
 foundations?: { arranque: "auto" | "ask"; receta: "auto" | "ask"; push_pr: "auto" | "ask" };
} = {}) {
 const repo = options.repo ?? "acme/app", kb = memoryKb({ products: [repo.split("/")[1]!] });
 let gh: FakeGitHub | undefined;
 const f = await developmentFixture(t, { kb, repo, ...(options.foundations ? { foundations: options.foundations, confirmar: [] } : {}), github: (args, input) => gh?.handle(args, input) });
 await f.write("value.cjs", "module.exports = 2;\n");
 await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
 const git = (...args: string[]) => execFileSync("git", args, { cwd: f.checkout.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
 git("add", "."); git("commit", "-q", "-m", "fix: devolver 2");
 const snap = await inspectCheckout(f.checkout, processRunner, AbortSignal.timeout(5000));
 const plan: Plan = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Devolver 2", approach: "Corregir valor", scope: ["valor"], outOfScope: ["infra"], cases: [{ id: "D1", description: "Devuelve 2", command: "node test.cjs" }], lenses: [], executor: { mode: "inline", writers: 0 } };
 const evidence = (kind: Evidence["kind"]): Evidence => ({ id: kind, kind, stepId: ["red", "green"].includes(kind) ? "C1" : null, caseId: "D1", command: "node test.cjs", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "observado", head: snap.head, fingerprint: snap.fingerprint, startedAt: AT, finishedAt: AT });
 const send = (r: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(r, event, AT);
 let state = createWorkflow({ number: 42, title: f.remote.title, body: f.remote.body, url: `https://github.com/${repo}/issues/42`, hash: sourceHash(f.remote.title, f.remote.body) }, f.checkout, "work-42", AT);
 state = send(state, { type: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor" }], findings: ["Devuelve 1"], approach: "Corregir", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } });
 state = send(state, { type: "inferences", inferences: [] }); state = send(state, { type: "planned", plan });
 state = send(state, { type: "approved" }); state = send(state, { type: "step_started", id: "C1" });
 state = send(state, { type: "evidence", evidence: evidence("red") }); state = send(state, { type: "evidence", evidence: evidence("green") });
 state = send(state, { type: "step_completed", id: "C1", commit: snap.head, fingerprint: snap.fingerprint });
 state = send(state, { type: "evidence", evidence: evidence("verification") }); state = send(state, { type: "verified", fingerprint: snap.fingerprint });
 const number = options.historical ? 42 : 8;
 if (options.historical) {
  state = send(state, { type: "publishing", head: snap.head, bodyHash: "body" });
  state = send(state, { type: "published", head: snap.head, number, url: `https://github.com/${repo}/pull/${number}` });
 }
 await updateWorkflow(f.checkout, 42, undefined, () => ({ ...state, revision: 0 }));
 f.manager.appendCustomEntry(DEVELOPMENT_ANCHOR, { id: state.id, root: f.checkout.root, issue: 42, revision: 0 });
 gh = fakeGitHub(repo, f.checkout.root, { number, branch: f.checkout.branch, draft: true, merged: false, mergeSha: null, head: () => f.remote.pushed.get(f.checkout.branch) ?? snap.head });
 const config = lifecycleConfig(repo, block => { block.ship = { status: "not-applicable", targets: [] }; options.change?.(block); });
 await acceptLifecycleConfig(kb, f.home, f.checkout.root, config);
 await f.attach();
 return { f, gh, kb, head: snap.head, number };
}
