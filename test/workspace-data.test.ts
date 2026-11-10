import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cpuPercent, linuxAvailable, macAvailable, parseNumstat, parseStatus, readCommand, readFileDiff, readGit, readGithub, readGithubDetail, readUntrackedPreview, resourceReader, safeText, sensitivePreviewPath, workspaceName, type ReadCommand } from "../src/tui/workspace/data.ts";
import { loadWorkspacePreferences, saveWorkspacePreferences } from "../src/tui/workspace/index.ts";
import { tempDir } from "./helpers/io.ts";
import { agentDir } from "../src/core/paths.ts";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim(); }
async function repo(path: string): Promise<void> { await mkdir(path); git(path, "init", "-b", "main"); git(path, "config", "user.email", "test@example.test"); git(path, "config", "user.name", "Test"); await writeFile(join(path, "file.txt"), "initial\n"); git(path, "add", "."); git(path, "commit", "-m", "initial"); }

test("workspace_Git distingue repo principal, worktree real y HEAD separado", async (t) => {
	const dir = await tempDir(t); const main = join(dir, "main"); const linked = join(dir, "linked"); await repo(main);
	const initial = await readGit(main); assert.ok(initial); assert.equal(initial.linked, false); assert.equal(initial.branch, "main"); assert.equal(initial.changeCount, 0); assert.equal(initial.tracking, false); assert.equal(workspaceName(initial), "Repo principal");
	git(main, "worktree", "add", "-b", "feature", linked);
	const snapshot = await readGit(linked); assert.ok(snapshot); assert.equal(snapshot.linked, true); assert.equal(snapshot.branch, "feature"); assert.equal(snapshot.mainRoot, await realpath(main)); assert.equal(snapshot.root, await realpath(linked)); assert.match(workspaceName(snapshot), /Worktree/);
	git(linked, "checkout", "--detach"); const detached = await readGit(linked); assert.equal(detached?.detached, true); assert.equal(detached?.linked, true);
});

test("workspace_Git soporta repo sin commits y carpetas sin Git", async (t) => {
	const dir = await tempDir(t); assert.equal(await readGit(dir), undefined);
	git(dir, "init", "-b", "new"); assert.equal((await readGit(dir))?.branch, "new");
});

test("workspace_status -z conserva rutas raras y consume el origen de un rename", () => {
	const result = parseStatus("R  new name\0old name\0?? with\nnewline\0 M \x1b[31m.txt\0");
	assert.equal(result.changeCount, 3); assert.deepEqual(result.changes[0], { status: "R ", path: "new name", previousPath: "old name" }); assert.equal(result.changes[1]?.path, "with\nnewline");
	assert.equal(safeText("hello\x1b]52;c;secret\x07\nworld"), "hello]52;c;secretworld");
	assert.equal(parseStatus(Array.from({ length: 150 }, (_, i) => `?? ${i}\0`).join("")).changes.length, 100);
});

test("workspace_numstat -z conserva rutas raras, renames y binarios, y rechaza datos incompletos", () => {
	const stats = parseNumstat("10\t2\twith\ttab\nline.txt\0-\t-\tbinary.dat\0" + "1\t0\t\0old name\0new name\0");
	assert.ok(stats);
	assert.deepEqual(stats.get("with\ttab\nline.txt"), { added: 10, removed: 2 });
	assert.equal(stats.get("binary.dat"), "binary"); assert.deepEqual(stats.get("new name"), { added: 1, removed: 0 });
	assert.equal(stats.has("old name"), false); assert.equal(parseNumstat("")?.size, 0);
	for (const invalid of ["1\t2\tfile", "1\t2\t\0old\0", "-\t0\tfile\0", "bad\t2\tfile\0", "9007199254740992\t0\tfile\0", "1\t0\tfile\0" + "1\t0\tfile\0"]) assert.equal(parseNumstat(invalid), undefined);
});

test("workspace_líneas por archivo son el cambio neto contra HEAD, sin duplicar stage y working", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main);
	await writeFile(join(main, "deleted.txt"), "one\ntwo\n"); await writeFile(join(main, "old.txt"), "rename one\nrename two\nrename three\n");
	await writeFile(join(main, "binary.dat"), Buffer.from([0, 1, 2])); git(main, "add", "."); git(main, "commit", "-m", "fixtures");
	await writeFile(join(main, "file.txt"), "staged\nextra\n"); git(main, "add", "file.txt"); await writeFile(join(main, "file.txt"), "final\n");
	await writeFile(join(main, "added.txt"), "one\ntwo\nthree\n"); git(main, "add", "added.txt"); await writeFile(join(main, "added.txt"), "one\ntwo\n");
	await unlink(join(main, "deleted.txt")); git(main, "mv", "old.txt", "renamed.txt");
	await writeFile(join(main, "binary.dat"), Buffer.from([0, 3, 4])); await writeFile(join(main, ".env"), "DO_NOT_READ\n");
	const before = await readFile(join(main, ".git/index"));
	const snapshot = (await readGit(main))!; const lines = (path: string) => snapshot.changes.find((file) => file.path === path)?.lines;
	assert.deepEqual(lines("file.txt"), { added: 1, removed: 1 }); assert.deepEqual(lines("added.txt"), { added: 2, removed: 0 });
	assert.deepEqual(lines("deleted.txt"), { added: 0, removed: 2 }); assert.deepEqual(lines("renamed.txt"), { added: 0, removed: 0 });
	assert.equal(lines("binary.dat"), "binary"); assert.equal(lines(".env"), undefined);
	assert.deepEqual(await readFile(join(main, ".git/index")), before);
	await writeFile(join(main, "renamed.txt"), "rename one\nrename two\nrename three\nrename four\n");
	assert.deepEqual((await readGit(main))!.changes.find((file) => file.path === "renamed.txt")!.lines, { added: 1, removed: 0 });
	// Un cambio en stage deshecho en el working tree no se cuenta dos veces.
	await writeFile(join(main, "file.txt"), "initial\n");
	assert.deepEqual((await readGit(main))!.changes.find((file) => file.path === "file.txt")!.lines, { added: 0, removed: 0 });
});

test("workspace_líneas funciona antes del primer commit con SHA-1 y SHA-256", async (t) => {
	for (const format of ["sha1", "sha256"]) {
		const main = join(await tempDir(t), "main"); await mkdir(main); git(main, "init", "-b", "main", `--object-format=${format}`);
		await writeFile(join(main, "new.txt"), "one\ntwo\nthree\n"); git(main, "add", "new.txt");
		await writeFile(join(main, "new.txt"), "one\ntwo\n");
		assert.deepEqual((await readGit(main))!.changes[0]!.lines, { added: 2, removed: 0 });
	}
});

test("workspace_líneas usa rutas literales desde la raíz, incluso al abrir un subdirectorio", { skip: process.platform === "win32" }, async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); await mkdir(join(main, "nested"));
	const path = "nested/with\ttab\n[1]*.txt"; await writeFile(join(main, path), "original\n"); git(main, "add", "."); git(main, "commit", "-m", "odd path");
	await writeFile(join(main, path), "changed\nextra\n");
	const snapshot = (await readGit(join(main, "nested")))!;
	assert.deepEqual(snapshot.changes.find((file) => file.path === path)!.lines, { added: 2, removed: 1 });
});

test("workspace_líneas no inventa ceros ante error/truncado ni lee archivos sin seguimiento", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); await writeFile(join(main, "file.txt"), "changed\n");
	for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "1\t1\tfile.txt\0", truncated: true }, { code: 0, stdout: "1\t1\tfile.txt" }]) {
		const run: ReadCommand = (command, args, cwd, signal) => args.includes("--numstat") ? Promise.resolve(result) : readCommand(command, args, cwd, signal);
		assert.equal((await readGit(main, undefined, run))!.changes[0]!.lines, undefined);
	}
	await writeFile(join(main, "file.txt"), "initial\n"); await writeFile(join(main, ".env"), "PRIVATE\n");
	const run: ReadCommand = (command, args, cwd, signal) => { assert.ok(!args.includes("--numstat"), "no pedir estadísticas de archivos sin seguimiento"); return readCommand(command, args, cwd, signal); };
	assert.equal((await readGit(main, undefined, run))!.changes[0]!.lines, undefined);
});

test("workspace_diff lee working y staged sin ejecutar drivers externos; no abre untracked", async (t) => {
	const dir = await tempDir(t); const main = join(dir, "main"); await repo(main); await writeFile(join(main, "file.txt"), "staged\n"); git(main, "add", "."); await writeFile(join(main, "file.txt"), "working\n");
	const snapshot = (await readGit(main))!; const diff = await readFileDiff(snapshot, snapshot.changes[0]!);
	assert.match(diff, /\+working/); assert.match(diff, /\+staged/);
	const unseen = await readFileDiff(snapshot, { status: "??", path: ".env" }, undefined, async () => { throw new Error("no ejecutar"); }); assert.match(unseen, /No se lee automáticamente/);
});

test("workspace_archivos nuevos se enumeran individualmente y sólo se leen por apertura explícita", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); await mkdir(join(main, "test"));
	await writeFile(join(main, "test/preview.test.ts"), "export const PREVIEW_ONLY = true;\n");
	const snapshot = (await readGit(main))!; const file = snapshot.changes.find((file) => file.path === "test/preview.test.ts")!;
	assert.equal(file.status, "??");
	assert.doesNotMatch(await readFileDiff(snapshot, file), /export const/);
	const before = await readFile(join(main, ".git/index"));
	assert.match(await readUntrackedPreview(snapshot, file), /ARCHIVO NUEVO.*test\/preview.test.ts[\s\S]*export const PREVIEW_ONLY/);
	assert.deepEqual(await readFile(join(main, ".git/index")), before); assert.equal(git(main, "status", "--porcelain").includes("?? test/"), true);
});

test("workspace_preview nueva: vacíos, binarios, límites de bytes y líneas y controles de terminal", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); const snapshot = (await readGit(main))!;
	const preview = (path: string) => readUntrackedPreview(snapshot, { status: "??", path });
	await writeFile(join(main, "empty.txt"), ""); assert.match(await preview("empty.txt"), /archivo vacío/);
	await writeFile(join(main, "binary.dat"), Buffer.from([0, 1, 2])); assert.match(await preview("binary.dat"), /Archivo binario/);
	await writeFile(join(main, "latin.dat"), Buffer.from([255, 254])); assert.match(await preview("latin.dat"), /no UTF-8/);
	await writeFile(join(main, "huge.txt"), "a".repeat(300 * 1024)); const large = await preview("huge.txt"); assert.match(large, /Vista parcial/); assert.ok(large.length < 257 * 1024);
	await writeFile(join(main, "lines.txt"), "line\n".repeat(2000) + "DO_NOT_SHOW_LAST_LINE"); const lines = await preview("lines.txt"); assert.match(lines, /Vista parcial/); assert.doesNotMatch(lines, /DO_NOT_SHOW_LAST_LINE/);
	await writeFile(join(main, "controls.txt"), "a\x1b]52;c;clipboard\x07\nb\tend"); const clean = await preview("controls.txt"); assert.doesNotMatch(clean, /[\x1b\x07]/); assert.match(clean, /b    end/);
	await writeFile(join(main, "utf8.txt"), "a".repeat(256 * 1024 - 1) + "中"); assert.match(await preview("utf8.txt"), /Vista parcial/);
	await assert.rejects(preview("missing.txt"), { code: "ENOENT" });
	await assert.rejects(readUntrackedPreview(snapshot, { status: "??", path: "empty.txt" }, AbortSignal.abort()), /abort/i);
});

test("workspace_preview no sigue enlaces ni sale del checkout", { skip: process.platform === "win32" }, async (t) => {
	const dir = await tempDir(t); const main = join(dir, "main"); await repo(main); const snapshot = (await readGit(main))!;
	await writeFile(join(dir, "secret.txt"), "OUTSIDE_SECRET"); await symlink(join(dir, "secret.txt"), join(main, "link.txt")); await symlink(dir, join(main, "outside"));
	for (const path of ["../secret.txt", join(dir, "secret.txt"), "link.txt", "outside/secret.txt", "."]) {
		const result = await readUntrackedPreview(snapshot, { status: "??", path });
		assert.doesNotMatch(result, /OUTSIDE_SECRET/); assert.match(result, /fuera del checkout|Enlace simbólico/);
	}
	await mkdir(join(main, "folder")); assert.match(await readUntrackedPreview(snapshot, { status: "??", path: "folder" }), /No es un archivo regular/);
});

test("workspace_preview reconoce rutas sensibles para la confirmación adicional", () => {
	for (const path of [".env", ".env.local", "nested/.env.production", "credentials.json", "secrets/token", "server.KEY", ".ssh/config", "id_ed25519", ".omi/agent/auth.json", ".netrc", "token.json"]) assert.equal(sensitivePreviewPath(path), true, path);
	for (const path of ["test/workspace-turn.test.ts", "src/environment.ts", "README.md", "src/auth.ts"]) assert.equal(sensitivePreviewPath(path), false, path);
});

test("workspace_lecturas Git no ejecutan fsmonitor, diff externo ni textconv, y no refrescan el índice", { skip: process.platform === "win32" }, async (t) => {
	const dir = await tempDir(t); const main = join(dir, "main"); await repo(main);
	const marker = join(dir, "executed"); const hook = join(dir, "probe.sh");
	await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker.replaceAll("'", "'\\''")}'\nexit 0\n`, { mode: 0o755 });
	git(main, "config", "core.fsmonitor", hook); git(main, "config", "diff.external", hook); git(main, "config", "diff.probe.textconv", hook);
	await writeFile(join(main, ".gitattributes"), "file.txt diff=probe\n"); await writeFile(join(main, "file.txt"), "changed file size\n");
	const before = await readFile(join(main, ".git/index")); const snapshot = (await readGit(main))!;
	await readFileDiff(snapshot, snapshot.changes.find((file) => file.path === "file.txt")!);
	assert.deepEqual(await readFile(join(main, ".git/index")), before);
	await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("workspace_CPU usa diferencias entre muestras y no convierte desconocido en cero", () => {
	assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50);
	assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 100, total: 200 }), undefined);
	assert.equal(cpuPercent({ idle: 0, total: 0 }, { idle: 200, total: 100 }), 0);
});

test("workspace_RAM interpreta MemAvailable y vm_stat", () => {
	assert.equal(linuxAvailable("MemTotal: 16000 kB\nMemAvailable:  6000 kB\n"), 6000 * 1024); assert.equal(linuxAvailable("no data"), undefined);
	assert.equal(macAvailable("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\nPages purgeable: 9."), 35 * 16384);
	assert.equal(macAvailable("not available"), undefined);
});

test("workspace_recursos reales incluyen host, memoria del proceso y volumen activo", async (t) => {
	const sample = resourceReader(); const data = await sample(await tempDir(t)); assert.ok(data.host); assert.ok(data.totalRam > 0); assert.ok(data.rss > 0); if (process.platform !== "win32") assert.ok(data.disk && data.disk.available >= 0); assert.equal(data.cpu, undefined);
});

test("workspace_GitHub consulta sólo issues y PRs abiertos de todo el repo, incluso con HEAD separado", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); const snapshot = { ...(await readGit(main))!, detached: true };
	const calls: string[][] = [];
	const run: ReadCommand = async (command, args, cwd) => {
		assert.equal(command, "gh"); assert.equal(cwd, snapshot.root); calls.push(args);
		return { code: 0, stdout: JSON.stringify([{ number: 7, title: "Native UI", author: { login: "ada" }, labels: [{ name: "ui" }], url: "https://github.com/example/repo/issues/7", isDraft: true, headRefName: "feature", baseRefName: "main", reviewDecision: "REVIEW_REQUIRED" }]) };
	};
	for (const kind of ["issue", "pr"] as const) {
		const value = await readGithub(snapshot, kind, undefined, run);
		assert.equal(value[0]?.number, 7); assert.equal(value[0]?.author, "ada"); assert.deepEqual(value[0]?.labels, ["ui"]);
		assert.equal(value[0]?.draft, true); assert.equal(value[0]?.head, "feature");
	}
	assert.equal(calls.length, 2);
	for (const args of calls) { assert.equal(args[1], "list"); assert.equal(args[args.indexOf("--state") + 1], "open"); assert.equal(args[args.indexOf("--limit") + 1], "100"); assert.ok(!args.includes("--branch")); assert.ok(!args.includes("run")); }
	assert.deepEqual(await readGithub(snapshot, "issue", undefined, async () => ({ code: 0, stdout: "[]" })), []);
	for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "[]", truncated: true }, { code: 0, stdout: "{}" }, { code: 0, stdout: '[{"number":0,"title":"bad"}]' }]) await assert.rejects(readGithub(snapshot, "pr", undefined, async () => result));
});

test("workspace_GitHub sólo lee la descripción del issue/PR pedido al abrir el detalle", async (t) => {
	const main = join(await tempDir(t), "main"); await repo(main); const snapshot = (await readGit(main))!;
	for (const kind of ["issue", "pr"] as const) {
		assert.equal(await readGithubDetail(snapshot, kind, 42, undefined, async (command, args, cwd) => {
			assert.equal(command, "gh"); assert.equal(cwd, snapshot.root); assert.deepEqual(args, [kind, "view", "42", "--json", "body"]);
			return { code: 0, stdout: JSON.stringify({ body: "Descripción\ncompleta" }) };
		}), "Descripción\ncompleta");
	}
	await assert.rejects(readGithubDetail(snapshot, "issue", -1, undefined, async () => { throw new Error("no ejecutar"); }), /Número/);
	await assert.rejects(readGithubDetail(snapshot, "pr", 42, undefined, async () => ({ code: 0, stdout: "{}" })), /no válido/);
	await assert.rejects(readGithubDetail(snapshot, "issue", 42, undefined, async () => ({ code: 0, stdout: "{}", truncated: true })), /demasiado grande/);
});

test("workspace_Git no presenta un status truncado como limpio", async () => {
	const run: ReadCommand = async (_command, args) => args[0] === "status" ? { code: 0, stdout: "", truncated: true } : { code: 0, stdout: args[0] === "rev-parse" ? "/repo\n/repo/.git\n/repo/.git\n" : "" };
	await assert.rejects(readGit("/repo", undefined, run), /estado completo/);
});

test("workspace_preferencias aisladas y guardado atómico con permisos privados", async (t) => {
	const home = await tempDir(t); assert.deepEqual(await loadWorkspacePreferences(home), { favorites: [], sidebar: true });
	await saveWorkspacePreferences(home, { favorites: ["anthropic/model"], sidebar: false }); assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["anthropic/model"], sidebar: false });
	const path = join(agentDir(home), "workspace-ui.json"); assert.ok(JSON.parse(await readFile(path, "utf8")));
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
	await writeFile(path, '{"favorites":[1,"valid"],"sidebar":true}'); assert.deepEqual(await loadWorkspacePreferences(home), { favorites: ["valid"], sidebar: true });
	await writeFile(path, "broken"); assert.deepEqual(await loadWorkspacePreferences(home), { favorites: [], sidebar: true });
});
