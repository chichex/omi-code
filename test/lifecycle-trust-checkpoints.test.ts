// Casos complementarios de invariantes del registro: también los ejecuta la suite completa.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { memoryKb } from "./helpers/mock-kb.ts";
import { defaultLifecycleConfig } from "../src/harness/lifecycle-config.ts";
import { prepareLifecycleSave, commitLifecycleSave } from "../src/harness/lifecycle-kb.ts";
import { lifecycleTrustDir, writeLifecycleTrust } from "../src/harness/lifecycle-trust.ts";

test("una aceptación concurrente ya conocida impide incluso enviar la revisión KB", async t => {
 const root = await realpath(await mkdtemp(`${tmpdir()}/omi-lifecycle-cas-`)); t.after(() => rm(root, { recursive: true, force: true }));
 const kb = memoryKb({ products: ["app"] }); const key = { kbUrl: kb.url, product: "app", repo: "acme/app" };
 const trustDir = lifecycleTrustDir(root); const block = defaultLifecycleConfig(key.repo, "main");
 const signal = AbortSignal.timeout(5000); const prepared = await prepareLifecycleSave(kb, key, block, signal, null, root);
 await writeLifecycleTrust(trustDir, key, undefined, { version: 1, revision: 0, ...key, accepted: null, deferred: { revision: "missing:none", at: "now" } });
 await assert.rejects(commitLifecycleSave(kb, key, block, prepared, { trustDir, expectedRevision: undefined, signal, now: () => "now" }), /cambi/);
 assert.equal(kb.calls.filter(c => c.tool === "guardar").length, 0);
});
