// Cola de cortesía de checks pesados entre worktrees del mismo repo, con archivos reales en un repo temporal.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checkTurnPath, sameHolder, takeCheckTurn, type CheckTurn } from "../src/harness/check-queue.ts";

const FAST = { pollMs: 10, limitMs: 60_000 };
const CONTROL = /\p{Cc}/u;
async function repo(t: TestContext) {
 const dir = await realpath(await mkdtemp(join(tmpdir(), "omi-check-turn-")));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const commonDir = join(dir, "repo", ".git"); await mkdir(commonDir, { recursive: true });
 const checkout = (name: string) => ({ root: join(dir, name), commonDir, branch: name, baseCommit: "a".repeat(40) });
 return { dir, commonDir, omi: join(commonDir, "omi"), lock: join(commonDir, "omi", "check-turn.lock"), a: checkout("issue-98"), b: checkout("issue-99") };
}
const owner = async (path: string) => JSON.parse(await readFile(path, "utf8")) as { pid: number; hostname: string; root: string; kind: string; command: string };
async function until(condition: () => boolean, label: string): Promise<void> {
 for (let i = 0; i < 500 && !condition(); i++) await sleep(5);
 assert.ok(condition(), label);
}
const settled = (promise: Promise<unknown>) => { const state = { done: false }; promise.then(() => { state.done = true; }, () => { state.done = true; }); return state; };

test("check_queue un segundo check del mismo repo espera el turno, dice a quién espera y corre al liberarse", async (t) => {
 const f = await repo(t);
 assert.equal(checkTurnPath(f.a), f.lock, "el turno es del repo: lo comparten sus worktrees");
 assert.equal(checkTurnPath(f.b), f.lock);
 const first = await takeCheckTurn(f.a, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 assert.equal(first.notice, undefined, "sin espera no hay nada que avisar");
 assert.equal((await lstat(f.lock)).mode & 0o777, 0o600);
 assert.deepEqual(await owner(f.lock), { pid: process.pid, hostname: hostname(), root: f.a.root, kind: "gate", command: "npm test" });
 const owners: string[] = [];
 const pending = takeCheckTurn(f.b, { kind: "setup", command: "npm run test:packaging" }, new AbortController().signal, FAST, (text) => owners.push(text));
 const progress = settled(pending);
 await until(() => owners.length >= 3, "quien espera informa a quién espera");
 assert.equal(progress.done, false, "mientras el turno está tomado, no corre");
 assert.deepEqual([...new Set(owners)], ["npm test en issue-98"]);
 await first.release();
 const second = await pending;
 assert.equal(second.notice, "Esperó menos de 1 min el turno de checks del repo: lo tenía npm test en issue-98.");
 assert.ok(second.waitedMs > 0);
 assert.deepEqual(await owner(f.lock), { pid: process.pid, hostname: hostname(), root: f.b.root, kind: "setup", command: "npm run test:packaging" });
 await second.release();
 assert.deepEqual(await readdir(f.omi), [], "liberar borra el turno");
});

test("check_queue el turno de un proceso que ya no existe se retira, lo avisa y queda a nombre del nuevo dueño", async (t) => {
 const f = await repo(t);
 await mkdir(f.omi, { mode: 0o700 });
 await writeFile(f.lock, JSON.stringify({ pid: 2147483646, hostname: hostname(), root: f.a.root, kind: "gate", command: "npm test" }), { mode: 0o600 });
 const owners: string[] = [];
 const turn = await takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST, (text) => owners.push(text));
 assert.equal(turn.notice, "Se retiró el turno de checks del repo que tenía npm test en issue-98: su proceso ya no existe.");
 assert.deepEqual(owners, [], "un dueño muerto no se espera");
 assert.equal((await owner(f.lock)).pid, process.pid);
 assert.equal((await owner(f.lock)).root, f.b.root);
 await turn.release();
 assert.deepEqual(await readdir(f.omi), []);
});

test("check_queue un turno sin liberar pasado el tope se retira y la liberación tardía del dueño viejo no borra el turno nuevo", async (t) => {
 const f = await repo(t);
 const old = await takeCheckTurn(f.a, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 const past = (Date.now() - 2 * FAST.limitMs) / 1000; await utimes(f.lock, past, past);
 const turn = await takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 assert.equal(turn.notice, "Se retiró el turno de checks del repo que tenía npm test en issue-98: llevaba 1 min o más sin liberarse.");
 assert.equal((await owner(f.lock)).root, f.b.root, "el turno queda a nombre del nuevo dueño");
 await old.release();
 assert.equal((await owner(f.lock)).root, f.b.root, "la liberación tardía del dueño viejo no toca el turno nuevo");
 await turn.release();
 assert.deepEqual(await readdir(f.omi), []);
});

test("check_queue con el turno siempre ocupado, a los 15 min de espera corre igual sin tocar el turno ajeno", async (t) => {
 const f = await repo(t);
 const held = await takeCheckTurn(f.a, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 const before = await lstat(f.lock);
 // El dueño sigue vivo y su turno siempre parece nuevo: nunca se retira por edad.
 const fresh = setInterval(() => { const now = Date.now() / 1000; utimes(f.lock, now, now).catch(() => {}); }, 20);
 t.after(() => clearInterval(fresh));
 const limit = { pollMs: 10, limitMs: 200 };
 const turn = await takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, new AbortController().signal, limit);
 clearInterval(fresh);
 assert.equal(turn.notice, "Esperó menos de 1 min el turno de checks del repo y corre igual: lo sigue teniendo npm test en issue-98.");
 assert.ok(turn.waitedMs >= limit.limitMs, `esperó todo el tope: ${turn.waitedMs} ms`);
 const after = await lstat(f.lock);
 assert.equal(after.ino, before.ino, "el turno ajeno sigue siendo el mismo archivo");
 assert.equal((await owner(f.lock)).root, f.a.root);
 await turn.release();
 assert.equal((await owner(f.lock)).root, f.a.root, "quien corrió sin turno no libera el ajeno");
 await held.release();
 assert.deepEqual(await readdir(f.omi), []);
});

test("check_queue cancelar mientras espera rechaza con AbortError, no cuelga y no deja archivos", async (t) => {
 const f = await repo(t);
 const aborted = new AbortController(); aborted.abort();
 await assert.rejects(takeCheckTurn(f.a, { kind: "gate", command: "npm test" }, aborted.signal, FAST), { name: "AbortError" });
 assert.deepEqual(await readdir(f.commonDir), [], "cancelado antes de empezar no crea nada");
 const held = await takeCheckTurn(f.a, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 const controller = new AbortController(); const owners: string[] = [];
 const pending = takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, controller.signal, { pollMs: 60_000, limitMs: 15 * 60_000 }, (text) => owners.push(text));
 await until(() => owners.length > 0, "está esperando");
 const started = Date.now(); controller.abort();
 await assert.rejects(pending, { name: "AbortError" });
 assert.ok(Date.now() - started < 1000, "cancelar corta la espera aunque falte para el próximo intento");
 assert.deepEqual(await readdir(f.omi), ["check-turn.lock"], "quien espera nunca crea archivos");
 assert.equal((await owner(f.lock)).root, f.a.root);
 await held.release();
 assert.deepEqual(await readdir(f.omi), []);
});

test("check_queue no sigue symlinks: un turno o un directorio omi enlazado corre sin cola, avisa y no toca el destino", async (t) => {
 for (const variant of ["turno enlazado", "turno con otro enlace duro", "directorio omi enlazado"] as const) {
  const f = await repo(t);
  const outside = join(f.dir, "outside"); await mkdir(outside);
  const target = join(outside, "target"); await writeFile(target, "untouched");
  if (variant === "directorio omi enlazado") await symlink(outside, f.omi);
  else { await mkdir(f.omi, { mode: 0o700 }); await (variant === "turno enlazado" ? symlink(target, f.lock) : link(target, f.lock)); }
  const owners: string[] = [];
  const turn: CheckTurn = await takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST, (text) => owners.push(text));
  assert.match(turn.notice ?? "", /corre sin turno/, variant);
  assert.deepEqual(owners, [], `${variant}: no espera`);
  await turn.release();
  assert.equal(await readFile(target, "utf8"), "untouched", `${variant}: no toca el destino`);
  assert.deepEqual((await readdir(outside)).sort(), ["target"], `${variant}: no crea nada en el destino`);
  if (variant === "turno enlazado") assert.ok((await lstat(f.lock)).isSymbolicLink(), "el enlace queda como estaba");
 }
});

test("check_queue datos ajenos del turno: un PID inválido no se juzga ni se usa para un kill y el texto mostrado sale sin caracteres de control", async (t) => {
 const dirty = { hostname: hostname(), root: "/otro/issue-\u001b[31m98\u0007", kind: "gate", command: "npm\u0000 test\n\u001b]0;pwn\u0007 --x" };
 const holders: unknown[] = [-1, 0, 1, 1.5, "123", 2 ** 53, null].map((pid) => ({ ...dirty, pid }));
 holders.push({ pid: 4242, hostname: "otra-maquina", root: "/otro/issue-98", kind: "gate", command: "npm test" }, "no es JSON {");
 for (const holder of holders) {
  const f = await repo(t);
  await mkdir(f.omi, { mode: 0o700 });
  const raw = typeof holder === "string" ? holder : JSON.stringify(holder); await writeFile(f.lock, raw, { mode: 0o600 });
  const judged: number[] = []; const owners: string[] = []; const controller = new AbortController();
  // Si lo juzgara muerto (alive da false), lo retiraría y no esperaría.
  const pending = takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, controller.signal, { ...FAST, alive: (pid) => { judged.push(pid); return false; } }, (text) => owners.push(text));
  await until(() => owners.length >= 2, `espera un dueño que no puede juzgar: ${raw}`);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(judged, [], `no se juzga ni se usa para un kill: ${raw}`);
  for (const text of owners) assert.ok(!CONTROL.test(text), `sin caracteres de control: ${JSON.stringify(text)}`);
  assert.equal(await readFile(f.lock, "utf8"), raw, "el turno ajeno queda intacto");
 }
 const f = await repo(t); await mkdir(f.omi, { mode: 0o700 });
 await writeFile(f.lock, JSON.stringify({ ...dirty, pid: -1 }), { mode: 0o600 });
 const past = (Date.now() - 2 * FAST.limitMs) / 1000; await utimes(f.lock, past, past);
 const turn = await takeCheckTurn(f.b, { kind: "gate", command: "npm test" }, new AbortController().signal, FAST);
 assert.equal(turn.notice, "Se retiró el turno de checks del repo que tenía npm test ]0;pwn --x en issue- [31m98: llevaba 1 min o más sin liberarse.", "el texto se limpia pero sigue diciendo de quién era");
 await turn.release();
});

// Review de Sonnet en #100 (check-queue.ts:84): retire comparaba sólo dev e ino, y el inodo se reusa enseguida (ext4, tmpfs).
// Con tres procesos, el segundo que retiraba un turno muerto podía borrar el turno vivo que el primero acababa de crear.
test("check_queue retira sólo el archivo que leyó: un turno nuevo con el mismo inodo pero otro mtime no se toca", () => {
 const read = { dev: 1, ino: 8059486, mtimeMs: 1000.25 };
 assert.equal(sameHolder({ dev: 1, ino: 8059486, mtimeMs: 1000.25 }, read), true, "el mismo archivo");
 assert.equal(sameHolder({ dev: 1, ino: 8059486, mtimeMs: 1003.5 }, read), false, "inodo reusado por un turno nuevo");
 assert.equal(sameHolder({ dev: 2, ino: 8059486, mtimeMs: 1000.25 }, read), false);
 assert.equal(sameHolder({ dev: 1, ino: 1, mtimeMs: 1000.25 }, read), false);
});
