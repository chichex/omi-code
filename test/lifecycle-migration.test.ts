import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, stat, readdir, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Value } from "typebox/value";
import * as model from "../src/harness/model.ts";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { workflowPath, readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { renderPullRequestBody } from "../src/harness/github.ts";
import { renderWorkflowArtifact } from "../src/harness/pr-body.ts";

function legacy() {
 const source = { number: 42, title: "Legacy", body: "Pedido original\n", url: "https://github.com/acme/app/issues/42", hash: model.sourceHash("Legacy", "Pedido original\n") };
 return { version: 1 as const, id: "legacy", revision: 7, source,
  checkout: { root: "/repo", commonDir: "/repo/.git", branch: "feat/legacy", baseCommit: "a".repeat(40) }, phase: "pr" as const, status: "active" as const,
  blockedReason: "", activity: "verified", exploration: null, inferences: [], recipe: null, diagnosis: null, spec: null, steps: [],
  evidence: [{ id: "proof", kind: "verification" as const, command: "npm test", stepId: null, caseId: "D1", exitCode: 0, outcome: "passed" as const, output: "output privado", fingerprint: "tree", head: "b".repeat(40), startedAt: "now", finishedAt: "now" }],
  reviews: [], round: 2, maxRounds: 3, approval: { sourceHash: source.hash, recipeHash: "approved", at: "now" }, publication: { status: "none" as const },
  grants: [{ key: "grant", command: "npm test", at: "now" }], agreements: [], observations: [], history: [{ at: "now", phase: "verify" as const, activity: "verified" }] };
}
async function fixture(t: TestContext) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "omi-migrate-"))); t.after(() => rm(root, { recursive: true, force: true }));
 const state = { ...legacy(), checkout: { ...legacy().checkout, root, commonDir: join(root, ".git") } };
 const path = workflowPath(state.checkout, 42); await mkdir(dirname(path), { recursive: true });
 const raw = JSON.stringify(state, null, 3) + "\n"; await writeFile(path, raw, { mode: 0o600 });
 return { state, path, raw, backup: `${path}.v1.bak` };
}
const pause = (state: model.Workflow | undefined) => { assert.ok(state); return transition(state, { type: "pause", reason: "fixture" }, "later"); };

test("migración pura v1→v2 conserva todas las propiedades previas y deshabilita lifecycle", () => {
 const old = legacy(); const before = JSON.stringify(old); const next = model.parseWorkflow(before);
 assert.equal(next.version, 2);
 assert.deepEqual(next.lifecycle, { status: "disabled" }); assert.equal(next.publicationFormat, 1); assert.equal(next.pullRequest, null);
 for (const [key, value] of Object.entries(old)) if (key !== "version") assert.deepEqual(Reflect.get(next, key), value, key);
 assert.equal(JSON.stringify(old), before, "no muta el input");
 assert.equal(typeof model.migrateWorkflow, "function");
 assert.deepEqual(model.migrateWorkflow(old), next); assert.deepEqual(model.migrateWorkflow(next), next);
 const detached = model.migrateWorkflow(old); detached.source.body = "otra copia"; assert.equal(old.source.body, "Pedido original\n");
 assert.equal(Value.Check(model.WorkflowV1Schema, next), false, "el schema del binario anterior rechaza v2");
});

test("un trabajo nuevo usa v2 sin habilitar operaciones, y v2 incompleto/futuro falla cerrado", () => {
 const old = legacy(); const fresh = createWorkflow(old.source, old.checkout, "new", "now");
 assert.equal(fresh.version, 2); assert.deepEqual(fresh.lifecycle, { status: "disabled" });
 for (const value of [{ ...old, version: 2 }, { ...fresh, version: 3 }, { ...fresh, unexpected: true }, { ...fresh, lifecycle: { status: "enabled" } }]) assert.throws(() => model.parseWorkflow(JSON.stringify(value)), /inválido/);
});

// El formato del cuerpo es el de #64 (Markdown con Closes): migrar v1→v2 no lo cambia ni invalida el bodyHash pendiente.
test("pending conserva renderer/cuerpo/hash, incluso tras migrar y reiniciar", () => {
 const old: model.Workflow = legacy(); old.publication = { status: "pending", head: "b".repeat(40), bodyHash: model.artifactHash(renderWorkflowArtifact(old)), at: "now" };
 const body = renderPullRequestBody(old);
 const next = model.parseWorkflow(JSON.stringify(old));
 assert.equal(renderWorkflowArtifact(next), renderWorkflowArtifact(old)); assert.equal(renderPullRequestBody(next), body);
 assert.equal(renderPullRequestBody(model.parseWorkflow(JSON.stringify(next))), body);
 assert.match(body, /^Closes #42$/m); assert.doesNotMatch(body, /^Refs #42$/m);
});

test("done/complete histórico sigue terminal y la identidad PR queda independiente, sin ownership inventado", () => {
 const old = { ...legacy(), phase: "done" as const, status: "complete" as const, publication: { status: "opened" as const, head: "b".repeat(40), number: 9, url: "https://github.com/acme/app/pull/9" } };
 const next = model.parseWorkflow(JSON.stringify(old));
 assert.equal(next.phase, "done"); assert.equal(next.status, "complete"); assert.deepEqual(next.lifecycle, { status: "disabled" });
 assert.deepEqual(next.pullRequest, { number: 9, url: old.publication.url, head: old.publication.head, branch: old.checkout.branch, base: "main", ownership: "unadopted" });
 assert.throws(() => transition(next, { type: "resume" }, "now"), /cerrado/);
});

test("leer migra sólo en memoria; primera escritura hace backup exacto0600 bajo CAS", async t => {
 const f = await fixture(t); const next = await readWorkflow(f.state.checkout, 42);
 assert.equal(next?.version, 2); assert.equal(await readFile(f.path, "utf8"), f.raw); await assert.rejects(stat(f.backup));
 const updated = await updateWorkflow(f.state.checkout, 42, 7, pause);
 assert.equal(updated.version, 2); assert.equal(updated.revision, 8);
 assert.equal(await readFile(f.backup, "utf8"), f.raw); assert.equal((await stat(f.backup)).mode & 0o777, 0o600);
 assert.equal(JSON.parse(await readFile(f.path, "utf8")).version, 2);
 await updateWorkflow(f.state.checkout, 42, 8, current => { assert.ok(current); return transition(current, { type: "resume" }, "now"); });
 assert.equal(await readFile(f.backup, "utf8"), f.raw, "no sobrescribe el backup en escrituras siguientes");
});

test("CAS fallido o cambio inválido no producen backup ni reemplazo", async t => {
 const f = await fixture(t);
 await assert.rejects(updateWorkflow(f.state.checkout, 42, 6, pause));
 await assert.rejects(updateWorkflow(f.state.checkout, 42, 7, current => { assert.ok(current); return { ...current, revision: 999 }; }));
 await assert.rejects(stat(f.backup)); assert.equal(await readFile(f.path, "utf8"), f.raw);
});

test("concurrencia en primera migración: un writer, un backup y revisión única", async t => {
 const f = await fixture(t); const results = await Promise.allSettled([updateWorkflow(f.state.checkout, 42, 7, pause), updateWorkflow(f.state.checkout, 42, 7, pause)]);
 assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
 assert.equal((await readWorkflow(f.state.checkout, 42))?.revision, 8); assert.equal(await readFile(f.backup, "utf8"), f.raw);
 assert.deepEqual((await readdir(dirname(f.path))).sort(), ["42.json", "42.json.v1.bak"]);
});

test("un backup ya escrito por un intento previo sólo se reutiliza si coincide exactamente", async t => {
 const f = await fixture(t); await writeFile(f.backup, f.raw, { mode: 0o600 });
 await updateWorkflow(f.state.checkout, 42, 7, pause); assert.equal(await readFile(f.backup, "utf8"), f.raw);
 const other = await fixture(t); await writeFile(other.backup, "otro contenido", { mode: 0o600 });
 await assert.rejects(updateWorkflow(other.state.checkout, 42, 7, pause)); assert.equal(await readFile(other.path, "utf8"), other.raw);
 assert.equal(await readFile(other.backup, "utf8"), "otro contenido");
});

for (const kind of ["symlink", "hardlink", "oversize"] as const) test(`backup ${kind} no se sigue ni se reemplaza`, async t => {
 const f = await fixture(t); const outside = join(dirname(f.path), "outside"); await writeFile(outside, "untouched");
 if (kind === "symlink") await symlink(outside, f.backup);
 else if (kind === "hardlink") await link(outside, f.backup);
 else await writeFile(f.backup, " ".repeat(8 * 1024 * 1024 + 1));
 await assert.rejects(updateWorkflow(f.state.checkout, 42, 7, pause));
 assert.equal(await readFile(f.path, "utf8"), f.raw); assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("estado corrupto/futuro/oversize no se respalda como válido ni se recrea", async t => {
 const f = await fixture(t);
 for (const raw of ["{broken", JSON.stringify({ ...f.state, version: 99 }), " ".repeat(8 * 1024 * 1024 + 1)]) {
  await writeFile(f.path, raw); await assert.rejects(readWorkflow(f.state.checkout, 42)); await assert.rejects(updateWorkflow(f.state.checkout, 42, undefined, () => f.state));
  assert.equal(await readFile(f.path, "utf8"), raw); await assert.rejects(stat(f.backup));
 }
});

test("no downgrade silencioso de v2 ni reemplazo de identidad", async t => {
 const f = await fixture(t); await updateWorkflow(f.state.checkout, 42, 7, pause); const before = await readFile(f.path, "utf8");
 await assert.rejects(updateWorkflow(f.state.checkout, 42, 8, () => ({ ...f.state, revision: 9 })), /downgrade|versión|v2/);
 await assert.rejects(updateWorkflow(f.state.checkout, 42, 8, current => { assert.ok(current); return { ...current, id: "other", revision: 9 }; }));
 assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await readFile(f.backup, "utf8"), f.raw);
});
