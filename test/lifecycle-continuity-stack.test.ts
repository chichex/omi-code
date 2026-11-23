// Stacks y continuidad del lifecycle: un stack ya publicado pausa sin preguntar. Host real, Git temporal, GitHub y KB falsos, sin red.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Spec, Workflow } from "../src/harness/model.ts";
import type { LifecycleConfig } from "../src/harness/lifecycle-schema.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { acceptLifecycleConfig, fakeGitHub, lifecycleConfig, type FakeGitHub } from "./helpers/lifecycle.ts";
import { autoContinuity } from "./helpers/lifecycle-continuity.ts";

const REPO = "acme/app";
const steps: Spec["steps"] = [{ id: "C1", title: "Primer valor", cases: ["D1"] }, { id: "C2", title: "Segundo valor", cases: ["D2"] }];
const spec = (stack: boolean): Spec => ({ why: "Se revisa mejor por partes", steps, playbook: ["Ejecutar ambos casos"],
 ...(stack ? { stack: [{ title: "Primer valor", steps: ["C1"] }, { title: "Segundo valor", steps: ["C2"] }] } : {}) });
const pauseOf = (state: Workflow) => state.version === 2 ? state.continuityPause : undefined;

/** Un trabajo en la etapa spec. `continuity`: la configuración del lifecycle aceptada antes de la spec (undefined: ninguna). */
async function atSpec(t: TestContext, continuity?: LifecycleConfig["continuity"]) {
 const kb = memoryKb({ products: [REPO.split("/")[1] ?? ""] });
 let gh: FakeGitHub | undefined;
 const f = await developmentFixture(t, { kb, repo: REPO, github: (args, input) => gh?.handle(args, input) });
 const accept = (value: LifecycleConfig["continuity"]) => acceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig(REPO, block => {
  block.ship = { status: "not-applicable", targets: [] };
  if (value) block.continuity = value;
 }));
 if (continuity) await accept(continuity);
 await f.start(); await f.explore();
 await f.action({ action: "planned", plan: f.plan("large") });
 assert.equal((await f.state()).phase, "spec");
 const github = fakeGitHub(REPO, f.checkout.root, { number: 8, branch: f.checkout.branch, draft: true, merged: false, mergeSha: null, head: () => f.remote.pushed.get(f.checkout.branch) ?? "0".repeat(40) });
 gh = github;
 return { f, gh: github, kb, accept };
}
/** Aprueba, implementa C1 y C2 con TDD, verifica y publica. */
async function implementAndPublish(f: Awaited<ReturnType<typeof atSpec>>["f"]): Promise<void> {
 await f.action({ action: "approve" });
 for (const [index, step] of (await f.state()).steps.entries()) {
  const testPath = index ? "other-test.cjs" : "test.cjs", valuePath = index ? "other.cjs" : "value.cjs";
  await f.action({ action: "step", id: step.id });
  await f.write(testPath, `require("node:assert/strict").equal(require("./${valuePath}"), 2);\n`);
  await f.invoke("omi_workflow_check", { kind: "red", command: `node ${testPath}`, stepId: step.id });
  await f.write(valuePath, "module.exports = 2;\n");
  await f.invoke("omi_workflow_check", { kind: "green", command: `node ${testPath}`, stepId: step.id });
  await f.invoke("omi_workflow_commit", { stepId: step.id, paths: [testPath, valuePath], message: `fix: ${step.title}` });
 }
 const recipe = (await f.state()).recipe;
 assert.ok(recipe);
 for (const c of recipe.cases) await f.invoke("omi_workflow_check", { kind: "verification", command: c.command, caseId: c.id });
 await f.invoke("omi_workflow_lens", { lens: "quality" });
 await f.action({ action: "verified" });
 await f.action({ action: "publish" });
}

for (const entry of ["auto", "ask"] as const) {
 test(`stack ya publicado con entrada ${entry}: pausa stack-unsupported sin preguntar ni leer GitHub; adopt dice lo mismo`, async t => {
  const { f, gh, accept } = await atSpec(t);
  await f.action({ action: "specified", spec: spec(true) });
  // La configuración se aceptó después de la spec: el stack sale igual y la cadena no lo adopta.
  await accept({ ...autoContinuity, entry });
  const prompts = f.prompts.length;
  await implementAndPublish(f);
  const state = await f.state();
  assert.equal(f.remote.prs.length, 2, "se publicó el stack");
  assert.equal(state.phase, "done");
  assert.ok(state.version === 2 && state.lifecycle.status === "disabled");
  const pause = pauseOf(state);
  assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage, stackPulls: pause.stackPulls }, { reason: "stack-unsupported", stage: "entry", stackPulls: 2 });
  assert.equal(f.prompts.slice(prompts).filter(p => /Habilitar|Continuidad/.test(p)).length, 0, "no pregunta la entrada");
  assert.deepEqual(gh.reads, [], "no lee el PR en GitHub"); assert.deepEqual(gh.mutations, []);
  const text = "Este trabajo se publicó como stack de 2 PRs y el lifecycle no adopta stacks";
  assert.ok(f.messages.some(m => m.includes(`Continuidad en pausa · ${text}: mergealos en orden con su sí, o publicá un solo PR`)));
  await f.command("adopt");
  assert.equal(f.messages.at(-1), `${text}. Mergealos en orden con su sí, o publicá un solo PR.`);
  assert.deepEqual(gh.reads, []);
 });
}
