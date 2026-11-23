// Motivo de pausa estructurado en el host real: Git temporal, GitHub y KB falsos, sin red.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workflow } from "../src/harness/model.ts";
import { autoContinuity, continuityFixture, reacceptLifecycleConfig } from "./helpers/lifecycle-continuity.ts";
import { lifecycleConfig } from "./helpers/lifecycle.ts";

const pauseOf = (state: Workflow) => state.version === 2 ? state.continuityPause : undefined;
const count = (text: string, part: string) => text.split(part).length - 1;
async function agentPrompt(f: Awaited<ReturnType<typeof continuityFixture>>["f"]): Promise<string> {
 const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
 await f.emit("before_agent_start", event);
 return event.systemPromptOptions.sections.omi_development ?? "";
}
const emittedPause = (event: unknown): unknown => event && typeof event === "object" && "progress" in event && event.progress && typeof event.progress === "object" && "lifecyclePause" in event.progress ? event.progress.lifecyclePause : undefined;

test("Review manual: la pausa queda estructurada y legible, una vez en status, para el agente y en el panel; el comando la deja atrás", async t => {
 const { f, gh, head } = await continuityFixture(t, { historical: true, change: block => {
  block.continuity = { ...autoContinuity, review: "manual" }; block.review.mode = "auto"; block.land.mode = "auto";
 } });
 gh.reviews.push({ id: 601, login: "ada", state: "APPROVED", commit_id: head, body: "" });
 await f.command("adopt");
 const state = await f.state();
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
 const pause = pauseOf(state);
 assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage, subjectId: pause.subjectId }, { reason: "manual", stage: "review", subjectId: state.lifecycle.currentSubject });
 assert.doesNotMatch(state.activity, /pausa/i, "la pausa no se guarda en activity");
 const readable = "Review está en manual: corré /omi-work review";
 assert.ok(f.messages.at(-1)?.includes(`Continuidad en pausa · ${readable}`), "el aviso al pausar es legible");
 await f.command("status");
 const status = f.messages.at(-1) ?? "";
 assert.equal(count(status, readable), 1, "status la muestra una sola vez");
 assert.doesNotMatch(status, /manual · review|Continuidad en pausa: /, "sin el código crudo del formato anterior");
 assert.match(await agentPrompt(f), /Continuidad en pausa · Review está en manual: corré \/omi-work review/);
 assert.equal(emittedPause(f.progress.at(-1)), readable, "el panel recibe la pausa vigente");
 const handle = gh.handle; const during: unknown[] = [];
 gh.handle = (args, input) => { during.push(emittedPause(f.progress.at(-1))); return handle(args, input); };
 await f.command("review");
 assert.ok(during.length > 0, "la Review leyó GitHub");
 assert.deepEqual(during.filter(value => value !== undefined), [], "mientras corre el comando, la pausa vieja no se muestra");
 const done = await f.state();
 assert.ok(done.version === 2 && done.lifecycle.status === "enabled" && done.lifecycle.completion, "la cadena siguió hasta el final");
 assert.equal(pauseOf(done), undefined, "la corrida nueva no deja la pausa anterior");
});

test("si el pin fresco quita la continuidad a mitad de cadena, el motivo es propio y no «manual»", async t => {
 const { f, gh, kb } = await continuityFixture(t, { change: block => { block.continuity = autoContinuity; block.review.mode = "auto"; } });
 const currentPerillas = kb.currentPerillas.bind(kb);
 let replaced = false;
 kb.currentPerillas = async (...args) => {
  const state = await f.state();
  if (!replaced && state.version === 2 && state.lifecycle.status === "enabled") {
   replaced = true;
   await reacceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig("acme/app", block => { block.review.mode = "auto"; block.ship = { status: "not-applicable", targets: [] }; }));
  }
  return currentPerillas(...args);
 };
 await f.command("pr");
 const state = await f.state(), pause = pauseOf(state);
 assert.equal(replaced, true);
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled");
 assert.deepEqual(pause && { reason: pause.reason, stage: pause.stage }, { reason: "continuity-disabled", stage: "review" });
 assert.match(f.messages.at(-1) ?? "", /ya no tiene continuidad.*\/omi-work review/);
 assert.deepEqual(gh.mutations, []);
});

test("un no a la entrada queda como motivo de la entrada; adoptar a mano lo deja atrás", async t => {
 const { f, gh } = await continuityFixture(t, { change: block => { block.continuity = { ...autoContinuity, entry: "ask", review: "manual" }; } });
 f.remote.confirmations = false;
 await f.command("pr");
 let state = await f.state();
 assert.equal(state.phase, "done");
 assert.ok(state.publication.status === "opened");
 const declined = pauseOf(state);
 assert.deepEqual(declined && { reason: declined.reason, stage: declined.stage, subjectId: declined.subjectId }, { reason: "declined", stage: "entry", subjectId: state.publication.head });
 await f.command("status");
 assert.equal(count(f.messages.at(-1) ?? "", "Dijiste que no a seguir con la adopción del PR: cuando quieras, /omi-work adopt"), 1);
 f.remote.confirmations = true;
 await f.command("adopt");
 state = await f.state();
 const next = pauseOf(state);
 assert.deepEqual(next && { reason: next.reason, stage: next.stage }, { reason: "manual", stage: "review" }, "el motivo vigente es el de la etapa nueva");
 await f.command("status");
 assert.doesNotMatch(f.messages.at(-1) ?? "", /Dijiste que no/);
 assert.deepEqual(gh.mutations, []);
});
