import { test } from "node:test";
import assert from "node:assert/strict";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runWorkflowCommand } from "../src/harness/commands.ts";
const checkout = { root: "/safe/tmp", commonDir: "/safe/tmp/.git", branch: "feat/task", baseCommit: "a".repeat(40) };

test("workflow commands use native backend, sanitized child env and bounded output tail", async () => {
 const old = process.env.PI_PACKAGE_DIR; process.env.PI_PACKAGE_DIR = "/host/private";
 try {
  const backend: BashOperations = { async exec(command, cwd, options) {
   assert.equal(command, "npm test"); assert.equal(cwd, checkout.root); assert.equal(options.env?.PI_PACKAGE_DIR, undefined); assert.equal(options.timeout, 30);
   options.onData(Buffer.from("secret-prefix" + "x".repeat(12000))); return { exitCode: 0 };
  } };
  const result = await runWorkflowCommand(checkout, "npm test", new AbortController().signal, 30, backend);
  assert.equal(result.output, "x".repeat(12000)); assert.equal(result.exitCode, 0); assert.equal(result.interrupted, false);
 } finally { if (old === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = old; }
});

test("timeout/cancellation are interrupted evidence, not successful commands or leaked errors", async () => {
 for (const message of ["aborted", "timeout:1"]) {
  const backend: BashOperations = { async exec() { throw new Error(message); } };
  const result = await runWorkflowCommand(checkout, "safe", new AbortController().signal, 1, backend);
  assert.equal(result.exitCode, null); assert.equal(result.interrupted, true);
 }
 const controller = new AbortController(); controller.abort(); let called = false;
 const backend: BashOperations = { async exec() { called = true; return { exitCode: 0 }; } };
 assert.equal((await runWorkflowCommand(checkout, "safe", controller.signal, 1, backend)).interrupted, true); assert.equal(called, false);
});

test("backend errors are failed evidence without dumping potentially secret messages", async () => {
 const backend: BashOperations = { async exec() { throw new Error("TOKEN=do-not-print"); } };
 const result = await runWorkflowCommand(checkout, "safe", new AbortController().signal, 1, backend);
 assert.equal(result.exitCode, null); assert.equal(result.interrupted, false); assert.ok(!result.output.includes("TOKEN"));
});

test("workflow commands distinguish a timeout from a cancellation", async () => {
 const timedOut: BashOperations = { async exec() { throw new Error("timeout:240"); } };
 const timeout = await runWorkflowCommand(checkout, "npm test", new AbortController().signal, 240, timedOut);
 assert.equal(timeout.timedOut, true); assert.equal(timeout.interrupted, true); assert.equal(timeout.exitCode, null);
 const aborted: BashOperations = { async exec() { throw new Error("aborted"); } };
 const cancel = await runWorkflowCommand(checkout, "npm test", new AbortController().signal, 240, aborted);
 assert.equal(cancel.interrupted, true); assert.equal("timedOut" in cancel, false, "cancelar no es un corte por tiempo");
 // Si la persona cancela justo cuando vence el plazo, gana la cancelación.
 const controller = new AbortController();
 const both: BashOperations = { async exec() { controller.abort(); throw new Error("timeout:240"); } };
 const race = await runWorkflowCommand(checkout, "npm test", controller.signal, 240, both);
 assert.equal(race.interrupted, true); assert.equal("timedOut" in race, false);
 const passed: BashOperations = { async exec() { return { exitCode: 0 }; } };
 assert.equal("timedOut" in await runWorkflowCommand(checkout, "npm test", new AbortController().signal, 240, passed), false);
 const failed: BashOperations = { async exec() { throw new Error("TOKEN=do-not-print"); } };
 assert.equal("timedOut" in await runWorkflowCommand(checkout, "npm test", new AbortController().signal, 240, failed), false, "otro error del backend no es un corte por tiempo");
});
