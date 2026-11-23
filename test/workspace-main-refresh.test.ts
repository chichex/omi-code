// Antes de crear el worktree de un issue, OMI trae main de origin y la avanza sólo si es fast-forward.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit, type GithubItem } from "../src/tui/workspace/data.ts";
import { prepareIssue } from "../src/tui/workspace/issue-preparation.ts";
import { refreshMain } from "../src/tui/workspace/issue-worktree.ts";
import { tempDir } from "./helpers/io.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
async function commit(cwd: string, file: string, body: string): Promise<string> {
	await writeFile(join(cwd, file), body); run(cwd, "add", file); run(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `cambiar ${file}`);
	return run(cwd, "rev-parse", "HEAD");
}
/** repo con main publicada en un origin local, y otro clon que ya empujó un commit más. */
async function behind(t: TestContext) {
	const home = await tempDir(t); const root = join(home, "repo"); const remote = join(home, "origin.git"); const peer = join(home, "peer");
	await mkdir(root);
	run(root, "init", "-q", "-b", "main"); run(root, "config", "user.email", "test@example.test"); run(root, "config", "user.name", "Test");
	const old = await commit(root, "file.txt", "viejo\n");
	run(home, "init", "-q", "--bare", remote); run(root, "remote", "add", "origin", remote); run(root, "push", "-q", "origin", "main");
	run(home, "clone", "-q", "--branch", "main", remote, peer); run(peer, "config", "user.email", "test@example.test"); run(peer, "config", "user.name", "Test");
	const fresh = await commit(peer, "file.txt", "nuevo\n"); run(peer, "push", "-q", "origin", "main");
	return { home, root, remote, old, fresh, main: () => run(root, "rev-parse", "refs/heads/main") };
}

test("refresh_main con main en el checkout y atrás de origin hace un pull fast-forward y conserva cambios ajenos", async (t) => {
	const r = await behind(t);
	await writeFile(join(r.root, "notas.txt"), "sin commitear\n");
	assert.equal(await refreshMain({ root: r.root }), "");
	assert.equal(r.main(), r.fresh); assert.equal(await readFile(join(r.root, "file.txt"), "utf8"), "nuevo\n");
	assert.equal(await readFile(join(r.root, "notas.txt"), "utf8"), "sin commitear\n");
});

test("refresh_main con main sin checkout avanza la rama sin tocar la rama actual", async (t) => {
	const r = await behind(t);
	run(r.root, "switch", "-q", "-c", "otra");
	assert.equal(await refreshMain({ root: r.root }), "");
	assert.equal(r.main(), r.fresh); assert.equal(run(r.root, "rev-parse", "--abbrev-ref", "HEAD"), "otra");
	assert.equal(await readFile(join(r.root, "file.txt"), "utf8"), "viejo\n");
});

test("refresh_main no pisa cambios sin commitear ni commits propios: avisa y main queda igual", async (t) => {
	const dirty = await behind(t);
	await writeFile(join(dirty.root, "file.txt"), "a mano\n");
	assert.match(await refreshMain({ root: dirty.root }), /No se pudo actualizar main en .*: el worktree sale de main local/);
	assert.equal(dirty.main(), dirty.old); assert.equal(await readFile(join(dirty.root, "file.txt"), "utf8"), "a mano\n");
	const ahead = await behind(t);
	const own = await commit(ahead.root, "propio.txt", "local\n");
	assert.match(await refreshMain({ root: ahead.root }), /main local tiene commits que no están en origin/);
	assert.equal(ahead.main(), own);
});

test("refresh_main sin origin no hace nada, y con origin inaccesible avisa y sigue con main local", async (t) => {
	const r = await behind(t);
	run(r.root, "remote", "set-url", "origin", join(r.home, "no-existe.git"));
	assert.match(await refreshMain({ root: r.root }), /No se pudo traer main de origin: el worktree sale de main local/);
	assert.equal(r.main(), r.old);
	run(r.root, "remote", "remove", "origin");
	assert.equal(await refreshMain({ root: r.root }), ""); assert.equal(r.main(), r.old);
});

test("refresh_main un issue nuevo sale de main actualizada; el aviso llega a la persona", async (t) => {
	const r = await behind(t); const notices: string[] = [];
	const issue: GithubItem = { number: 42, title: "Arreglar filtro", url: "https://github.com/test/repo/issues/42", labels: [], author: "", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const triage = { type: "fix" as const, summary: "Corregir", rationale: "Roto", scope: ["filtro"], acceptanceCriteria: ["anda"], questions: [] };
	const classification = { triage, body: "Issue", provider: "mock", model: "triage", usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
	const ctx = { cwd: r.root, sessionManager: SessionManager.create(r.root, join(r.home, "parent")), ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
	const options = { sessionDir: join(r.home, "sessions"), signal: new AbortController().signal, isCurrent: () => true, classify: async () => classification };
	const prepared = (await prepareIssue((await readGit(r.root))!, 42, issue, ctx, options))!;
	assert.equal(prepared.record.state.baseCommit, r.fresh);
	assert.equal(run(prepared.record.state.worktree, "rev-parse", "HEAD"), r.fresh);
	assert.deepEqual(notices, []);
	// Con main sucia en el checkout, el issue sale de main local y la persona ve por qué.
	const dirty = await behind(t); await writeFile(join(dirty.root, "file.txt"), "a mano\n");
	const other = { ...ctx, cwd: dirty.root, sessionManager: SessionManager.create(dirty.root, join(dirty.home, "parent")) } as unknown as ExtensionContext;
	const local = (await prepareIssue((await readGit(dirty.root))!, 42, issue, other, { ...options, sessionDir: join(dirty.home, "sessions") }))!;
	assert.equal(local.record.state.baseCommit, dirty.old);
	assert.equal(notices.length, 1); assert.match(notices[0]!, /No se pudo actualizar main/);
});
