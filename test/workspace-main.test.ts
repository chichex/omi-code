import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit } from "../src/tui/workspace/data.ts";
import { preparePrincipalSession, PrincipalSessionBusyError, type PrincipalSessionOptions } from "../src/tui/workspace/main-workspace.ts";
import { readSessionSnapshot } from "../src/tui/workspace/session-files.ts";
import { tempDir } from "./helpers/io.ts";

async function fixture(home: string) {
	const root = join(home, "repo"); const worktree = join(home, "repo-worktrees/issue-42"); const sessionDir = join(home, "sessions"); await mkdir(root, { recursive: true });
	const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const git = (...args: string[]) => gitAt(root, ...args);
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "file.txt"), "main\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main");
	await mkdir(join(home, "repo-worktrees")); git("worktree", "add", "-b", "fix/issue-42", worktree, "main");
	const snapshot = (await readGit(worktree))!;
	const session = (cwd: string, text: string, parentSession?: string, timestamp = Date.now()) => {
		const sm = SessionManager.create(cwd, sessionDir, parentSession ? { parentSession } : {});
		sm.appendMessage({ role: "user", content: text, timestamp }); return sm;
	};
	const context = (sm: SessionManager) => ({ cwd: worktree, sessionManager: sm, model: { provider: "mock", id: "selected" }, thinkingLevel: "high", modelRegistry: { complete: () => { throw new Error("NO LLAMAR MODELO"); } } }) as unknown as ExtensionContext;
	const options: PrincipalSessionOptions = { sessionDir, signal: new AbortController().signal, isCurrent: () => true };
	const fingerprint = (cwd: string) => [gitAt(cwd, "symbolic-ref", "HEAD"), gitAt(cwd, "rev-parse", "HEAD"), gitAt(cwd, "write-tree"), gitAt(cwd, "status", "--porcelain")];
	return { root, worktree, sessionDir, git, gitAt, snapshot, session, context, options, fingerprint };
}

test("workspace_main retoma la conversación de origen, incluso en subcarpeta, sin cambiar ramas, índices ni archivos", async (t) => {
	const f = await fixture(await tempDir(t)); f.git("checkout", "-b", "develop");
	await mkdir(join(f.root, "package")); const original = f.session(join(f.root, "package"), "CONVERSACION_PRINCIPAL");
	f.session(f.root, "Otra sesión más reciente, no elegirla", undefined, Date.now() + 100_000);
	const issue = f.session(f.worktree, "CONTEXTO_ISSUE", original.getSessionFile());
	for (const cwd of [f.root, f.worktree]) { await writeFile(join(cwd, "file.txt"), "stage\n"); f.gitAt(cwd, "add", "file.txt"); await writeFile(join(cwd, "file.txt"), `unstaged ${cwd}\n`); await writeFile(join(cwd, "local.txt"), "untracked\n"); }
	const before = [f.fingerprint(f.root), f.fingerprint(f.worktree)]; const source = await readFile(issue.getSessionFile()!, "utf8"); const main = await readFile(original.getSessionFile()!, "utf8");
	const result = await preparePrincipalSession(f.snapshot, f.context(issue), f.options);
	assert.equal(result.created, false); assert.equal(result.sessionFile, original.getSessionFile()); assert.equal(result.cwd, join(f.root, "package")); assert.equal(result.branch, "develop");
	assert.deepEqual([f.fingerprint(f.root), f.fingerprint(f.worktree)], before); assert.equal(await readFile(issue.getSessionFile()!, "utf8"), source); assert.equal(await readFile(result.sessionFile, "utf8"), main);
	await assert.rejects(access(join(f.root, ".git/omi/main-session.lock")));
});

test("workspace_main sigue padres de otros worktrees, sin elegir esas sesiones ni las de otros repos", async (t) => {
	const f = await fixture(await tempDir(t)); const original = f.session(f.root, "ORIGINAL");
	const other = join(f.root, "..", "another-worktree"); f.git("worktree", "add", "-b", "other", other, "main");
	const middle = f.session(other, "OTRO_WORKTREE", original.getSessionFile()); const current = f.session(f.worktree, "ISSUE", middle.getSessionFile());
	const result = await preparePrincipalSession(f.snapshot, f.context(current), f.options);
	assert.equal(result.sessionFile, original.getSessionFile()); assert.equal(result.created, false);
});

test("workspace_main sin padre persistido elige la sesión más reciente del principal, no un repo anidado ni el issue", async (t) => {
	const f = await fixture(await tempDir(t)); const old = f.session(f.root, "Principal viejo", undefined, Date.now() - 10_000); const recent = f.session(f.root, "Principal reciente");
	const nested = join(f.root, "nested"); await mkdir(nested); f.gitAt(nested, "init", "-b", "main");
	f.session(nested, "Repo anidado NO", undefined, Date.now() + 100_000);
	const missing = SessionManager.create(f.root, f.sessionDir).getSessionFile(); const current = f.session(f.worktree, "ISSUE", missing);
	const result = await preparePrincipalSession(f.snapshot, f.context(current), f.options);
	assert.equal(result.sessionFile, recent.getSessionFile()); assert.notEqual(result.sessionFile, old.getSessionFile()); assert.equal(result.created, false);
});

test("workspace_main sin conversación previa crea una sesión vacía y la reutiliza, aun si el cambio se cancela; no hereda contexto del issue", async (t) => {
	const f = await fixture(await tempDir(t)); const empty = SessionManager.create(f.root, f.sessionDir); const current = f.session(f.worktree, "CONTEXTO_ISSUE_NO_COPIAR", empty.getSessionFile());
	current.appendCustomEntry("omi-issue-triage", { issue: 42 }); const source = await readFile(current.getSessionFile()!, "utf8");
	const first = await preparePrincipalSession(f.snapshot, f.context(current), f.options);
	assert.equal(first.created, true); assert.equal(first.cwd, f.root);
	const next = await readSessionSnapshot(first.sessionFile); assert.equal(next.getCwd(), f.root); assert.deepEqual(next.buildSessionContext().messages, []);
	assert.deepEqual(next.buildSessionContext().model, { provider: "mock", modelId: "selected" }); assert.equal(next.buildSessionContext().thinkingLevel, "high");
	assert.match(next.getSessionName()!, /Repo principal/); assert.doesNotMatch(await readFile(first.sessionFile, "utf8"), /CONTEXTO_ISSUE_NO_COPIAR|omi-issue-triage/);
	for (let i = 0; i < 3; i++) { const again = await preparePrincipalSession(f.snapshot, f.context(current), f.options); assert.equal(again.created, false); assert.equal(again.sessionFile, first.sessionFile); }
	assert.equal(await readFile(current.getSessionFile()!, "utf8"), source); assert.equal((await readdir(f.sessionDir)).filter((file) => file.endsWith(".jsonl")).length, 2);
});

test("workspace_main dos ventanas no crean dos sesiones del principal y un lock abandonado no se roba", async (t) => {
	const f = await fixture(await tempDir(t)); const current = f.session(f.worktree, "ISSUE");
	const attempts = await Promise.allSettled([1, 2].map(() => preparePrincipalSession(f.snapshot, f.context(current), f.options)));
	const completed = attempts.filter((result) => result.status === "fulfilled").map((result) => result.value);
	assert.equal(completed.filter((result) => result.created).length, 1);
	for (const result of attempts) if (result.status === "rejected") assert.ok(result.reason instanceof PrincipalSessionBusyError);
	assert.equal((await SessionManager.list(f.root, f.sessionDir)).length, 1);
	const lock = join(f.root, ".git/omi/main-session.lock"); await writeFile(lock, '{"pid":999999,"host":"other"}');
	await assert.rejects(preparePrincipalSession(f.snapshot, f.context(current), f.options), /verificá el PID/); await rm(lock);
});

for (const problem of ["missing-main", "foreign-main", "corrupt-session", "parent-cycle"] as const) test(`workspace_main ${problem}: informa el problema sin modificar sesiones ni crear otro checkout`, async (t) => {
	const f = await fixture(await tempDir(t)); const original = f.session(f.root, "ORIGINAL"); const current = f.session(f.worktree, "ISSUE", original.getSessionFile());
	if (problem === "missing-main") await rename(f.root, `${f.root}-moved`);
	if (problem === "foreign-main") { await rename(f.root, `${f.root}-moved`); await mkdir(f.root); f.git("init", "-b", "main"); }
	if (problem === "corrupt-session") await writeFile(original.getSessionFile()!, "{roto\n");
	if (problem === "parent-cycle") {
		const lines = (await readFile(original.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); lines[0].cwd = f.worktree; lines[0].parentSession = original.getSessionFile();
		await writeFile(original.getSessionFile()!, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	}
	const files = await readdir(f.sessionDir); const content = await Promise.all(files.map((file) => readFile(join(f.sessionDir, file), "utf8")));
	await assert.rejects(preparePrincipalSession(f.snapshot, f.context(current), f.options), /principal|sesión|JSONL/);
	assert.deepEqual(await readdir(f.sessionDir), files); assert.deepEqual(await Promise.all(files.map((file) => readFile(join(f.sessionDir, file), "utf8"))), content);
});

test("workspace_main abortar o cambiar de sesión durante la búsqueda no crea una conversación y libera el lock", async (t) => {
	const f = await fixture(await tempDir(t)); const current = f.session(f.worktree, "ISSUE");
	await assert.rejects(preparePrincipalSession(f.snapshot, f.context(current), { ...f.options, signal: AbortSignal.abort() }));
	let checks = 0;
	await assert.rejects(preparePrincipalSession(f.snapshot, f.context(current), { ...f.options, isCurrent: () => ++checks < 3 }), /sesión cambió/);
	await assert.rejects(access(join(f.root, ".git/omi/main-session.lock"))); assert.equal((await SessionManager.list(f.root, f.sessionDir)).length, 0);
});
