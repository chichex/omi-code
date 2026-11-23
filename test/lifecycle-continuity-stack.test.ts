// Stacks y continuidad del lifecycle: con la entrada encadenada, el trabajo va en un solo PR; un stack ya publicado
// pausa sin preguntar. Host real, Git temporal, GitHub y KB falsos, sin red.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Spec, Workflow } from "../src/harness/model.ts";
import type { LifecycleConfig } from "../src/harness/lifecycle-schema.ts";
import { renderLifecycleBlock } from "../src/harness/lifecycle-config.ts";
import { evaluateLifecycle, readLifecycle } from "../src/harness/lifecycle-kb.ts";
import { lifecycleTrustDir, readLifecycleTrust } from "../src/harness/lifecycle-trust.ts";
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
async function agentPrompt(f: Awaited<ReturnType<typeof atSpec>>["f"]): Promise<string> {
 const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
 await f.emit("before_agent_start", event);
 return event.systemPromptOptions.sections.omi_development ?? "";
}
const toolText = (result: unknown): string => result && typeof result === "object" && "content" in result && Array.isArray(result.content)
 ? result.content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n") : "";

for (const entry of ["auto", "ask"] as const) {
 test(`entrada ${entry}: la spec con stack se rechaza sin efectos y sin stack sale UN draft que la cadena adopta`, async t => {
  const { f, gh } = await atSpec(t, { ...autoContinuity, entry, review: "manual" });
  const before = await f.state();
  await assert.rejects(f.action({ action: "specified", spec: spec(true) }), (error: Error) => {
   assert.match(error.message, /un solo PR/); assert.match(error.message, /specified otra vez sin stack/); return true;
  });
  const after = await f.state();
  assert.equal(after.phase, "spec", "el estado no avanza");
  assert.equal(after.revision, before.revision);
  assert.equal(after.spec, null);
  assert.equal(f.remote.prs.length, 0); assert.equal(f.remote.pushed.size, 0); assert.deepEqual(gh.mutations, []);
  await f.action({ action: "specified", spec: spec(false) });
  assert.equal((await f.state()).phase, "approve");
  await implementAndPublish(f);
  const state = await f.state();
  assert.deepEqual(f.remote.prs.map(p => [p.number, p.head, p.base]), [[8, f.checkout.branch, "main"]], "un solo PR draft");
  assert.equal(state.phase, "review", "la cadena adoptó el PR");
  assert.ok(state.version === 2 && state.lifecycle.status === "enabled" && state.pullRequest?.number === 8);
  assert.equal(f.prompts.filter(p => /^Habilitar Review, Land y Ship en el PR #8$/.test(p)).length, entry === "ask" ? 1 : 0);
  assert.deepEqual(gh.mutations, []);
 });
}

test("con la entrada encadenada, la guía de la receta y de la spec piden un solo PR; sin continuidad, sugieren el stack", async t => {
 const chained = await atSpec(t, { ...autoContinuity, review: "manual" });
 const prompt = await agentPrompt(chained.f);
 assert.match(prompt, /Este repo encadena el lifecycle: el trabajo va en un solo PR/);
 assert.doesNotMatch(prompt, /partilo en un stack/);
 const legacy = await atSpec(t);
 const free = await agentPrompt(legacy.f);
 assert.match(free, /partilo en un stack/); assert.doesNotMatch(free, /encadena el lifecycle/);
});

test("el resultado de planned ya trae la guía de un solo PR para la spec", async t => {
 const kb = memoryKb({ products: [REPO.split("/")[1] ?? ""] });
 const f = await developmentFixture(t, { kb, repo: REPO });
 await acceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig(REPO, block => { block.continuity = { ...autoContinuity, entry: "ask" }; }));
 await f.start(); await f.explore();
 const text = toolText(await f.action({ action: "planned", plan: f.plan("large") }));
 assert.match(text, /Este repo encadena el lifecycle: el trabajo va en un solo PR/);
 assert.doesNotMatch(text, /partilo en un stack/);
});

for (const reading of ["manual", "legacy", "pending", "unavailable"] as const) {
 test(`sin entrada encadenada (${reading}), la spec con stack sigue como siempre`, async t => {
  const { f, kb } = await atSpec(t, reading === "legacy" ? undefined : { ...autoContinuity, entry: reading === "manual" ? "manual" : "auto" });
  const product = REPO.split("/")[1] ?? "";
  // Un lifecycle aceptado sin continuidad.
  if (reading === "legacy") await acceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig(REPO, block => { block.ship = { status: "not-applicable", targets: [] }; }));
  // Cambios sin aceptar o KB caída: la lectura no habilita efectos y vale lo de siempre.
  if (reading === "pending") kb.perillas(product, `# Perillas de ${product}\n\n${renderLifecycleBlock(lifecycleConfig(REPO, block => { block.continuity = { ...autoContinuity }; block.review.mode = "auto"; }))}\n`);
  if (reading === "unavailable") kb.hook = tool => tool === "buscar" || tool === "leer" ? "error" : undefined;
  const key = { kbUrl: kb.url, product, repo: REPO };
  const evaluation = evaluateLifecycle(await readLifecycle(kb, key, f.checkout.root, AbortSignal.timeout(5000)), await readLifecycleTrust(lifecycleTrustDir(f.home), key));
  assert.equal(evaluation.status, reading === "pending" || reading === "unavailable" ? reading : "accepted", "la lectura es la que nombra el caso");
  await f.action({ action: "specified", spec: spec(true) });
  const state = await f.state();
  assert.equal(state.phase, "approve");
  assert.equal(state.spec?.stack?.length, 2);
 });
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
