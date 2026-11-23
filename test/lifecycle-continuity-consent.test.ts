// Un solo sí de continuidad por etapa: aparte, o dentro del diálogo del primer efecto si ése ya pregunta.
// Host real, Git temporal, GitHub y KB falsos, sin red. Se cuentan los diálogos exactos de cada escenario.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import type { Workflow } from "../src/harness/model.ts";
import { autoContinuity, continuityFixture, reacceptLifecycleConfig } from "./helpers/lifecycle-continuity.ts";
import { lifecycleConfig } from "./helpers/lifecycle.ts";

const allAsk = { entry: "ask", review: "ask", fix: "ask", land: "ask", ship: "ask" } as const;
const FUSED = /^Continuidad en ask: al aceptar, /m;
function enabled(state: Workflow) {
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled", "el lifecycle quedó adoptado");
 return state.lifecycle;
}
const pauseOf = (state: Workflow) => state.version === 2 ? state.continuityPause : undefined;
const decisionOf = (state: Workflow, kind: string) => enabled(state).decisions.filter(d => d.kind === kind).map(d => d.source);
type Fixture = Awaited<ReturnType<typeof continuityFixture>>["f"];
/** Títulos y descripciones de los diálogos desde `from`, emparejados. */
const dialogs = (f: Fixture, from = 0) => f.prompts.slice(from).map((title, i) => ({ title, detail: f.confirmationDetails[from + i] ?? "" }));

test("omi-code con todo en ask: cada etapa pide un solo sí de continuidad y ningún sí de efecto se pierde (Land 3→2)", async t => {
 const { f, gh, head } = await continuityFixture(t, { repo: "chichex/omi-code", historical: true, change: block => { block.continuity = { ...allAsk }; } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 const seen = dialogs(f);
 assert.deepEqual(seen.map(d => d.title), [
  "Habilitar Review, Land y Ship en el PR #42",
  "Review del PR #42",
  "Marcar el PR #42 listo para review",
  "Mergear el PR #42",
  "Continuidad · Ship del PR #42",
 ]);
 const land = seen.filter(d => /PR #42 listo para review|Mergear el PR #42|Continuidad · Land/.test(d.title));
 assert.equal(land.length, 2, "Land: el sí de continuidad viaja en «listo para review»; el merge conserva el suyo");
 assert.match(seen[1]!.detail, /^Continuidad en ask: al aceptar, la cadena sigue con Review\./m);
 assert.match(seen[2]!.detail, /^Continuidad en ask: al aceptar, la cadena sigue con Land\./m);
 assert.doesNotMatch(seen[3]!.detail, FUSED, "el merge pide su propio sí, sin mezclar la continuidad");
 assert.doesNotMatch(seen[0]!.detail, FUSED, "adopt manual no es la entrada de la cadena");
 const state = await f.state();
 assert.equal(gh.pull.merged, true);
 assert.equal(gh.mutations.filter(args => args.includes("PUT")).length, 1);
 assert.deepEqual(decisionOf(state, "land"), ["person"], "el merge en omi-code sigue siendo de una persona");
 assert.deepEqual(decisionOf(state, "ready"), ["person"]);
 assert.equal(enabled(state).completion?.outcome, "not-applicable");
});

test("omi-code con Land auto y PR draft: la continuidad se pregunta antes de marcar listo, y el merge sigue humano", async t => {
 const { f, gh, head } = await continuityFixture(t, { repo: "chichex/omi-code", historical: true, change: block => {
  block.continuity = { ...autoContinuity, land: "ask" }; block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 const confirm = f.context.ui.confirm.bind(f.context.ui), mutationsAtDialog: number[] = [];
 f.context.ui.confirm = async (title, detail, options) => { mutationsAtDialog.push(gh.mutations.length); return confirm(title, detail, options); };
 await f.command("adopt");
 const seen = dialogs(f, 1);
 assert.deepEqual(seen.map(d => d.title), ["Continuidad · Land del PR #42", "Mergear el PR #42"]);
 assert.deepEqual(mutationsAtDialog.slice(1), [0, 1], "ready corre sólo después del sí de continuidad; el merge, después del suyo");
 assert.match(seen[0]!.detail, /corre sin otro sí/);
 assert.equal(gh.pull.merged, true);
 assert.deepEqual(decisionOf(await f.state(), "ready"), ["policy"], "el sí de continuidad no se registra como permiso del efecto");
});

test("omi-code con Land auto y un PR que una persona ya sacó de draft: un solo diálogo, el del merge, con la continuidad adentro", async t => {
 const { f, gh, head } = await continuityFixture(t, { repo: "chichex/omi-code", historical: true, change: block => {
  block.continuity = { ...autoContinuity, land: "ask" }; block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 gh.pull.draft = false; // marcado listo en la UI de GitHub, sin operación ready de OMI
 await f.command("adopt");
 const seen = dialogs(f, 1);
 assert.deepEqual(seen.map(d => d.title), ["Mergear el PR #42"], "el primer efecto es el merge humano: lleva la continuidad");
 assert.match(seen[0]!.detail, /^Continuidad en ask: al aceptar, la cadena sigue con Land\./m);
 assert.doesNotMatch(seen.map(d => d.detail).join("\n"), /corre sin otro sí/, "no promete un primer paso sin sí");
 assert.equal(gh.pull.merged, true);
 assert.deepEqual(gh.mutations.filter(args => args.includes("ready")), [], "no hubo ready que correr");
 const state = await f.state();
 assert.deepEqual(decisionOf(state, "land"), ["person"], "el merge en omi-code sigue siendo de una persona");
 assert.deepEqual(decisionOf(state, "ready"), []);
});

test("efecto auto y continuidad ask: un diálogo, de continuidad, y el efecto corre por su propio permiso", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity, review: "ask", land: "manual" }; block.review.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 const seen = dialogs(f, 1);
 assert.deepEqual(seen.map(d => d.title), ["Continuidad · Review del PR #42"]);
 assert.match(seen[0]!.detail, /corre sin otro sí/);
 assert.match(seen[0]!.detail, /no concede permisos/);
 const state = await f.state();
 assert.deepEqual(decisionOf(state, "review"), ["policy"]);
 assert.deepEqual(pauseOf(state) && { reason: pauseOf(state)?.reason, stage: pauseOf(state)?.stage }, { reason: "manual", stage: "land" });
});

test("continuidad auto y efecto ask: un diálogo, el del efecto, sin línea de continuidad", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity, land: "manual" };
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 const seen = dialogs(f, 1);
 assert.deepEqual(seen.map(d => d.title), ["Review del PR #42"]);
 assert.doesNotMatch(seen[0]!.detail, /Continuidad/);
 assert.deepEqual(decisionOf(await f.state(), "review"), ["person"]);
});

test("un no al diálogo fusionado pausa como rechazo y no ejecuta el efecto", async t => {
 const { f, gh } = await continuityFixture(t, { historical: true, change: block => { block.continuity = { ...autoContinuity, review: "ask" }; } });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 f.context.ui.confirm = async (title, detail, options) => {
  const previous = f.remote.confirmations;
  if (title === "Review del PR #42") f.remote.confirmations = false;
  try { return await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
 };
 await f.command("adopt");
 const seen = dialogs(f, 1);
 assert.deepEqual(seen.map(d => d.title), ["Review del PR #42"], "un solo diálogo: el de Review, con la continuidad adentro");
 assert.match(seen[0]!.detail, FUSED);
 const state = await f.state(), pause = pauseOf(state);
 assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage }, { reason: "declined", stage: "review" });
 assert.equal(enabled(state).operations.length, 0, "no se reservó la Review");
 assert.deepEqual(gh.reads.filter(endpoint => /\/reviews|\/comments|check-runs/.test(endpoint)), [], "ni se leyó la Review");
 assert.deepEqual(gh.mutations, []);
 const prompts = f.prompts.length;
 await f.emit("agent_before_settle", {});
 assert.equal(f.prompts.length, prompts, "rechazar no repregunta en el siguiente settle");
});

for (const pushMode of ["ask", "auto"] as const) {
 test(`fix ask: la ronda y el push piden un solo sí cada uno, push_pr ${pushMode}`, async t => {
  const { f, gh, head } = await continuityFixture(t, { historical: true,
   foundations: { arranque: "auto", receta: "auto", push_pr: pushMode },
   change: block => { block.continuity = { ...autoContinuity, fix: "ask", land: "manual" }; block.review.mode = "auto"; },
  });
  gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: head, path: "value.cjs", line: 1 });
  await f.command("adopt");
  const round = dialogs(f, 1);
  assert.deepEqual(round.map(d => d.title), ["Corregir 1 hallazgo(s) en el PR #42"], "corrections.mode ask: la ronda absorbe la continuidad");
  assert.match(round[0]!.detail, /^Continuidad en ask: al aceptar, la cadena sigue con la corrección\./m);
  let state = await f.state();
  assert.equal(state.phase, "implement");
  const step = state.steps.at(-1)!;
  await f.action({ action: "step", id: step.id });
  await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n');
  await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: step.id });
  await f.write("value.cjs", "module.exports = 3;\n");
  await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: step.id });
  await f.invoke("omi_workflow_commit", { stepId: step.id, message: "fix: cubrir el valor 3", paths: ["value.cjs", "test.cjs"] });
  await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
  const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout.root, encoding: "utf8" }).trim();
  gh.inline.length = 0;
  gh.reviews.push({ id: 602, login: "ada", state: "APPROVED", commit_id: newHead, body: "" });
  const before = f.prompts.length;
  await f.action({ action: "verified" });
  const push = dialogs(f, before);
  if (pushMode === "ask") {
   assert.deepEqual(push.map(d => d.title), ["Push de la corrección al PR #42"], "push_pr ask: el push absorbe la continuidad");
   assert.match(push[0]!.detail, /^Continuidad en ask: al aceptar, la cadena sigue con el push de la corrección\./m);
  } else {
   assert.deepEqual(push.map(d => d.title), ["Continuidad · Publicar la corrección (push) en el PR #42"], "push_pr auto: se pregunta la continuidad y dice que es un push");
   assert.match(push[0]!.detail, /corre sin otro sí/);
  }
  state = await f.state();
  assert.equal(f.remote.pushed.get(f.checkout.branch), newHead);
  assert.deepEqual(decisionOf(state, "push"), [pushMode === "ask" ? "person" : "policy"], "continuidad no concede el push");
  const s = enabled(state);
  assert.ok(s.operations.some(o => o.kind === "review" && o.subjectId === s.currentSubject && o.status === "confirmed"), "la cadena volvió a Review del HEAD nuevo");
  assert.equal(gh.pull.merged, false);
 });
}

test("entrada ask: un único sí de adopción con PR, HEAD y la configuración que se fija, antes de leer GitHub", async t => {
 const { f, gh, head, number } = await continuityFixture(t, { change: block => { block.continuity = { ...autoContinuity, entry: "ask", review: "manual" }; } });
 const confirm = f.context.ui.confirm.bind(f.context.ui), readsAtDialog: number[] = [];
 f.context.ui.confirm = async (title, detail, options) => { readsAtDialog.push(gh.reads.length); return confirm(title, detail, options); };
 await f.command("pr");
 const seen = dialogs(f);
 assert.deepEqual(seen.map(d => d.title), [`Habilitar Review, Land y Ship en el PR #${number}`]);
 assert.deepEqual(readsAtDialog, [0], "el sí va antes de leer el PR en GitHub");
 const detail = seen[0]!.detail;
 assert.ok(detail.includes(`PR #${number} · ${f.checkout.branch} → main · HEAD ${head.slice(0, 12)}`), detail);
 // Cada perilla que se fija, con su valor vigente (lifecycleDiff marca «antes → ahora» frente a los defaults).
 for (const [field, value] of [["continuity.entry", "ask"], ["continuity.review", "manual"], ["review.provider.kind", "github"], ["review.provider.reviewers[0]", "ada"], ["land.mode", "ask"], ["land.method", "squash"], ["budget.maxAttempts", "12"], ["budget.activeSeconds", "7200"]] as const) {
  assert.ok(detail.split("\n").some(line => line.startsWith(`${field}: `) && (line.endsWith(`: ${value}`) || line.endsWith(`→ ${value}`))), `muestra ${field}: ${value}`);
 }
 assert.match(detail, /^Continuidad en ask: al aceptar, se adopta el PR y la cadena sigue con Review según continuity\.review\./m);
 assert.doesNotMatch(detail, /Habilitar no ejecuta nada ahora/, "con continuidad, adoptar puede seguir con la próxima etapa");
 const state = await f.state(), pause = pauseOf(state);
 assert.equal(state.phase, "review");
 assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage }, { reason: "manual", stage: "review" });
 assert.deepEqual(gh.mutations, []);
});

test("entrada ask: si la configuración cambia mientras espera el sí, no se adopta con ella ni se lee GitHub", async t => {
 const { f, gh, kb } = await continuityFixture(t, { change: block => { block.continuity = { ...autoContinuity, entry: "ask", review: "manual" }; } });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 f.context.ui.confirm = async (title, detail, options) => {
  const answer = await confirm(title, detail, options);
  await reacceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig("acme/app", block => {
   block.continuity = { ...autoContinuity, entry: "ask", review: "manual" };
   block.review.provider = { kind: "github", reviewers: ["grace"] }; block.ship = { status: "not-applicable", targets: [] };
  }));
  return answer;
 };
 await f.command("pr");
 assert.equal(f.prompts.length, 1);
 const state = await f.state(), pause = pauseOf(state);
 assert.equal(state.phase, "done");
 assert.equal(state.version === 2 && state.lifecycle.status, "disabled", "el sí era para la configuración mostrada");
 assert.equal(pause?.reason, "error");
 assert.match(pause?.detail ?? "", /configuración de entrada cambió/);
 assert.deepEqual(gh.reads, []);
 assert.deepEqual(gh.mutations, []);
});

test("si el pin fresco de la etapa deja el efecto en auto, la continuidad ask se pregunta igual, una vez, antes del efecto", async t => {
 const { f, gh, head, kb } = await continuityFixture(t, { historical: true, change: block => { block.continuity = { ...autoContinuity, review: "ask", land: "manual" }; } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 const currentPerillas = kb.currentPerillas.bind(kb);
 let reads = 0, replaced = false;
 kb.currentPerillas = async (...args) => {
  const state = await f.state();
  if (!replaced && state.version === 2 && state.lifecycle.status === "enabled" && ++reads === 2) {
   replaced = true;
   await reacceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig("acme/app", block => {
    block.continuity = { ...autoContinuity, review: "ask", land: "manual" }; block.review.mode = "auto"; block.ship = { status: "not-applicable", targets: [] };
   }));
  }
  return currentPerillas(...args);
 };
 await f.command("adopt");
 assert.equal(replaced, true, "el pin cambió dentro de la etapa, después de predecir un efecto humano");
 assert.deepEqual(dialogs(f, 1).map(d => d.title), ["Continuidad · Review del PR #42"]);
 const state = await f.state();
 assert.deepEqual(decisionOf(state, "review"), ["policy"]);
 assert.equal(enabled(state).operations.filter(o => o.kind === "review" && o.status === "confirmed").length, 1);
});

for (const answer of [true, false] as const) {
 test(`Land ask con merge externo: la cadena no lo registra ni pasa de Land sin el sí de continuidad (${answer ? "sí" : "no"})`, async t => {
  const { f, gh, head, kb } = await continuityFixture(t, { historical: true, change: block => {
   block.continuity = { ...autoContinuity, land: "ask" }; block.review.mode = "auto";
  } });
  gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
  const currentPerillas = kb.currentPerillas.bind(kb);
  kb.currentPerillas = async (...args) => {
   const state = await f.state();
   // Alguien mergea en GitHub después de la Review: Land sólo va a observarlo.
   if (state.version === 2 && state.lifecycle.status === "enabled" && state.lifecycle.operations.some(o => o.kind === "review" && o.status === "confirmed")) {
    gh.pull.merged = true; gh.pull.mergeSha = "f".repeat(40);
   }
   return currentPerillas(...args);
  };
  const confirm = f.context.ui.confirm.bind(f.context.ui);
  f.context.ui.confirm = async (title, detail, options) => {
   const previous = f.remote.confirmations;
   if (title.startsWith("Continuidad · ")) f.remote.confirmations = answer;
   try { return await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
  };
  await f.command("adopt");
  assert.deepEqual(dialogs(f, 1).map(d => d.title), ["Continuidad · Land del PR #42"], "land.mode ask predijo un sí de efecto que no llegó: se pregunta la continuidad");
  const state = await f.state(), s = enabled(state);
  assert.deepEqual(gh.mutations, [], "un merge externo no se repite");
  if (answer) assert.equal(s.completion?.outcome, "not-applicable", "con el sí, Land registra el merge y la cadena sigue");
  else {
   assert.equal(s.merges?.length ?? 0, 0, "sin el sí, no se registra el merge");
   const pause = pauseOf(state);
   assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage }, { reason: "declined", stage: "land" });
  }
 });
}

// El sí de /omi-work adopt dice qué sigue después de habilitar, según la continuidad que se fija.
for (const [label, continuity, expected] of [
 ["review auto", { ...autoContinuity, review: "auto", fix: "manual", land: "manual" }, /Al habilitar, la continuidad sigue sola con Review \(continuity\.review: auto\)\./],
 ["review ask", { ...autoContinuity, review: "ask", fix: "manual", land: "manual" }, /Al habilitar, la continuidad pregunta antes de seguir con Review \(continuity\.review: ask\)\./],
 ["review manual", { ...autoContinuity, review: "manual" }, /Habilitar no ejecuta nada ahora\./],
 ["sin continuidad", undefined, /Habilitar no ejecuta nada ahora\./],
] as const) {
 test(`/omi-work adopt con ${label}: el diálogo dice qué sigue después de habilitar`, async t => {
  const { f } = await continuityFixture(t, { historical: true, change: block => { if (continuity) block.continuity = { ...continuity }; } });
  await f.command("adopt");
  const adopt = dialogs(f).find(d => d.title === "Habilitar Review, Land y Ship en el PR #42");
  assert.ok(adopt, "pidió el sí de la adopción");
  assert.match(adopt.detail, expected);
  if (continuity && continuity.review !== "manual") assert.doesNotMatch(adopt.detail, /Habilitar no ejecuta nada ahora/, "con continuidad, adoptar sigue con Review");
 });
}
