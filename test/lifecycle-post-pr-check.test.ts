// Después del PR, omi_workflow_check no es un camino para disparar workflows por fuera del lifecycle:
// sólo corre durante una corrección en curso. executeCheck y el estado guardado son reales; el proceso es falso
// y nunca corre gh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeCheck } from "../src/tui/development-execution.ts";
import { DevelopmentSession } from "../src/tui/development-session.ts";
import { testIo } from "./helpers/io.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";

const DISPATCH = "gh workflow run claude-review.yml -f pr=42";
type Fixture = Awaited<ReturnType<typeof continuityFixture>>;

async function setupChecker({ f, kb }: Fixture) {
 const pi = { appendEntry: (name: string, data: unknown) => f.manager.appendCustomEntry(name, data), events: { emit() {} } } as unknown as ExtensionAPI;
 const session = new DevelopmentSession(pi, testIo({ homeDir: f.home, cwd: f.checkout.root }), [], { runner: f.runner, loader: f.loader, kb });
 const executed: string[] = [];
 const check = async (command: string) => {
  await session.restore(f.context);
  return executeCheck(session, { kind: "setup", command }, f.context, new AbortController().signal, async (_checkout, actual) => {
   executed.push(actual); return { exitCode: 0, output: "inyectado", interrupted: false };
  });
 };
 return { executed, check };
}

test("PR adoptado en Review: setup no dispara un workflow y guía a /omi-work review", async t => {
 const fixture = await continuityFixture(t, { historical: true });
 await fixture.f.command("adopt");
 const state = await fixture.f.state();
 assert.equal(state.phase, "review"); assert.equal(state.status, "active");
 const { executed, check } = await setupChecker(fixture);
 await assert.rejects(check(DISPATCH), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /\/omi-work review/);
  assert.match(error.message, /corrección en curso/);
  assert.match(error.message, /Próximo paso para la persona: corré \/omi-work review\./);
  return true;
 });
 assert.deepEqual(executed, [], "no llegó al ejecutor");
});

test("PR draft abierto: omi_workflow_check no está activo y guía a /omi-work adopt y /omi-work review", async t => {
 const fixture = await continuityFixture(t, { historical: true });
 const state = await fixture.f.state();
 assert.equal(state.phase, "done"); assert.equal(state.status, "complete");
 const { executed, check } = await setupChecker(fixture);
 await assert.rejects(check(DISPATCH), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /^El trabajo no está activo \(PR draft abierto\)/);
  assert.match(error.message, /no dispara workflows/);
  assert.match(error.message, /Próximo paso para la persona: corré \/omi-work adopt y después \/omi-work review/);
  return true;
 });
 assert.deepEqual(executed, []);
});

test("setup corre durante una corrección en curso y deja de correr con la corrección verificada sin push", async t => {
 const fixture = await continuityFixture(t, { historical: true,
  foundations: { arranque: "auto", receta: "auto", push_pr: "ask" },
  change: block => { block.continuity = { ...autoContinuity, land: "manual" }; block.review.mode = "auto"; block.corrections.mode = "ask"; },
 });
 const { f, gh, head } = fixture;
 gh.inline.push({ id: 501, body: "Falta cubrir el valor 3", commit_id: head, path: "value.cjs", line: 1 });
 await f.command("adopt");
 assert.equal((await f.state()).phase, "implement", "la cadena abrió una ronda");
 const { executed, check } = await setupChecker(fixture);
 await check("npm ci");
 assert.deepEqual(executed, ["npm ci"], "el fix prepara su checkout con setup");
 const step = (await f.state()).steps.at(-1)!;
 await f.action({ action: "step", id: step.id });
 await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n');
 await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: step.id });
 await f.write("value.cjs", "module.exports = 3;\n");
 await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: step.id });
 await f.invoke("omi_workflow_commit", { stepId: step.id, message: "fix: cubrir el valor 3", paths: ["value.cjs", "test.cjs"] });
 await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
 f.remote.confirmations = false; // No al push: la corrección queda verificada, sin publicar.
 await f.action({ action: "verified" });
 const state = await f.state();
 const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout.root, encoding: "utf8" }).trim();
 assert.notEqual(f.remote.pushed.get(f.checkout.branch), newHead, "sin push");
 assert.ok(state.version === 2 && state.lifecycle.status === "enabled" && state.lifecycle.corrections?.at(-1)?.status === "verified");
 assert.equal(state.phase, "pr");
 await assert.rejects(check(DISPATCH), /corrección en curso/);
 assert.deepEqual(executed, ["npm ci"], "el dispatch no llegó al ejecutor");
});
