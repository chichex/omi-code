import assert from "node:assert/strict";
import { test } from "node:test";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";
import { acceptLifecycleConfig, lifecycleConfig } from "./helpers/lifecycle.ts";

test("a fresh-entry yes cannot authorize a replacement reviewer pin", async t => {
 const { f, gh, kb } = await continuityFixture(t, { change: block => {
  block.continuity = { ...autoContinuity, entry: "ask" };
 } });
 const confirm = f.context.ui.confirm.bind(f.context.ui);
 let replaced = false;
 f.context.ui.confirm = async (title, detail, options) => {
  const answer = await confirm(title, detail, options);
  if (/Continuidad/.test(title)) {
   assert.equal(replaced, false, "the replacement pin must not inherit or reprompt the original yes");
   assert.equal(answer, true);
   replaced = true;
   const replacement = lifecycleConfig("acme/app", block => {
    block.continuity = { ...autoContinuity, entry: "ask" };
    block.review.provider = { kind: "github", reviewers: ["grace"] };
    block.ship = { status: "not-applicable", targets: [] };
   });
   await acceptLifecycleConfig(kb, f.home, f.checkout.root, replacement);
  }
  return answer;
 };
 await f.command("pr");
 assert.equal(replaced, true, "the accepted pin changed while the old dialog was pending");
 const state = await f.state();
 assert.equal(state.phase, "done");
 assert.equal(state.version === 2 && state.lifecycle.status, "disabled");
 const pause = state.version === 2 ? state.continuityPause : undefined;
 assert.equal(pause?.reason, "error", "un error de texto libre usa el código genérico");
 assert.match(pause?.detail ?? "", /\S/, "y su texto queda como detalle");
 assert.deepEqual(gh.reads, [], "the mismatched pin is rejected before any lifecycle GitHub reads");
 assert.deepEqual(gh.mutations, []);
});

test("disabling continuity in the fresh pin stops future operations in the same chain", async t => {
 const { f, gh, kb } = await continuityFixture(t, { change: block => {
  block.continuity = autoContinuity; block.review.mode = "auto";
 } });
 const currentPerillas = kb.currentPerillas.bind(kb);
 let replaced = false;
 kb.currentPerillas = async (...args) => {
  const state = await f.state();
  if (!replaced && state.version === 2 && state.lifecycle.status === "enabled") {
   replaced = true;
   await acceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig("acme/app", block => {
    block.review.mode = "auto"; block.ship = { status: "not-applicable", targets: [] };
   }));
  }
  return currentPerillas(...args);
 };
 await f.command("pr");
 const state = await f.state();
 assert.equal(replaced, true);
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
 assert.equal(state.lifecycle.operations.length, 0, "removing continuity applies before the next reservation");
 assert.deepEqual(gh.mutations, []);
});

for (const interruption of ["restore", "abort"] as const) {
 test(`an awaited fresh pin after adoption cannot advance after ${interruption}`, async t => {
  const { f, gh, kb } = await continuityFixture(t, { change: block => {
   block.continuity = autoContinuity;
   block.review.mode = "auto";
  } });
  const controller = new AbortController();
  Object.defineProperty(f.context, "signal", { configurable: true, value: controller.signal });
  const currentPerillas = kb.currentPerillas.bind(kb);
  let interrupted = false;
  kb.currentPerillas = async (...args) => {
   const document = await currentPerillas(...args);
   const state = await f.state();
   if (!interrupted && state.version === 2 && state.lifecycle.status === "enabled") {
    interrupted = true;
    if (interruption === "restore") await f.emit("session_tree", {});
    else controller.abort();
   }
   return document;
  };
  await f.command("pr");
  assert.equal(interrupted, true, "interruption occurred inside the awaited freshness read, after adoption");
  const state = await f.state();
  assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
  assert.equal(state.lifecycle.operations.length, 0, "the invalid context cannot reserve Review");
  assert.deepEqual(gh.mutations, []);
 });


 test(`a late continuity yes after ${interruption} cannot adopt or reserve`, async t => {
  const { f, gh } = await continuityFixture(t, { change: block => { block.continuity = { ...autoContinuity, entry: "ask" }; } });
  const controller = new AbortController();
  Object.defineProperty(f.context, "signal", { configurable: true, value: controller.signal });
  const confirm = f.context.ui.confirm.bind(f.context.ui);
  f.context.ui.confirm = async (title, detail, options) => {
   const answer = await confirm(title, detail, options);
   if (/Continuidad/.test(title)) {
    if (interruption === "restore") await f.emit("session_tree", {});
    else controller.abort();
   }
   return answer;
  };
  await f.command("pr");
  const state = await f.state();
  assert.equal(state.phase, "done", "old confirmation must not adopt after its context is invalid");
  assert.equal(state.version === 2 && state.lifecycle.status, "disabled");
  assert.deepEqual(gh.mutations, []);
 });
}
