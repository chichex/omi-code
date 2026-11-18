// Foundations por sesión: se lee al arrancar, se acepta una vez por revisión y queda fijo toda la sesión.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { foundationsHash, renderFoundationsBlock, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, trustPath } from "../src/harness/foundations-trust.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { decideFoundations, parseRepoIdentity, readFoundations, type FoundationsReading } from "../src/tui/development-foundations.ts";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
import { processRunner } from "../src/core/exec.ts";

const ACCEPT = "Aceptar Foundations";
const REPO = "test/repo";
const block = (overrides: Partial<FoundationsBlock> = {}): FoundationsBlock => ({ version: 1, repo: REPO, comandos: ["node test.cjs"], politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" }, ...overrides });
const perillas = (kb: MemoryKb, value: FoundationsBlock | string) => kb.perillas("repo", `# Perillas de repo\n\nTono: formal.\n\n${typeof value === "string" ? value : renderFoundationsBlock(value)}\n`);
const kbWith = (value?: FoundationsBlock | string) => { const kb = memoryKb({ products: ["repo"] }); if (value) perillas(kb, value); return kb; };
const key = (kbUrl: string) => ({ kbUrl, product: "repo", repo: REPO });

test("foundations_session: la identidad del repo sale de origin en github.com", () => {
	for (const url of ["https://github.com/Test/Repo.git", "ssh://git@github.com/test/repo.git", "git@github.com:test/repo", "https://github.com/test/repo/"]) assert.equal(parseRepoIdentity(url), REPO, url);
	for (const url of ["https://gitlab.com/test/repo.git", "https://github.com/test", "file:///tmp/repo", "https://github.com.evil.test/test/repo"]) assert.equal(parseRepoIdentity(url), undefined, url);
});

async function reading(t: import("node:test").TestContext, kb: MemoryKb | undefined, origin = "https://github.com/test/repo.git"): Promise<FoundationsReading> {
	const cwd = await tempDir(t);
	const runner = { run: async (command: string, args: string[]) => command === "git" && args.join(" ") === "remote get-url origin" ? { code: 0, stdout: `${origin}\n`, stderr: "" } : processRunner.run(command, args) };
	return readFoundations(kb, cwd, runner, AbortSignal.timeout(5000));
}
test("foundations_session: leer distingue válido, ausente, inválido, sin KB y sin producto", async (t) => {
	const valid = await reading(t, kbWith(block()));
	assert.equal(valid.kind, "valid"); assert.equal(valid.kind === "valid" && valid.hash, foundationsHash(block()));
	assert.equal((await reading(t, kbWith())).kind, "missing");
	assert.equal((await reading(t, kbWith("Sin Foundations."))).kind, "missing");
	const invalid = await reading(t, kbWith("```omi-foundations\n{ roto\n```"));
	assert.equal(invalid.kind, "invalid");
	const offline = kbWith(block()); offline.available = "sin login";
	assert.equal((await reading(t, offline)).kind, "unavailable");
	assert.equal((await reading(t, undefined)).kind, "unavailable");
	assert.equal((await reading(t, memoryKb({ products: ["otro"] }))).kind, "none", "un producto ausente de mis_productos no tiene Foundations");
	assert.equal((await reading(t, kbWith(block()), "https://gitlab.com/test/repo.git")).kind, "none");
	const other = kbWith(block({ repo: "acme/repo" }));
	assert.equal((await reading(t, other)).kind, "missing", "un bloque de otro repo no aplica");
});

function ctx(answers: boolean[], hasUI = true) {
	const prompts: { title: string; description: string }[] = [];
	return { prompts, ctx: { hasUI } as ExtensionContext, deps: (trustDir: string) => ({ trustDir, now: () => "2026-11-18T03:00:00Z", confirm: async (_ctx: ExtensionContext, title: string, description: string) => { prompts.push({ title, description }); return answers.shift() ?? false; } }) };
}
test("foundations_session: una revisión nueva muestra la diferencia, pide un sí y queda aceptada para el próximo proceso", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	const read = await reading(t, kb);
	const first = ctx([true]);
	const pin = await decideFoundations(read, first.ctx, first.deps(dir));
	assert.deepEqual(first.prompts.map((p) => p.title), [ACCEPT]);
	assert.match(first.prompts[0]!.description, /^ {2}\+ node test\.cjs$/m);
	assert.match(first.prompts[0]!.description, /política estricta/);
	assert.equal(pin.origin, "kb"); assert.deepEqual(pin.block, block());
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()));
	const again = ctx([]);
	assert.equal((await decideFoundations(await reading(t, kb), again.ctx, again.deps(dir))).origin, "kb");
	assert.equal(again.prompts.length, 0, "proceso nuevo con el mismo hash: sin diálogo");
});

test("foundations_session: rechazar deja la última aceptada, o la estricta si no hay", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	const strict = ctx([false]);
	const none = await decideFoundations(await reading(t, kb), strict.ctx, strict.deps(dir));
	assert.equal(none.origin, "strict"); assert.equal(none.block, null);
	assert.equal(await readTrust(dir, key(kb.url)), undefined, "un no no registra nada");
	await decideFoundations(await reading(t, kb), ctx([true]).ctx, ctx([true]).deps(dir));
	const newer = block({ comandos: ["node test.cjs", "node other-test.cjs"], politica: { ...block().politica, fuera_de_catalogo: "auto" } });
	perillas(kb, newer);
	const reject = ctx([false]);
	const pin = await decideFoundations(await reading(t, kb), reject.ctx, reject.deps(dir));
	assert.match(reject.prompts[0]!.description, /^ {2}\+ node other-test\.cjs$/m);
	assert.match(reject.prompts[0]!.description, /corre cualquier comando sin preguntar/);
	assert.equal(pin.origin, "local"); assert.deepEqual(pin.block, block());
	assert.match(pin.notice, /rechaz/i);
});

test("foundations_session: inválido, ausente o sin KB no preguntan y usan la aceptada local, con aviso", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	const cases: [string, MemoryKb][] = [["inválido", kbWith("```omi-foundations\n{ roto\n```")], ["sin bloque", kbWith()]];
	const offline = kbWith(block()); offline.available = "sin login"; cases.push(["sin KB", offline]);
	for (const [name, other] of cases) {
		const empty = ctx([]);
		const strict = await decideFoundations(await reading(t, other), empty.ctx, empty.deps(dir));
		assert.equal(strict.origin, "strict", name); assert.equal(empty.prompts.length, 0, name); assert.ok(strict.notice, name);
	}
	await decideFoundations(await reading(t, kb), ctx([true]).ctx, ctx([true]).deps(dir));
	for (const [name, other] of cases) {
		const empty = ctx([]);
		const local = await decideFoundations(await reading(t, other), empty.ctx, empty.deps(dir));
		assert.equal(local.origin, "local", name); assert.deepEqual(local.block, block(), name); assert.equal(empty.prompts.length, 0, name);
	}
	const invalid = await decideFoundations(await reading(t, Object.assign(kbWith("```omi-foundations\n{ roto\n```"), { url: kb.url })), ctx([]).ctx, ctx([]).deps(dir));
	assert.match(invalid.notice, /inválid/);
});

test("foundations_session: sin UI una revisión nueva no se acepta", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const headless = ctx([true], false);
	const pin = await decideFoundations(await reading(t, kbWith(block())), headless.ctx, headless.deps(dir));
	assert.equal(pin.origin, "strict"); assert.equal(headless.prompts.length, 0);
});

test("foundations_session: el mismo hash en otro documento se adopta sin preguntar", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	await decideFoundations(await reading(t, kb), ctx([true]).ctx, ctx([true]).deps(dir));
	const edited = perillas(kb, `Otra perilla cambiada.\n\n${renderFoundationsBlock(block())}`);
	const quiet = ctx([]);
	assert.equal((await decideFoundations(await reading(t, kb), quiet.ctx, quiet.deps(dir))).docId, edited.id);
	assert.equal(quiet.prompts.length, 0);
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.docId, edited.id);
});

test("foundations_session: un registro local corrupto no se reescribe sin un sí", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(trustPath(dir, key(kb.url)), "{ roto", { mode: 0o600 });
	const offline = kbWith(block()); offline.available = "sin login";
	assert.equal((await decideFoundations(await reading(t, offline), ctx([]).ctx, ctx([]).deps(dir))).origin, "strict");
	const reject = ctx([false]);
	assert.equal((await decideFoundations(await reading(t, kb), reject.ctx, reject.deps(dir))).origin, "strict");
	assert.equal(await readFile(trustPath(dir, key(kb.url)), "utf8"), "{ roto");
	const accept = ctx([true]);
	assert.equal((await decideFoundations(await reading(t, kb), accept.ctx, accept.deps(dir))).origin, "kb");
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()), "con el sí se reemplaza");
});

const fixture = async (t: import("node:test").TestContext, kb: MemoryKb) => developmentFixture(t, { kb });
const reads = (kb: MemoryKb) => kb.calls.filter((c) => c.tool === "mis_productos").length;
const accepts = (prompts: string[]) => prompts.filter((title) => title === ACCEPT).length;
test("foundations_session: un diálogo por revisión nueva, fijo toda la sesión aunque cambie la KB", async (t) => {
	const kb = kbWith(block()); const f = await fixture(t, kb);
	await f.start();
	assert.equal(accepts(f.prompts), 1);
	assert.ok(f.prompts.indexOf(ACCEPT) < f.prompts.indexOf("Empezar el trabajo del issue #42"), "se acepta antes del sí del arranque");
	perillas(kb, block({ comandos: ["node test.cjs", "node -e 1"] }));
	await f.command("resume"); await f.command("status");
	assert.equal(accepts(f.prompts), 1);
	const status = f.messages.at(-1)!;
	assert.match(status, /Foundations: KB · revisión [0-9a-f]{8}/);
	assert.match(status, new RegExp(foundationsHash(block()).slice(0, 8)), "la sesión sigue con la revisión que leyó al arrancar");
	assert.match(status, /arranque ask · receta ask · fuera del catálogo ask · push \+ PR draft ask/);
	assert.match(status, /Catálogo: node test\.cjs/);
	const detail = (f.progress.at(-1) as { progress?: { details: string[] } }).progress?.details ?? [];
	assert.ok(detail.some((line) => /^Foundations: KB · revisión/.test(line)), "el detalle del progreso muestra Foundations");
});

test("foundations_session: recargar la extensión no relee ni vuelve a preguntar", async (t) => {
	const kb = kbWith(block()); const f = await fixture(t, kb);
	await f.start();
	await f.attach(); await f.command("resume");
	assert.equal(accepts(f.prompts), 1);
	assert.equal(reads(kb), 1, "/reload no vuelve a leer la KB");
});

test("foundations_session: sin KB y sin aceptada todo sigue como hoy", async (t) => {
	const kb = kbWith(block()); kb.available = "sin login"; const f = await fixture(t, kb);
	await f.start(); await f.command("status");
	assert.equal(accepts(f.prompts), 0);
	assert.match(f.messages.at(-1)!, /Foundations: estricta/);
});

test("foundations_session: omi_work_begin lleva la revisión a la sesión del worktree sin otro diálogo", async (t) => {
	const kb = kbWith(block()); const f = await beginFixture(t, { kb });
	await f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(f.prompts.map((p) => p.title), [ACCEPT, "Crear issue y empezar el trabajo"]);
	assert.notEqual(f.current().manager.getSessionFile(), f.main.getSessionFile(), "cambió a la sesión del worktree");
	await f.command("status");
	assert.match(f.current().notices.at(-1)!, /Foundations: KB · revisión/);
	assert.equal(reads(kb), 1, "la sesión del worktree no relee la KB");
});
