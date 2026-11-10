import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readCommand, readGit, type ReadCommand } from "../src/tui/workspace/data.ts";
import { tempDir } from "./helpers/io.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
async function trackedRepo(t: TestContext) {
	const dir = await tempDir(t); const main = join(dir, "main"); const remote = join(dir, "remote.git"); await mkdir(main);
	git(main, "init", "-b", "main"); git(main, "config", "user.email", "test@example.test"); git(main, "config", "user.name", "Test");
	await writeFile(join(main, "file.txt"), "initial\n"); git(main, "add", "."); git(main, "commit", "-m", "initial");
	git(dir, "init", "--bare", remote); git(main, "remote", "add", "origin", remote); git(main, "push", "--set-upstream", "origin", "main");
	return { dir, main, remote };
}
const readOnly: ReadCommand = (command, args, cwd, signal) => {
	assert.equal(command, "git"); assert.ok(!["fetch", "pull", "push"].includes(args[0]!));
	return readCommand(command, args, cwd, signal);
};

test("workspace_sync cuenta commits reales, no cambios sin commit, y lee el último fetch sin acceder al remoto", async (t) => {
	const { dir, main, remote } = await trackedRepo(t);
	git(main, "tag", "main"); // La referencia completa evita confundir un tag y un branch del mismo nombre.
	let snapshot = (await readGit(main, undefined, readOnly))!;
	assert.equal(snapshot.upstream, "origin/main"); assert.equal(snapshot.tracking, true); assert.equal(snapshot.ahead, 0); assert.equal(snapshot.behind, 0);
	await writeFile(join(main, "file.txt"), "local\n"); await writeFile(join(main, "untracked.txt"), "new\n");
	snapshot = (await readGit(main, undefined, readOnly))!;
	assert.equal(snapshot.changeCount, 2); assert.equal(snapshot.ahead, 0); assert.equal(snapshot.behind, 0);
	git(main, "add", "."); git(main, "commit", "-m", "local ahead");
	snapshot = (await readGit(main, undefined, readOnly))!; assert.equal(snapshot.ahead, 1); assert.equal(snapshot.behind, 0);
	const peer = join(dir, "peer"); git(dir, "clone", "--branch", "main", remote, peer);
	git(peer, "config", "user.email", "test@example.test"); git(peer, "config", "user.name", "Test");
	for (const name of ["remote-one.txt", "remote-two.txt"]) { await writeFile(join(peer, name), name); git(peer, "add", "."); git(peer, "commit", "-m", name); }
	git(peer, "push");
	// No afirmar que consultamos el servidor: hasta un fetch explícito, el upstream local sigue igual.
	snapshot = (await readGit(main, undefined, readOnly))!; assert.equal(snapshot.ahead, 1); assert.equal(snapshot.behind, 0);
	git(main, "fetch", "origin");
	snapshot = (await readGit(main, undefined, readOnly))!; assert.equal(snapshot.ahead, 1); assert.equal(snapshot.behind, 2);
	const worktree = join(dir, "worktree"); git(main, "worktree", "add", "-b", "topic/feature", worktree); git(worktree, "branch", "--set-upstream-to=origin/main");
	snapshot = (await readGit(worktree, undefined, readOnly))!;
	assert.equal(snapshot.branch, "topic/feature"); assert.equal(snapshot.linked, true); assert.equal(snapshot.upstream, "origin/main"); assert.equal(snapshot.ahead, 1); assert.equal(snapshot.behind, 2);
	git(main, "checkout", "--detach"); snapshot = (await readGit(main, undefined, readOnly))!;
	assert.equal(snapshot.detached, true); assert.equal(snapshot.tracking, false); assert.equal(snapshot.ahead, undefined); assert.equal(snapshot.behind, undefined);
});

test("workspace_sync upstream ausente y referencia eliminada no son ceros ni el mismo estado", async (t) => {
	const { main } = await trackedRepo(t);
	git(main, "update-ref", "-d", "refs/remotes/origin/main");
	let snapshot = (await readGit(main))!;
	assert.equal(snapshot.tracking, true); assert.equal(snapshot.upstream, "origin/main"); assert.equal(snapshot.ahead, undefined); assert.equal(snapshot.behind, undefined);
	git(main, "branch", "--unset-upstream"); snapshot = (await readGit(main))!;
	assert.equal(snapshot.tracking, false); assert.equal(snapshot.upstream, undefined); assert.equal(snapshot.ahead, undefined); assert.equal(snapshot.behind, undefined);
});

test("workspace_sync rechaza errores, truncados y conteos inválidos en vez de fabricar ↑0 ↓0", async (t) => {
	const { main } = await trackedRepo(t);
	for (const result of [
		{ code: 1, stdout: "" }, { code: 0, stdout: "0\t0\n", truncated: true },
		...["", "0", "0\t0 trailing", "NaN\t0", "-1\t0", "1.2\t0", "9007199254740992\t0", "0\t0\0"].map((stdout) => ({ code: 0, stdout })),
	]) {
		const run: ReadCommand = (command, args, cwd, signal) => args[0] === "rev-list" ? Promise.resolve(result) : readOnly(command, args, cwd, signal);
		const snapshot = (await readGit(main, undefined, run))!;
		assert.equal(snapshot.tracking, true); assert.equal(snapshot.upstream, "origin/main"); assert.equal(snapshot.ahead, undefined); assert.equal(snapshot.behind, undefined);
	}
	for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "", truncated: true }, { code: 0, stdout: "" }, { code: 0, stdout: "malformed\n" }]) {
		const run: ReadCommand = (command, args, cwd, signal) => args[0] === "for-each-ref" ? Promise.resolve(result) : readOnly(command, args, cwd, signal);
		const snapshot = (await readGit(main, undefined, run))!;
		assert.equal(snapshot.tracking, undefined); assert.equal(snapshot.ahead, undefined); assert.equal(snapshot.behind, undefined);
	}
});
