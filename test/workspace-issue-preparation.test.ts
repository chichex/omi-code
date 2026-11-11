import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit, type GithubItem } from "../src/tui/workspace/data.ts";
import { prepareIssue, type PrepareIssueOptions } from "../src/tui/workspace/issue-preparation.ts";
import { discoverLegacyPreparations, IssuePreparationBusyError, issueRegistryDir, loadIssuePreparations, readIssuePreparation, readIssueSession, rememberIssueSession, saveIssuePreparation, withIssuePreparationLock, type IssuePreparation } from "../src/tui/workspace/issue-registry.ts";
import { createIssueSession, issueTriageState, type IssueTriage } from "../src/tui/workspace/issue-triage.ts";
import { createIssueWorktree, issueWorktreePath, planIssueWorktree } from "../src/tui/workspace/issue-worktree.ts";
import { tempDir } from "./helpers/io.ts";

const issue: GithubItem = { number: 42, title: "Arreglar filtro", url: "https://github.com/test/repo/issues/42", labels: ["bug"], author: "ada", updatedAt: "", draft: false, head: "", base: "", review: "" };
const triage: IssueTriage = { type: "fix", summary: "Corregir el filtro", rationale: "Comportamiento roto", scope: ["Revisar filtro"], acceptanceCriteria: ["El filtro funciona"], questions: [] };
const classification = { triage, body: "Issue original", provider: "mock", model: "triage", usage: { input: 100, output: 200, totalTokens: 300, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
const noClassification = async (): Promise<never> => { throw new Error("NO DEBE RECLASIFICAR"); };
async function fixture(home: string) {
	const root = join(home, "repo"); await mkdir(root, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "file.txt"), "main\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main");
	const snapshot = (await readGit(root))!;
	const parent = SessionManager.create(root, join(home, "parent"));
	parent.appendMessage({ role: "user", content: "Conversación original", timestamp: Date.now() });
	const ctx = { cwd: root, sessionManager: parent } as unknown as ExtensionContext;
	const options: PrepareIssueOptions = { sessionDir: join(home, "sessions"), signal: new AbortController().signal, isCurrent: () => true, classify: noClassification };
	const save = (record: IssuePreparation) => withIssuePreparationLock(snapshot, 42, () => saveIssuePreparation(snapshot, record));
	const planned = async (): Promise<IssuePreparation> => ({ version: 1, commonDir: await realpath(snapshot.commonDir), state: issueTriageState(issue, triage, await planIssueWorktree(snapshot, issue, "fix")), phase: "triaged", source: { body: classification.body, labels: issue.labels } });
	return { root, git, snapshot, ctx, options, save, planned };
}

test("issue_preparation un issue → un triage, worktree y sesión; retomar desde main u otro worktree conserva todo sin modelo", async (t) => {
	const home = await tempDir(t); const f = await fixture(home); let calls = 0;
	await writeFile(join(f.root, "file.txt"), "stage\n"); f.git("add", "file.txt"); await writeFile(join(f.root, "file.txt"), "unstaged\n");
	const original = { status: f.git("status", "--porcelain"), index: f.git("write-tree"), head: f.git("rev-parse", "HEAD"), parent: await readFile(f.ctx.sessionManager.getSessionFile()!, "utf8") };
	const first = (await prepareIssue(f.snapshot, 42, issue, f.ctx, { ...f.options, classify: async () => { calls++; return classification; } }))!;
	assert.equal(first.resumed, false); assert.equal(first.record.phase, "ready"); assert.equal(calls, 1);
	const { state, sessionFile } = first.record;
	const conversation = SessionManager.open(sessionFile!); conversation.appendMessage({ role: "user", content: "Conservar esta conversación al retomar", timestamp: Date.now() });
	const savedConversation = await readFile(sessionFile!, "utf8");
	await writeFile(join(state.worktree, "file.txt"), "cambios propios del issue\n"); await writeFile(join(state.worktree, "local.txt"), "NO PISAR\n");
	f.git("worktree", "add", "-b", "other", join(home, "other"), "main"); const other = (await readGit(join(home, "other")))!;
	for (const snapshot of [f.snapshot, other, (await readGit(state.worktree))!]) {
		const again = (await prepareIssue(snapshot, 42, { ...issue, title: "Título actualizado" }, f.ctx, f.options))!;
		assert.equal(again.resumed, true); assert.deepEqual(again.record, first.record);
		assert.equal((await loadIssuePreparations(snapshot)).get(42)?.record?.sessionFile, sessionFile);
	}
	assert.equal(calls, 1); assert.equal(await readFile(sessionFile!, "utf8"), savedConversation);
	assert.equal(await readFile(join(state.worktree, "file.txt"), "utf8"), "cambios propios del issue\n"); assert.equal(await readFile(join(state.worktree, "local.txt"), "utf8"), "NO PISAR\n");
	assert.equal(f.git("branch", "--show-current"), "main"); assert.equal(f.git("status", "--porcelain"), original.status); assert.equal(f.git("write-tree"), original.index); assert.equal(f.git("rev-parse", "HEAD"), original.head);
	assert.equal(await readFile(f.ctx.sessionManager.getSessionFile()!, "utf8"), original.parent);
	assert.equal((await readdir(f.options.sessionDir!)).filter((file) => file.endsWith(".jsonl")).length, 1);
	assert.equal((await readIssuePreparation(other, 42))!.state.triage.type, "fix");
});

for (const phase of ["triaged", "branch-only", "worktree", "reserved-session", "published-session"] as const) test(`issue_preparation recupera ${phase} sin repetir el modelo ni lo ya creado`, async (t) => {
	const home = await tempDir(t); const f = await fixture(home); let record = await f.planned(); const base = record.state.baseCommit;
	if (phase === "branch-only") f.git("branch", record.state.branch, base);
	if (["worktree", "reserved-session", "published-session"].includes(phase)) {
		f.git("worktree", "add", "-b", record.state.branch, record.state.worktree, base); record = { ...record, phase: "worktree" };
		await writeFile(join(record.state.worktree, "keep"), "Trabajo empezado\n");
	}
	if (phase === "reserved-session") record = { ...record, sessionFile: join(home, "sessions/reserved.jsonl") };
	if (phase === "published-session") {
		const sessionFile = await createIssueSession(record.state, issue, record.source.body, f.ctx, f.options.sessionDir);
		record = { ...record, sessionFile };
		SessionManager.open(sessionFile).appendMessage({ role: "user", content: "No duplicar esta sesión", timestamp: Date.now() });
	}
	await f.save(record); const previousSession = record.sessionFile && phase === "published-session" ? await readFile(record.sessionFile, "utf8") : undefined;
	// main puede moverse: una preparación guardada conserva el SHA que se verificó antes.
	await writeFile(join(f.root, "new-main.txt"), "nuevo main\n"); f.git("add", "."); f.git("-c", "commit.gpgsign=false", "commit", "-m", "move main");
	const result = (await prepareIssue(f.snapshot, 42, undefined, f.ctx, f.options))!;
	assert.equal(result.record.phase, "ready"); assert.equal(result.record.state.baseCommit, base);
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: record.state.worktree, encoding: "utf8" }).trim(), base);
	if (record.sessionFile) assert.equal(result.record.sessionFile, record.sessionFile);
	if (previousSession) assert.equal(await readFile(result.record.sessionFile!, "utf8"), previousSession);
	if (["worktree", "reserved-session", "published-session"].includes(phase)) assert.equal(await readFile(join(record.state.worktree, "keep"), "utf8"), "Trabajo empezado\n");
	assert.equal((await readdir(f.options.sessionDir!)).filter((file) => file.endsWith(".jsonl")).length, 1);
	assert.equal((await loadIssuePreparations(f.snapshot)).get(42)?.error, undefined);
});

test("issue_preparation el lock compartido impide clasificar o crear dos veces, se libera al terminar/cancelar/fallar", async (t) => {
	const f = await fixture(await tempDir(t)); let release!: () => void; let entered!: () => void; let calls = 0;
	const started = new Promise<void>((resolve) => { entered = resolve; }); const wait = new Promise<void>((resolve) => { release = resolve; });
	const first = prepareIssue(f.snapshot, 42, issue, f.ctx, { ...f.options, classify: async () => { calls++; entered(); await wait; return classification; } });
	await started;
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), IssuePreparationBusyError);
	release(); const prepared = await first; assert.equal(calls, 1);
	assert.equal((await prepareIssue(f.snapshot, 42, issue, f.ctx, f.options))!.record.sessionFile, prepared!.record.sessionFile);
	for (const action of [async () => undefined, async (): Promise<never> => { throw new Error("Falla de modelo"); }]) {
		const other = { ...issue, number: 43 }; const attempt = () => prepareIssue(f.snapshot, 43, other, f.ctx, { ...f.options, classify: action });
		try { await attempt(); } catch (error) { assert.match(String(error), /Falla de modelo/); }
		await assert.rejects(access(join(issueRegistryDir(f.snapshot), "43.lock"))); assert.equal(await readIssuePreparation(f.snapshot, 43), undefined);
		await assert.rejects(access(issueWorktreePath(f.snapshot, 43)));
	}
});

for (const resource of ["worktree", "session", "branch", "foreign-folder"] as const) test(`issue_preparation ${resource} inválido no se reemplaza ni se recrea automáticamente`, async (t) => {
	const f = await fixture(await tempDir(t)); const result = (await prepareIssue(f.snapshot, 42, issue, f.ctx, { ...f.options, classify: async () => classification }))!;
	const { state, sessionFile } = result.record; const saved = await readFile(sessionFile!, "utf8");
	if (resource === "worktree") f.git("worktree", "remove", state.worktree);
	if (resource === "session") await rename(sessionFile!, `${sessionFile}.keep`);
	if (resource === "branch") execFileSync("git", ["checkout", "--detach"], { cwd: state.worktree, stdio: "ignore" });
	if (resource === "foreign-folder") { f.git("worktree", "remove", state.worktree); await mkdir(state.worktree); await writeFile(join(state.worktree, "keep"), "Carpeta ajena"); }
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /Falta|no corresponde/);
	assert.equal((await readIssuePreparation(f.snapshot, 42))!.sessionFile, sessionFile);
	assert.equal(await readFile(resource === "session" ? `${sessionFile}.keep` : sessionFile!, "utf8"), saved);
	if (resource === "worktree") await assert.rejects(access(state.worktree));
	if (resource === "session") await assert.rejects(access(sessionFile!));
	if (resource === "foreign-folder") assert.equal(await readFile(join(state.worktree, "keep"), "utf8"), "Carpeta ajena");
	if (resource === "worktree" || resource === "session") assert.match((await loadIssuePreparations(f.snapshot)).get(42)!.error!, /Recuperación pendiente/);
});

test("issue_preparation no adopta un plan pendiente si su rama cambió ni una ruta ajena sin registro", async (t) => {
	const f = await fixture(await tempDir(t)); const record = await f.planned(); await f.save(record);
	await writeFile(join(f.root, "new.txt"), "cambio\n"); f.git("add", "."); f.git("-c", "commit.gpgsign=false", "commit", "-m", "new"); f.git("branch", record.state.branch, "HEAD");
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /rama.*cambió/);
	await assert.rejects(access(record.state.worktree)); assert.equal(f.git("rev-parse", record.state.branch), f.git("rev-parse", "HEAD"));
	await mkdir(issueWorktreePath(f.snapshot, 43), { recursive: true });
	await assert.rejects(prepareIssue(f.snapshot, 43, { ...issue, number: 43 }, f.ctx, f.options), /Ya existe/);
});

test("issue_preparation migra metadata de sesiones anteriores sólo con identidad Git y sesión verificadas; /resume actualiza el vínculo", async (t) => {
	const f = await fixture(await tempDir(t));
	const tree = await createIssueWorktree(f.snapshot, issue, "fix"); const state = issueTriageState(issue, triage, tree);
	const file = await createIssueSession(state, issue, classification.body, f.ctx, f.options.sessionDir);
	const discovered = await discoverLegacyPreparations(f.snapshot, new Map(), f.options.sessionDir);
	assert.equal(discovered.get(42)?.record?.sessionFile, file); assert.equal(await readIssuePreparation(f.snapshot, 42), undefined, "el listado no escribe ni cambia sesiones");
	const migrated = (await prepareIssue(f.snapshot, 42, issue, f.ctx, f.options))!;
	assert.equal(migrated.resumed, true); assert.equal(migrated.record.sessionFile, file);
	const fork = SessionManager.forkFrom(file, tree.worktree, f.options.sessionDir); const forkFile = fork.getSessionFile()!;
	fork.appendMessage({ role: "user", content: "Continuar en el fork elegido explícitamente", timestamp: Date.now() });
	await rememberIssueSession(f.snapshot, state, forkFile);
	assert.equal((await prepareIssue(f.snapshot, 42, issue, f.ctx, f.options))!.record.sessionFile, forkFile);
	assert.match(await readFile(file, "utf8"), /Triage listo/); assert.doesNotMatch(await readFile(file, "utf8"), /Continuar en el fork/);
	// No registrar un fork que perdió el triage de su rama activa.
	fork.resetLeaf(); fork.appendMessage({ role: "user", content: "Otra rama sin triage", timestamp: Date.now() });
	await assert.rejects(readIssueSession(forkFile), /triage completo/);
});

test("issue_preparation si varias sesiones antiguas coinciden, exige /resume en lugar de elegir una conversación arbitraria", async (t) => {
	const f = await fixture(await tempDir(t)); const tree = await createIssueWorktree(f.snapshot, issue, "fix"); const state = issueTriageState(issue, triage, tree);
	const first = await createIssueSession(state, issue, "body", f.ctx, f.options.sessionDir);
	await createIssueSession(state, issue, "body", f.ctx, f.options.sessionDir);
	assert.match((await discoverLegacyPreparations(f.snapshot, new Map(), f.options.sessionDir)).get(42)!.error!, /varias sesiones/);
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /varias sesiones/);
	await rememberIssueSession(f.snapshot, state, first);
	assert.equal((await prepareIssue(f.snapshot, 42, issue, f.ctx, f.options))!.record.sessionFile, first);
});

test("issue_preparation rechaza registros corruptos, de otro repo/issue y sesiones ajenas sin sobrescribirlos", async (t) => {
	const home = await tempDir(t); const f = await fixture(home);
	const result = (await prepareIssue(f.snapshot, 42, issue, f.ctx, { ...f.options, classify: async () => classification }))!;
	const path = join(issueRegistryDir(f.snapshot), "42.json"); const original = await readFile(path, "utf8");
	for (const value of ["{", JSON.stringify({ ...result.record, commonDir: join(home, "another/.git") }), JSON.stringify({ ...result.record, state: { ...result.record.state, worktree: home } }), JSON.stringify({ ...result.record, phase: "ready", sessionFile: undefined })]) {
		await writeFile(path, value); await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /registro/);
		assert.equal(await readFile(path, "utf8"), value); assert.ok((await loadIssuePreparations(f.snapshot)).get(42)!.error);
	}
	await writeFile(path, original);
	await assert.rejects(prepareIssue(f.snapshot, 42, { ...issue, url: "https://github.com/other/repo/issues/42" }, f.ctx, f.options), /otro issue\/repositorio/);
	const unrelated = SessionManager.create(f.root, f.options.sessionDir); unrelated.appendMessage({ role: "user", content: "No soy del issue", timestamp: Date.now() });
	await f.save({ ...result.record, sessionFile: unrelated.getSessionFile()! });
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /triage completo/);
	assert.equal((await readIssuePreparation(f.snapshot, 42))!.sessionFile, unrelated.getSessionFile());
});

test("issue_preparation publicar una sesión es atómico y nunca trunca un archivo ya existente, ni sigue symlinks", async (t) => {
	const f = await fixture(await tempDir(t)); const result = (await prepareIssue(f.snapshot, 42, issue, f.ctx, { ...f.options, classify: async () => classification }))!;
	const file = result.record.sessionFile!; const before = await readFile(file, "utf8");
	await assert.rejects(createIssueSession(result.record.state, issue, "body", f.ctx, f.options.sessionDir, undefined, { sessionFile: file }), { code: "EEXIST" });
	assert.equal(await readFile(file, "utf8"), before);
	for (const damaged of [before + '{"incomplete":', before + before.trim().split("\n").at(-1) + "\n"]) {
		await writeFile(file, damaged); await assert.rejects(readIssueSession(file), /JSONL o árbol/);
		assert.equal(await readFile(file, "utf8"), damaged, "verificar nunca repara ni reescribe una sesión corrupta");
	}
	await writeFile(file, before);
	if (process.platform !== "win32") {
		const alias = `${file}.symlink`; await symlink(file, alias);
		await assert.rejects(readIssueSession(alias), /verificar la sesión/);
		await assert.rejects(createIssueSession(result.record.state, issue, "body", f.ctx, f.options.sessionDir, undefined, { sessionFile: alias }), { code: "EEXIST" });
		assert.equal(await readFile(file, "utf8"), before);
	}
	assert.ok(!(await readdir(f.options.sessionDir!)).some((file) => file.endsWith(".tmp")));
	// Un lock abandonado no se vence por antigüedad: requiere revisar el proceso antes de quitarlo.
	await writeFile(join(issueRegistryDir(f.snapshot), "42.lock"), JSON.stringify({ pid: 99999999, host: "other-host", createdAt: "2000-01-01" }));
	await assert.rejects(prepareIssue(f.snapshot, 42, issue, f.ctx, f.options), /verificá el proceso/);
	await rm(join(issueRegistryDir(f.snapshot), "42.lock"));
});
