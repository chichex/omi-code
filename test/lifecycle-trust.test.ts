import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, realpath, rm, readdir, readFile, writeFile, mkdir, stat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKb } from "./helpers/mock-kb.ts";
import { defaultLifecycleConfig, lifecycleHash, renderLifecycleBlock } from "../src/harness/lifecycle-config.ts";
import { lifecycleTrustDir, lifecycleTrustPath, readLifecycleTrust, writeLifecycleTrust, type LifecycleKey, type LifecycleTrust } from "../src/harness/lifecycle-trust.ts";
import { readLifecycle, evaluateLifecycle, lifecycleDiff, acceptLifecycle, prepareLifecycleSave, commitLifecycleSave } from "../src/harness/lifecycle-kb.ts";

const key: LifecycleKey = { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" };
const block = () => defaultLifecycleConfig(key.repo, "main");
const signal = () => AbortSignal.timeout(5000);
const now = () => "2026-01-01T00:00:00Z";
function trust(): LifecycleTrust { return { version: 1, revision: 0, ...key, accepted: { docId: "doc", blockHash: lifecycleHash(block()), block: block(), author: "Ada", date: "date", acceptedAt: now() }, deferred: null }; }
async function fixture(t: TestContext) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "omi-lifecycle-"))); t.after(() => rm(root, { recursive: true, force: true }));
 const dir = lifecycleTrustDir(root); const kb = memoryKb({ products: ["app"] });
 return { root, dir, kb, deps: { trustDir: dir, expectedRevision: undefined, now, signal: signal() } };
}
const accepted = async (dir: string) => { const reading = await readLifecycleTrust(dir, key); assert.ok(reading.kind === "valid"); return reading.record; };

test("trust missing es lectura pura y la identidad separa KB/producto/repo", async t => {
 const f = await fixture(t);
 assert.deepEqual(await readLifecycleTrust(f.dir, key), { kind: "missing" });
 assert.deepEqual(await readdir(f.root), [], "leer no crea el directorio");
 assert.equal(f.dir, join(f.root, ".omi/agent/development-lifecycle"));
 const paths = [key, { ...key, kbUrl: "https://other.test/mcp" }, { ...key, product: "other" }, { ...key, repo: "other/app" }].map(k => lifecycleTrustPath(f.dir, k));
 assert.equal(new Set(paths).size, paths.length);
});

test("aceptación/pin privado durable, CAS y sólo una escritura concurrente", async t => {
 const f = await fixture(t); const record = trust();
 await writeLifecycleTrust(f.dir, key, undefined, record);
 assert.deepEqual(await accepted(f.dir), record);
 assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
 assert.equal((await stat(lifecycleTrustPath(f.dir, key))).mode & 0o777, 0o600);
 await assert.rejects(writeLifecycleTrust(f.dir, key, undefined, record));
 const changed = { ...record, revision: 1, deferred: { revision: "missing:doc", at: now() } };
 const results = await Promise.allSettled([writeLifecycleTrust(f.dir, key, 0, changed), writeLifecycleTrust(f.dir, key, 0, changed)]);
 assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
 assert.equal((await accepted(f.dir)).revision, 1);
 assert.deepEqual((await readdir(f.dir)).sort(), [lifecycleTrustPath(f.dir, key).split("/").at(-1)]);
});

test("corrupto/futuro/hash o identidad ajena no se reemplazan ni cuentan como ausencia", async t => {
 const f = await fixture(t); await writeLifecycleTrust(f.dir, key, undefined, trust()); const path = lifecycleTrustPath(f.dir, key);
 for (const raw of ["{broken", JSON.stringify({ ...trust(), version: 2 }), JSON.stringify({ ...trust(), repo: "other/app" }), JSON.stringify({ ...trust(), accepted: { ...trust().accepted, blockHash: "a".repeat(64) } }), " ".repeat(8 * 1024 * 1024 + 1)]) {
  await writeFile(path, raw);
  assert.equal((await readLifecycleTrust(f.dir, key)).kind, "invalid");
  await assert.rejects(writeLifecycleTrust(f.dir, key, undefined, trust()));
  assert.equal(await readFile(path, "utf8"), raw);
 }
});

for (const unsafe of ["file", "directory", "lock", "hardlink"] as const) test(`trust rechaza ${unsafe} sin tocar el destino ni robar locks`, async t => {
 const f = await fixture(t); const outside = join(f.root, "outside"); await writeFile(outside, "untouched");
 await mkdir(f.dir, { recursive: true }); const path = lifecycleTrustPath(f.dir, key);
 if (unsafe === "directory") { await rm(f.dir, { recursive: true }); await symlink(f.root, f.dir); }
 else if (unsafe === "hardlink") await link(outside, path);
 else await symlink(outside, unsafe === "lock" ? `${path}.lock` : path);
 await assert.rejects(writeLifecycleTrust(f.dir, key, undefined, trust()));
 assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("KB caída/sin acceso/identidad equivocada no son ausencia; sólo consulta sin writes", async t => {
 const f = await fixture(t);
 assert.equal((await readLifecycle(f.kb, key, f.root, signal())).kind, "missing");
 f.kb.available = "offline";
 assert.equal((await readLifecycle(f.kb, key, f.root, signal())).kind, "unavailable");
 f.kb.available = true; f.kb.access = [];
 assert.equal((await readLifecycle(f.kb, key, f.root, signal())).kind, "unavailable");
 f.kb.access = ["app"];
 assert.equal((await readLifecycle(f.kb, { ...key, kbUrl: "https://other.test" }, f.root, signal())).kind, "unavailable");
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 0);
 assert.deepEqual(await readdir(f.root), []);
});

test("config inválida o revisión pendiente bloquean efectos sin perder pin/observación", async t => {
 const f = await fixture(t); f.kb.perillas("app", renderLifecycleBlock(block()));
 await writeLifecycleTrust(f.dir, key, undefined, trust()); const local = await readLifecycleTrust(f.dir, key);
 const reading = await readLifecycle(f.kb, key, f.root, signal());
 assert.equal(evaluateLifecycle(reading, local).canStartEffects, true);
 assert.equal(evaluateLifecycle(reading, { kind: "missing" }).status, "pending");
 f.kb.perillas("app", renderLifecycleBlock({ ...block(), corrections: { mode: "auto", maxRounds: 2 } }));
 assert.equal(evaluateLifecycle(await readLifecycle(f.kb, key, f.root, signal()), local).canStartEffects, false);
 f.kb.perillas("app", "```omi-development-lifecycle\n{broken}\n```");
 const invalid = evaluateLifecycle(await readLifecycle(f.kb, key, f.root, signal()), local);
 assert.equal(invalid.status, "invalid"); assert.equal(invalid.canStartEffects, false); assert.ok(invalid.observationPin);
 f.kb.available = "offline";
 const unavailable = evaluateLifecycle(await readLifecycle(f.kb, key, f.root, signal()), local);
 assert.equal(unavailable.canStartEffects, false); assert.ok(unavailable.observationPin);
 assert.deepEqual(await accepted(f.dir), trust());
});

test("aceptar requiere confirmación explícita y revisión vigente después de esperar", async t => {
 const f = await fixture(t); f.kb.perillas("app", renderLifecycleBlock(block()));
 for (const confirm of [undefined, async () => false]) {
  const pin = await acceptLifecycle(f.kb, key, f.root, { ...f.deps, ...(confirm ? { confirm } : {}) });
  assert.equal(pin, null); assert.equal((await readLifecycleTrust(f.dir, key)).kind, "missing");
 }
 await assert.rejects(acceptLifecycle(f.kb, key, f.root, { ...f.deps, confirm: async () => { f.kb.perillas("app", renderLifecycleBlock({ ...block(), review: { ...block().review, mode: "auto" } })); return true; } }), /cambi/);
 assert.equal((await readLifecycleTrust(f.dir, key)).kind, "missing");
 const pin = await acceptLifecycle(f.kb, key, f.root, { ...f.deps, confirm: async diff => { assert.match(diff, /1200/); return true; } });
 assert.ok(pin); assert.equal(pin.block.review.mode, "auto");
 const before = await readFile(lifecycleTrustPath(f.dir, key), "utf8");
 f.kb.perillas("app", "Texto ajeno\n" + renderLifecycleBlock(pin.block));
 evaluateLifecycle(await readLifecycle(f.kb, key, f.root, signal()), await readLifecycleTrust(f.dir, key));
 assert.equal(await readFile(lifecycleTrustPath(f.dir, key), "utf8"), before, "mismo hash/check no actualiza docId ni trust");
});

test("diff humano incluye defaults/destinos/evidence/auto y escapa controles externos", () => {
 const next = block(); next.review.mode = "auto";
 const diff = lifecycleDiff(undefined, next, { ...key, product: "app\u001b[31m" });
 for (const text of ["1200", "7200", "12", "unconfigured", "auto", "maxRounds", "targets", "base"]) assert.ok(diff.includes(text));
 assert.ok(diff.includes("\\u001b")); assert.ok(!diff.includes("\u001b"));
});

test("guardar crea revisión preservando bytes ajenos, confirma y acepta durablemente", async t => {
 const f = await fixture(t); const foreign = "Texto\r\n```omi-foundations\n{\"keep\":true}\n```\n"; f.kb.perillas("app", foreign);
 const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 assert.ok(prepared.body.startsWith(foreign));
 const pin = await commitLifecycleSave(f.kb, key, block(), prepared, f.deps);
 assert.equal(pin.blockHash, lifecycleHash(block())); assert.deepEqual((await accepted(f.dir)).accepted, pin);
 assert.ok(f.kb.documents.at(-1)?.cuerpo.startsWith(foreign));
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
});

test("guardado con respuesta perdida reconcilia por contenido, nunca repite mutación", async t => {
 const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 f.kb.hook = tool => tool === "guardar" ? "drop" : undefined;
 const pin = await commitLifecycleSave(f.kb, key, block(), prepared, f.deps);
 assert.equal(pin.blockHash, lifecycleHash(block()));
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1); assert.equal(f.kb.documents.length, 1);
});

test("conflicto en perillas o expectativa de hash aborta antes del guardado", async t => {
 const f = await fixture(t); f.kb.perillas("app", renderLifecycleBlock(block()));
 await assert.rejects(prepareLifecycleSave(f.kb, key, block(), signal(), null), /cambi/);
 const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), lifecycleHash(block()));
 f.kb.perillas("app", "Otro bloque humano\n" + renderLifecycleBlock(block()));
 await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, f.deps), /cambi/);
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 0);
 assert.equal((await readLifecycleTrust(f.dir, key)).kind, "missing");
});

test("KB guardada pero revisión posterior/aceptación fallida no anuncian permiso", async t => {
 for (const failure of ["latest", "local", "unknown"] as const) {
  const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
  let checkpoints = 0;
  const beforeAccept = async () => { if (++checkpoints === 2 && failure === "local") await writeLifecycleTrust(f.dir, key, undefined, { ...trust(), accepted: null }); };
  f.kb.hook = tool => { if (tool === "guardar") {
   if (failure === "unknown") return "error";
   if (failure === "latest") queueMicrotask(() => f.kb.perillas("app", "Cambio simultáneo"));
  } };
  await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, { ...f.deps, beforeAccept }), /confirm|acepta|revisión|inciert/);
  const local = await readLifecycleTrust(f.dir, key); assert.ok(local.kind === "missing" || local.kind === "valid" && local.record.accepted === null);
  assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
 }
});

test("cancelar después del envío informa resultado parcial sin aceptar ni repetir", async t => {
 const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 const abort = new AbortController(); f.kb.hook = tool => { if (tool === "guardar") abort.abort(); };
 await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, { ...f.deps, signal: abort.signal }), /confirm|guardad|inciert/);
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
 assert.equal((await readLifecycleTrust(f.dir, key)).kind, "missing");
});

test("fallo posterior a rename no asegura falsamente que la aceptación local no existe", async t => {
 const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 const writeAcceptance: typeof writeLifecycleTrust = async (...args) => { await writeLifecycleTrust(...args); throw new Error("fsync posterior simulado"); };
 await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, { ...f.deps, writeAcceptance }), /pudo.*persist|pudo.*quedar/);
 assert.equal((await accepted(f.dir)).accepted?.blockHash, lifecycleHash(block()), "conservar la aceptación que alcanzó a escribirse");
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
});

test("cambio local durante checkpoint impide enviar la mutación KB", async t => {
 const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 const beforeAccept = async () => { await writeLifecycleTrust(f.dir, key, undefined, { ...trust(), accepted: null }); };
 await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, { ...f.deps, beforeAccept }), /cambi/);
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 0);
});

test("cambio KB durante checkpoint final no acepta snapshot obsoleto", async t => {
 const f = await fixture(t); const prepared = await prepareLifecycleSave(f.kb, key, block(), signal(), null);
 let checkpoints = 0;
 const beforeAccept = async () => { if (++checkpoints === 2) f.kb.perillas("app", renderLifecycleBlock({ ...block(), land: { ...block().land, mode: "auto" } })); };
 await assert.rejects(commitLifecycleSave(f.kb, key, block(), prepared, { ...f.deps, beforeAccept }), /acepta|revisión/);
 assert.equal((await readLifecycleTrust(f.dir, key)).kind, "missing");
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
});
