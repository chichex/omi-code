// C2: fronteras públicas del host, Git temporal real, GitHub/KB falsos y ninguna red.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import type { Workflow } from "../src/harness/model.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";

function enabled(state: Workflow) {
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled", "el host adoptó el PR recién publicado");
 return state.lifecycle;
}
const reviews = (state: Workflow) => enabled(state).operations.filter(o => o.kind === "review" && o.status === "confirmed");

for (const pushMode of ["ask", "auto"] as const) {
 test(`corrección verificada continúa al mismo PR, push Foundations ${pushMode} y Review del SHA nuevo`, async t => {
  const { f, gh, head } = await continuityFixture(t, { historical: true,
   foundations: { arranque: "auto", receta: "auto", push_pr: pushMode },
   change: block => { block.continuity = { ...autoContinuity, land: "manual" }; block.review.mode = "auto"; block.corrections.mode = "ask"; },
  });
  gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: head, path: "value.cjs", line: 1 });
  await f.command("adopt");
  let state = await f.state();
  assert.equal(state.phase, "implement", "la cadena autorizó una ronda por el permiso propio ask");
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
  const beforePrompts = f.prompts.length;
  await f.action({ action: "verified" });
  state = await f.state();
  assert.equal(f.remote.pushed.get(f.checkout.branch), newHead, "verified continúa sin exigir otro comando fix");
  assert.equal(state.version === 2 && state.pullRequest?.number, 42);
  const s = enabled(state);
  assert.ok(s.operations.some(o => o.kind === "review" && o.subjectId === s.currentSubject && o.status === "confirmed"));
  assert.equal(s.budget.roundsUsed, 1);
  const pushPrompts = f.prompts.slice(beforePrompts).filter(p => /Push de la corrección/.test(p));
  assert.equal(pushPrompts.length, pushMode === "ask" ? 1 : 0, "corrections no decide la autoridad de push");
  assert.equal(gh.pull.merged, false, "Land manual espera comando");
 });
}


for (const mode of ["auto", "ask", "manual", "legacy"] as const) {
 test(`publicación fresca: entrada ${mode}, no confundir publicación con restore`, async t => {
  const { f, gh, number } = await continuityFixture(t, { change: block => {
   if (mode !== "legacy") block.continuity = { ...autoContinuity, entry: mode, review: "manual" };
  } });
  await f.command("pr");
  const state = await f.state();
  assert.equal(f.remote.prs.length, 1, "publicación real del fixture, no transición published fabricada");
  assert.equal(f.remote.prs[0]?.number, number);
  assert.equal(f.remote.pushed.get(f.checkout.branch), gh.pull.head());
  assert.equal(state.publication.status, "opened");
  if (mode === "auto" || mode === "ask") {
   assert.equal(state.phase, "review");
   assert.equal(enabled(state).operations.length, 0, "Review manual espera comando");
   assert.equal(state.version === 2 && state.pullRequest?.number, number);
   const adoptionPrompts = f.prompts.filter(p => /habilitar|continuidad|continuar.*lifecycle/i.test(p));
   if (mode === "auto") assert.equal(adoptionPrompts.length, 0, "entry:auto no pide confirmación de continuidad");
   else assert.ok(adoptionPrompts.length > 0, "entry:ask solicita confirmación");
  } else {
   assert.equal(state.phase, "done");
   assert.equal(state.version === 2 && state.lifecycle.status, "disabled");
  }
  assert.deepEqual(gh.mutations, [], "publicar/adoptar no hace ready ni merge");
 });
}

test("adopt explícito encadena Review → Land → Ship no aplicable sin otro comando", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity, entry: "manual" };
  block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 const state = await f.state(), s = enabled(state);
 assert.equal(reviews(state).length, 1, "adopt activa el avance configurado");
 assert.equal(gh.pull.merged, true, "Land reutiliza el ejecutor del host");
 assert.ok(s.completion, "Ship no aplicable se completa sólo después de observar el merge");
 assert.equal(s.completion.outcome, "not-applicable");
 assert.equal(gh.mutations.filter(args => args.includes("PUT")).length, 1);
});

test("continuidad auto conserva Review effect:ask y su rechazo detiene la cadena", async t => {
 const { f, gh } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity }; block.review.mode = "ask";
 } });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 f.context.ui.confirm = async (title, detail, options) => {
  const previous = f.remote.confirmations;
  if (/Review del PR/.test(title)) f.remote.confirmations = false;
  try { return await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
 };
 await f.command("adopt");
 const state = await f.state();
 assert.ok(f.prompts.some(p => /Review del PR/.test(p)), "auto continuidad no concede autoridad del efecto");
 assert.equal(reviews(state).length, 0);
 assert.deepEqual(gh.mutations, []);
 const prompts = f.prompts.length;
 await f.emit("agent_before_settle", {});
 assert.equal(f.prompts.length, prompts, "rechazar no repregunta en el siguiente settle");
});

for (const cancellation of ["reject", "cancel"] as const) {
 test(`entry ask: ${cancellation} no adopta ni reintenta por settle/reload`, async t => {
  const { f, gh } = await continuityFixture(t, { change: block => { block.continuity = { ...autoContinuity, entry: "ask" }; } });
  const confirm = f.context.ui.confirm.bind(f.context.ui);
  f.context.ui.confirm = async (title, detail, options) => {
   if (/habilitar|continuidad|continuar.*lifecycle/i.test(title)) {
    const previous = f.remote.confirmations; f.remote.confirmations = false;
    try { await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
    if (cancellation === "cancel") throw new DOMException("La persona canceló la confirmación", "AbortError");
    return false;
   }
   return confirm(title, detail, options);
  };
  await f.command("pr");
  assert.ok(f.prompts.some(p => /habilitar|continuidad|continuar.*lifecycle/i.test(p)), "el caso alcanza el permiso de entrada");
  assert.equal((await f.state()).version === 2 && (await f.state()).phase, "done");
  const before = await f.state(), prompts = f.prompts.length, reads = gh.reads.length;
  await f.emit("agent_before_settle", {}); await f.attach(); await f.emit("session_start", { reason: "reload" });
  assert.equal((await f.state()).revision, before.revision);
  assert.equal(f.prompts.length, prompts); assert.equal(gh.reads.length, reads); assert.deepEqual(gh.mutations, []);
 });
}

test("histórico con auto: restore, reload y árbol no adoptan ni consultan GitHub", async t => {
 const { f, gh } = await continuityFixture(t, { historical: true, change: block => { block.continuity = { ...autoContinuity }; } });
 const before = await f.state(), calls = f.calls.length, prompts = f.prompts.length;
 await f.attach(); await f.emit("session_start", { reason: "reload" }); await f.emit("session_tree", {});
 assert.equal((await f.state()).revision, before.revision);
 assert.equal((await f.state()).version === 2 && (await f.state()).phase, "done");
 assert.equal(f.prompts.length, prompts); assert.deepEqual(gh.mutations, []); assert.equal(gh.reads.length, 0);
 assert.equal(f.calls.slice(calls).filter(c => c.command === "gh").length, 0);
});

for (const outcome of ["pass", "unknown", "high", "outside", "cancel", "error", "missing-group", "restore"] as const) {
 test(`evaluador host auto ${outcome}: concede sólo código acotado, nunca push/merge`, async t => {
  const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
   block.continuity = { ...autoContinuity, land: "manual" }; block.review.mode = "auto"; block.corrections.mode = "auto";
  } });
  gh.inline.push({ id: 501, body: "Cubrir error del valor aprobado", commit_id: head, path: "value.cjs", line: 1 });
  let calls = 0;
  Reflect.set(f.context, "model", { provider: "mock", id: "mock", contextWindow: 200000 });
  Reflect.set(f.context.modelRegistry, "streamSimple", (_model: unknown, context: { tools: unknown[]; messages: { content: { text: string }[] }[] }, options: { toolChoice: string; cacheRetention: string }) => {
   calls++; assert.deepEqual(context.tools, []); assert.equal(options.toolChoice, "none"); assert.equal(options.cacheRetention, "none");
   const prompt = JSON.parse(context.messages[0]!.content[0]!.text) as { recipe: { objective: string }; material: string; findings: { id: string }[] };
   assert.equal(prompt.recipe.objective, "Devolver 2"); assert.match(prompt.material, /diff --git/);
   return { result: async () => {
    if (outcome === "cancel") throw new DOMException("Cancelado", "AbortError");
    if (outcome === "error") throw new Error("Modelo no disponible");
    if (outcome === "restore") await f.emit("session_tree", {});
    return { role: "assistant", provider: "mock", model: "mock", stopReason: "stop", usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0 },
     content: [{ type: "text", text: JSON.stringify({ verdict: outcome === "unknown" ? "unknown" : "pass", findings: outcome === "missing-group" ? [] : prompt.findings.map(finding => ({ id: finding.id, withinScope: outcome !== "outside", risk: outcome === "high" ? "high" : "low", humanRequired: false, reason: "Corregir manejo del valor dentro de la receta y del código observado" })) }) }] };
   } };
  });
  await f.command("adopt");
  const state = await f.state(), s = enabled(state);
  assert.equal(calls, 1, "usa el evaluador real conectado al modelo seleccionado, no texto remoto");
  assert.equal(state.phase === "implement", outcome === "pass");
  assert.equal(s.budget.roundsUsed, outcome === "pass" ? 1 : 0);
  if (outcome === "pass") {
   const round = s.corrections?.at(-1); assert.equal(round?.scopeSource, "policy"); assert.match(round?.authorityHash ?? "", /^[a-f0-9]{64}$/);
   assert.equal(state.steps.at(-1)?.red, null); assert.equal(state.steps.at(-1)?.commit, null, "TDD y commit siguen pendientes");
   assert.equal(f.prompts.filter(p => /Corregir .*hallazgo/.test(p)).length, 0, "riesgo/alcance verificados no fuerzan otro sí");
  } else assert.equal(s.corrections?.length ?? 0, 0);
  assert.equal(f.remote.pushed.size, 0); assert.deepEqual(gh.mutations, []);
 });
}

for (const interruption of ["restore", "abort"] as const) {
 test(`Review does not reserve after ${interruption} during its own fresh pin await`, async t => {
  const { f, gh, kb } = await continuityFixture(t, { change: block => {
   block.continuity = autoContinuity; block.review.mode = "auto";
  } });
  const controller = new AbortController();
  Reflect.set(f.context, "signal", controller.signal);
  const currentPerillas = kb.currentPerillas.bind(kb);
  let reads = 0;
  kb.currentPerillas = async (...args) => {
   const document = await currentPerillas(...args);
   const state = await f.state();
   if (state.version === 2 && state.lifecycle.status === "enabled" && ++reads === 2) {
    if (interruption === "restore") await f.emit("session_tree", {});
    else controller.abort();
   }
   return document;
  };
  await f.command("pr");
  const state = await f.state();
  assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
  assert.ok(reads >= 2, "interrupted the executor freshness await, not the outer host read");
  assert.equal(state.lifecycle.operations.length, 0, "must invalidate the continuation before reserving Review");
  assert.deepEqual(gh.mutations, []);
 });
}

test("auto fix pausa un hallazgo ambiguo en vez de asumir alcance o riesgo", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity }; block.review.mode = "auto"; block.corrections.mode = "auto";
 } });
 gh.inline.push({ id: 501, body: "Tal vez hay que migrar infraestructura compartida; falta información", commit_id: head, path: "value.cjs", line: 1 });
 await f.command("adopt");
 const state = await f.state(), s = enabled(state);
 assert.equal(reviews(state).length, 1, "la cadena llegó a ingerir el hallazgo real de GitHub");
 assert.equal(s.ledger.length, 1); assert.equal(s.budget.roundsUsed, 0);
 assert.equal(s.corrections?.length ?? 0, 0, "no hay ronda auto autorizada por texto remoto");
 assert.notEqual(state.phase, "implement"); assert.deepEqual(gh.mutations, []);
 assert.equal(f.remote.pushed.size, 0);
 assert.match(f.messages.join("\n"), /alcance|ambigu|información|humano|riesgo/i, "explica por qué espera a una persona");
});

test("omi-code: Review GHA auto pide permiso humano de dispatch y rechazar no despacha", async t => {
 const { f, gh } = await continuityFixture(t, { repo: "chichex/omi-code", historical: true, change: block => {
  block.continuity = { ...autoContinuity }; block.review.mode = "auto";
  block.review.provider = { kind: "gha", workflow: "review.yml", ref: "main", contract: "omi-review-v1" };
 } });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 f.context.ui.confirm = async (title, detail, options) => {
  const previous = f.remote.confirmations;
  if (/Review del PR/.test(title)) f.remote.confirmations = false;
  try { return await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
 };
 await f.command("adopt");
 assert.ok(f.prompts.some(p => /Review del PR/.test(p)), "la cadena alcanza la autorización humana de dispatch");
 assert.equal(reviews(await f.state()).length, 0);
 assert.deepEqual(gh.mutations, []);
 assert.equal(f.calls.filter(c => c.command === "gh" && (c.args.includes("dispatches") || c.args.includes("run"))).length, 0);
});

test("Review manual espera comando; el comando explícito luego encadena Land y Ship", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity, review: "manual" }; block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 assert.equal(reviews(await f.state()).length, 0); assert.deepEqual(gh.mutations, []);
 await f.command("review");
 assert.equal(reviews(await f.state()).length, 1);
 assert.equal(gh.pull.merged, true);
 assert.equal(enabled(await f.state()).completion?.outcome, "not-applicable");
});

test("omi-code: cadena auto llega a Land pero merge sigue humano", async t => {
 const { f, gh, head } = await continuityFixture(t, { repo: "chichex/omi-code", historical: true, change: block => {
  block.continuity = { ...autoContinuity }; block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 f.context.ui.confirm = async (title, detail, options) => {
  const previous = f.remote.confirmations;
  if (/Mergear el PR/.test(title)) f.remote.confirmations = false;
  try { return await confirm(title, detail, options); } finally { f.remote.confirmations = previous; }
 };
 await f.command("adopt");
 assert.equal(reviews(await f.state()).length, 1);
 assert.ok(f.prompts.some(p => /Mergear el PR/.test(p)), "no detener antes de alcanzar el permiso bajo prueba");
 assert.equal(gh.pull.merged, false); assert.equal(gh.mutations.filter(args => args.includes("PUT")).length, 0);
 const prompts = f.prompts.length;
 await f.emit("agent_before_settle", {});
 assert.equal(f.prompts.length, prompts, "no vuelve a ofrecer el merge rechazado");
});
