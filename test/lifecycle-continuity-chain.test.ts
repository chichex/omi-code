// «Ya corregidos» dentro de la cadena y desde /omi-work fix: host real, Git temporal, GitHub y KB falsos, sin red.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { Workflow } from "../src/harness/model.ts";
import type { LifecycleConfig } from "../src/harness/lifecycle-schema.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";

type Fixture = Awaited<ReturnType<typeof continuityFixture>>;
const enabled = (state: Workflow) => {
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled", "lifecycle habilitado");
 return state.lifecycle;
};
const pauseOf = (state: Workflow) => state.version === 2 ? state.continuityPause : undefined;
const reviews = (state: Workflow) => enabled(state).operations.filter(o => o.kind === "review").length;
/** Un hallazgo en el HEAD publicado; la cadena lo revisa y abre la ronda 1 con su sí («Corregir»). */
async function firstRound(change: (block: LifecycleConfig) => void, t: Parameters<typeof continuityFixture>[0]): Promise<Fixture> {
 const fixture = await continuityFixture(t, { historical: true, foundations: { arranque: "auto", receta: "auto", push_pr: "auto" }, change: block => {
  block.review.mode = "auto"; block.corrections.mode = "ask"; change(block);
 } });
 fixture.gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: fixture.head, path: "value.cjs", line: 1 });
 return fixture;
}
/** La corrección de la ronda con TDD, commit y su D. Devuelve el HEAD nuevo, sin verified. */
async function correct({ f }: Fixture): Promise<string> {
 const step = (await f.state()).steps.at(-1);
 assert.ok(step, "la ronda abrió un paso C");
 await f.action({ action: "step", id: step.id });
 await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n');
 await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: step.id });
 await f.write("value.cjs", "module.exports = 3;\n");
 await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: step.id });
 await f.invoke("omi_workflow_commit", { stepId: step.id, message: "fix: cubrir el valor 3", paths: ["value.cjs", "test.cjs"] });
 await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
 return execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout.root, encoding: "utf8" }).trim();
}
const asked = (f: Fixture["f"], from: number, pattern: RegExp) => f.prompts.slice(from).filter(p => pattern.test(p)).length;

for (const maxRounds of [2, 1] as const) {
 test(`cadena: «Ya corregidos» parcial cuenta como progreso; ${maxRounds === 2 ? "sigue con la ronda de los que quedan" : "sin rondas, pausa por rondas"}`, async t => {
  const fixture = await firstRound(block => { block.continuity = { ...autoContinuity, land: "manual" }; block.corrections.maxRounds = maxRounds; }, t);
  const { f, gh } = fixture;
  await f.command("adopt");
  assert.equal((await f.state()).phase, "implement", "la cadena abrió la ronda 1");
  const newHead = await correct(fixture);
  // La Review del HEAD nuevo vuelve a ver el ya corregido y suma uno nuevo.
  gh.inline.push({ id: 502, body: "Falta el caso del valor 4", commit_id: newHead, path: "test.cjs", line: 1 });
  const before = f.prompts.length;
  await f.action({ action: "verified" });
  const state = await f.state(), s = enabled(state);
  assert.equal(f.remote.pushed.get(f.checkout.branch), newHead, "verified publicó la corrección");
  assert.equal(asked(f, before, /^Ya corregidos: 1 hallazgo/), 1, "confirma el ya corregido una vez");
  if (maxRounds === 2) {
   assert.equal(asked(f, before, /^Corregir 1 hallazgo\(s\) en el PR #42$/), 1, "la ronda nueva es sólo para el que queda, con su propio sí");
   assert.equal(state.phase, "implement", "la cadena siguió con la ronda de los restantes");
   assert.equal(s.budget.roundsUsed, 2);
   assert.equal(pauseOf(state), undefined, "no quedó en pausa por falta de progreso");
  } else {
   assert.equal(asked(f, before, /^Corregir /), 0, "sin rondas no se ofrece otra");
   assert.equal(s.budget.roundsUsed, 1);
   assert.equal(pauseOf(state)?.reason, "rounds-exhausted", "el motivo es el presupuesto de rondas, no la falta de progreso");
  }
  assert.deepEqual(gh.mutations, [], "ni ready ni merge");
 });
}

test("cadena con corrections auto y rondas agotadas: no pide «Corregir» ni lo intenta, pausa por rondas", async t => {
 const fixture = await firstRound(block => { block.continuity = { ...autoContinuity, land: "manual", fix: "ask" }; block.corrections = { mode: "auto", maxRounds: 1 }; }, t);
 const { f, gh } = fixture;
 // El evaluador aislado de alcance acredita la ronda 1 automática.
 Reflect.set(f.context, "model", { provider: "mock", id: "mock", contextWindow: 200000 });
 Reflect.set(f.context.modelRegistry, "streamSimple", (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => ({ result: async () => {
  const prompt = JSON.parse(context.messages[0]!.content[0]!.text) as { findings: { id: string }[] };
  return { role: "assistant", provider: "mock", model: "mock", stopReason: "stop", usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0 },
   content: [{ type: "text", text: JSON.stringify({ verdict: "pass", findings: prompt.findings.map(finding => ({ id: finding.id, withinScope: true, risk: "low", humanRequired: false, reason: "Cubrir el valor dentro de la receta aprobada" })) }) }] };
 } }));
 await f.command("adopt");
 assert.equal((await f.state()).phase, "implement", "la cadena abrió la ronda 1");
 const newHead = await correct(fixture);
 // La Review del HEAD nuevo vuelve a ver el ya corregido y suma uno nuevo.
 gh.inline.push({ id: 502, body: "Falta el caso del valor 4", commit_id: newHead, path: "test.cjs", line: 1 });
 await f.action({ action: "verified" });
 const state = await f.state(), s = enabled(state);
 assert.equal(f.remote.pushed.get(f.checkout.branch), newHead, "verified publicó la corrección");
 assert.equal(reviews(state), 2, "la cadena revisó el HEAD nuevo");
 assert.equal(s.budget.roundsUsed, 1);
 assert.equal(f.prompts.filter(p => /^Continuidad · Corregir /.test(p)).length, 1, "sólo la ronda 1 pidió continuar con la corrección");
 assert.equal(asked(f, 0, /^Ya corregidos/), 0, "en auto no abre el diálogo de disposición");
 assert.equal(pauseOf(state)?.reason, "rounds-exhausted", "el motivo es el presupuesto de rondas, no un error");
 assert.deepEqual(gh.mutations, [], "ni ready ni merge");
});

for (const restored of [false, true] as const) {
 test(`/omi-work fix: «Ya corregidos» total ${restored ? "después de reabrir la sesión pausa con Land como próximo paso" : "con la Review observada en la sesión sigue con Land"}`, async t => {
  const fixture = await firstRound(block => { block.continuity = { ...autoContinuity, fix: "manual" }; block.land.mode = "auto"; }, t);
  const { f, gh } = fixture;
  await f.command("adopt");
  assert.equal(pauseOf(await f.state())?.stage, "fix", "fix manual espera el comando");
  await f.command("fix");
  const newHead = await correct(fixture);
  gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: newHead, body: "" });
  await f.action({ action: "verified" });
  await f.command("fix"); // push al mismo PR; la cadena revisa el HEAD nuevo y vuelve a ver el ya corregido
  let state = await f.state();
  assert.equal(f.remote.pushed.get(f.checkout.branch), newHead);
  assert.equal(reviews(state), 2, "la cadena revisó el HEAD nuevo");
  assert.equal(pauseOf(state)?.stage, "fix");
  if (restored) await f.emit("session_tree", {});
  const before = f.prompts.length, attempts = enabled(state).budget.attemptsUsed;
  await f.command("fix");
  state = await f.state();
  assert.equal(asked(f, before, /^Ya corregidos: 1 hallazgo/), 1);
  assert.equal(reviews(state), 2, "no repite la Review ni gasta otro intento de Review");
  if (!restored) {
   assert.equal(gh.pull.merged, true, "con la Review observada en esta sesión, la cadena siguió con Land");
   assert.equal(enabled(state).completion?.outcome, "not-applicable");
   return;
  }
  const pause = pauseOf(state);
  assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage }, { reason: "review-facts-required", stage: "land" });
  assert.match(f.messages.at(-1) ?? "", /no se observó en esta sesión: corré \/omi-work land; relee GitHub y no repite la Review/);
  assert.equal(enabled(state).budget.attemptsUsed, attempts, "pausar no gasta intentos");
  assert.deepEqual(gh.mutations, []);
  await f.command("land");
  assert.equal(gh.pull.merged, true, "el próximo paso indicado alcanza");
  assert.equal(reviews(await f.state()), 2);
 });
}

// Un opt-in a continuidad con fix manual no quita el sí que el comando manual del push pedía antes.
for (const continuity of [{ ...autoContinuity, fix: "manual", land: "manual" }, { entry: "manual", review: "manual", fix: "manual", land: "manual", ship: "manual" }] as const) {
 test(`/omi-work fix con continuity.fix manual${continuity.review === "manual" ? " (todo manual)" : ""}: el push pide su sí aunque push_pr sea auto`, async t => {
  const fixture = await firstRound(block => { block.continuity = { ...continuity }; }, t);
  const { f, gh } = fixture;
  await f.command("adopt");
  if (continuity.review === "manual") await f.command("review");
  await f.command("fix");
  assert.equal((await f.state()).phase, "implement", "la persona autorizó la ronda");
  const newHead = await correct(fixture);
  await f.action({ action: "verified" });
  assert.notEqual(f.remote.pushed.get(f.checkout.branch), newHead, "con fix manual, verified no hace el push");
  const before = f.prompts.length;
  await f.command("fix");
  assert.equal(asked(f, before, /^Push de la corrección al PR #42$/), 1, "el comando manual pide el sí del push, como sin continuidad");
  const state = await f.state();
  assert.deepEqual(enabled(state).decisions.filter(d => d.kind === "push").map(d => d.source), ["person"], "el push no quedó como decisión de la política");
  assert.equal(f.remote.pushed.get(f.checkout.branch), newHead);
  assert.deepEqual(gh.mutations, [], "ni ready ni merge");
 });
}
