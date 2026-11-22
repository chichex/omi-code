// Foundations por sesión: se lee al arrancar, una revisión válida se acepta sola y queda fija toda la sesión.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLICY, foundationsHash, renderFoundationsBlock, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, trustPath } from "../src/harness/foundations-trust.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { decideFoundations, effectivePolicy, parseRepoIdentity, readFoundations, type FoundationsReading } from "../src/tui/development-foundations.ts";
import { developmentFixture } from "./helpers/development.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
import { processRunner } from "../src/core/exec.ts";

const ACCEPT = "Aceptar Foundations";
const REPO = "test/repo";
const block = (overrides: Partial<FoundationsBlock> = {}): FoundationsBlock => ({ version: 2, repo: REPO, confirmar: ["node test.cjs"], politica: { arranque: "ask", receta: "ask", push_pr: "ask" }, ...overrides });
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

function ctx(hasUI = true) {
	const notices: { message: string; level: string | undefined }[] = [];
	return { notices, ctx: { hasUI, ui: { notify: (message: string, level?: string) => { notices.push({ message, level }); } } } as unknown as ExtensionContext, deps: (trustDir: string) => ({ trustDir, now: () => "2026-11-18T03:00:00Z" }) };
}
const APPLIED = /Foundations: se aplica la revisión nueva de la KB, sin preguntar/;
test("foundations_session: una revisión nueva se acepta sola, avisa la diferencia y queda aceptada para el próximo proceso", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	const first = ctx();
	const pin = await decideFoundations(await reading(t, kb), first.ctx, first.deps(dir));
	assert.equal(first.notices.length, 1, "un aviso, ningún diálogo"); assert.equal(first.notices[0]!.level, "info");
	const notice = first.notices[0]!.message;
	assert.match(notice, APPLIED); assert.match(notice, /^ {2}\+ node test\.cjs$/m);
	assert.match(notice, /Antes: sin Foundations \(por defecto: todo auto\)/);
	assert.match(notice, /arranque: auto → ask/, "la diferencia parte del default");
	assert.equal(pin.origin, "kb"); assert.deepEqual(pin.block, block());
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()));
	const again = ctx();
	assert.equal((await decideFoundations(await reading(t, kb), again.ctx, again.deps(dir))).origin, "kb");
	assert.equal(again.notices.length, 0, "proceso nuevo con el mismo hash: sin aviso");
});

test("foundations_session: una revisión nueva reemplaza la aceptada sin preguntar, también si sólo quita permisos", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	await decideFoundations(await reading(t, kb), ctx().ctx, ctx().deps(dir));
	const newer = block({ confirmar: ["node test.cjs", "node other-test.cjs"], politica: { ...block().politica, receta: "auto" } });
	perillas(kb, newer);
	const wider = ctx();
	const pin = await decideFoundations(await reading(t, kb), wider.ctx, wider.deps(dir));
	assert.match(wider.notices[0]!.message, /^ {2}\+ node other-test\.cjs$/m);
	assert.match(wider.notices[0]!.message, /receta: ask → auto .*aprueba su propia receta/, "el aviso marca cada auto");
	assert.equal(pin.origin, "kb"); assert.deepEqual(pin.block, newer);
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(newer));
	perillas(kb, block());
	const narrower = ctx();
	assert.deepEqual((await decideFoundations(await reading(t, kb), narrower.ctx, narrower.deps(dir))).block, block());
	assert.match(narrower.notices[0]!.message, /receta: auto → ask/);
	assert.match(narrower.notices[0]!.message, /^ {2}- node other-test\.cjs$/m);
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()));
});

test("foundations_session: inválido, ausente, v1 o sin KB no avisan y usan la aceptada local; sin ninguna, el default: todo auto", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	const legacy = "```omi-foundations\n" + JSON.stringify({ version: 1, repo: REPO, comandos: ["npm test"], politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" } }) + "\n```";
	const cases: [string, MemoryKb][] = [["inválido", kbWith("```omi-foundations\n{ roto\n```")], ["sin bloque", kbWith()], ["v1", kbWith(legacy)]];
	const offline = kbWith(block()); offline.available = "sin login"; cases.push(["sin KB", offline]);
	for (const [name, other] of cases) {
		const empty = ctx();
		const fallback = await decideFoundations(await reading(t, other), empty.ctx, empty.deps(dir));
		assert.equal(fallback.origin, "default", name); assert.equal(fallback.block, null, name); assert.equal(empty.notices.length, 0, name);
		assert.match(fallback.notice, /todo auto/, name);
		assert.deepEqual(effectivePolicy(fallback), { politica: DEFAULT_POLICY, command: { block: null, accepted: false }, hash: null }, name);
	}
	await decideFoundations(await reading(t, kb), ctx().ctx, ctx().deps(dir));
	for (const [name, other] of cases) {
		const empty = ctx();
		const local = await decideFoundations(await reading(t, other), empty.ctx, empty.deps(dir));
		assert.equal(local.origin, "local", name); assert.deepEqual(local.block, block(), name); assert.equal(empty.notices.length, 0, name);
		assert.equal(effectivePolicy(local).politica.receta, "ask", `${name}: el ask aceptado sigue valiendo`);
	}
	const invalid = await decideFoundations(await reading(t, Object.assign(kbWith("```omi-foundations\n{ roto\n```"), { url: kb.url })), ctx().ctx, ctx().deps(dir));
	assert.match(invalid.notice, /inválid/);
});

test("foundations_session: sin UI una revisión nueva también se acepta", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const headless = ctx(false); const kb = kbWith(block());
	const pin = await decideFoundations(await reading(t, kb), headless.ctx, headless.deps(dir));
	assert.equal(pin.origin, "kb"); assert.deepEqual(pin.block, block());
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()));
});

test("foundations_session: el mismo hash en otro documento se adopta sin avisar", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	await decideFoundations(await reading(t, kb), ctx().ctx, ctx().deps(dir));
	const edited = perillas(kb, `Otra perilla cambiada.\n\n${renderFoundationsBlock(block())}`);
	const quiet = ctx();
	assert.equal((await decideFoundations(await reading(t, kb), quiet.ctx, quiet.deps(dir))).docId, edited.id);
	assert.equal(quiet.notices.length, 0);
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.docId, edited.id);
});

test("foundations_session: un registro local corrupto no cuenta como aceptado y sólo lo reemplaza una revisión válida", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const kb = kbWith(block());
	await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(trustPath(dir, key(kb.url)), "{ roto", { mode: 0o600 });
	const offline = Object.assign(kbWith(block()), { url: kb.url }); offline.available = "sin login";
	assert.equal((await decideFoundations(await reading(t, offline), ctx().ctx, ctx().deps(dir))).origin, "default");
	assert.equal((await decideFoundations(await reading(t, Object.assign(kbWith("```omi-foundations\n{ roto\n```"), { url: kb.url })), ctx().ctx, ctx().deps(dir))).origin, "default");
	assert.equal(await readFile(trustPath(dir, key(kb.url)), "utf8"), "{ roto", "sin una revisión válida no se toca");
	assert.equal((await decideFoundations(await reading(t, kb), ctx().ctx, ctx().deps(dir))).origin, "kb");
	assert.equal((await readTrust(dir, key(kb.url)))?.accepted?.blockHash, foundationsHash(block()), "la revisión válida lo reemplaza");
});

const fixture = async (t: import("node:test").TestContext, kb: MemoryKb) => developmentFixture(t, { kb });
const reads = (kb: MemoryKb) => kb.calls.filter((c) => c.tool === "mis_productos").length;
const applied = (notices: string[]) => notices.filter((message) => APPLIED.test(message)).length;
test("foundations_session: una revisión nueva se acepta sin diálogo y queda fija toda la sesión aunque cambie la KB", async (t) => {
	const kb = kbWith(block()); const f = await fixture(t, kb);
	await f.start();
	assert.equal(applied(f.messages), 1); assert.ok(!f.prompts.includes(ACCEPT), "sin diálogo de aceptación");
	assert.deepEqual(f.prompts, ["Empezar el trabajo del issue #42"], "el arranque ya usa la revisión aceptada: arranque ask");
	perillas(kb, block({ confirmar: ["node test.cjs", "node -e 1"] }));
	await f.command("resume"); await f.command("status");
	assert.equal(applied(f.messages), 1);
	const status = f.messages.at(-1)!;
	assert.match(status, /Foundations: KB · revisión [0-9a-f]{8}/);
	assert.match(status, new RegExp(foundationsHash(block()).slice(0, 8)), "la sesión sigue con la revisión que leyó al arrancar");
	assert.match(status, /arranque: ask\n  receta: ask\n  push \+ PR draft: ask/);
	assert.match(status, /Patrones que requieren confirmación:\n  node test\.cjs/);
	const detail = (f.progress.at(-1) as { progress?: { details: string[] } }).progress?.details ?? [];
	assert.ok(detail.some((line) => /^Foundations: KB · revisión/.test(line)), "el detalle del progreso muestra Foundations");
});

test("foundations_session: recargar la extensión no relee ni vuelve a avisar", async (t) => {
	const kb = kbWith(block()); const f = await fixture(t, kb);
	await f.start();
	await f.attach(); await f.command("resume");
	assert.equal(applied(f.messages), 1);
	assert.equal(reads(kb), 1, "/reload no vuelve a leer la KB");
});

test("foundations_session: sin KB y sin aceptada vale el default: nada pregunta", async (t) => {
	const kb = kbWith(block()); kb.available = "sin login"; const f = await fixture(t, kb);
	await f.start(); await f.command("status");
	assert.deepEqual(f.prompts, []); assert.equal(applied(f.messages), 0);
	const status = f.messages.at(-1)!;
	assert.match(status, /Foundations: por defecto/);
	assert.match(status, /arranque: auto\n  receta: auto\n  push \+ PR draft: auto/);
	assert.match(status, /sin v2 aceptada: nada pregunta/);
	assert.doesNotMatch(status, /estricta|todo pregunta/);
});

test("foundations_session: omi_work_begin lleva la revisión a la sesión del worktree sin otro aviso", async (t) => {
	const kb = kbWith(block()); const f = await beginFixture(t, { kb }); const origin = f.current();
	await f.ask({ title: "Arreglar el valor", body: "Debe dar 2.", reason: "Bug" });
	assert.deepEqual(f.prompts.map((p) => p.title), ["Crear issue y empezar el trabajo"], "arranque ask de la revisión aceptada");
	assert.equal(applied(origin.notices), 1);
	assert.notEqual(f.current().manager.getSessionFile(), f.main.getSessionFile(), "cambió a la sesión del worktree");
	await f.command("status");
	assert.equal(applied(f.current().notices), 0, "la sesión del worktree no vuelve a avisar");
	assert.match(f.current().notices.at(-1)!, /Foundations: KB · revisión/);
	assert.equal(reads(kb), 1, "la sesión del worktree no relee la KB");
});
