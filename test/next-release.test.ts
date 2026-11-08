import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { isPackaged, latestVersion, nextVersion, parseLog, type Commit } from "../scripts/next-release.ts";
import { tempDir } from "./helpers/io.ts";

const script = fileURLToPath(new URL("../scripts/next-release.ts", import.meta.url));
const commit = (message: string, ...files: string[]): Commit => ({ message, files });

test("isPackaged_distingue lo que entra en el binario", () => {
	for (const path of ["src/cli/main.ts", "bin/omi.ts", "extensions/subagent/agents/x.md", "skills/ship/SKILL.md", "themes/omi.json", "package.json", "package-lock.json", "tsconfig.json", "install.sh", "scripts/build-release.ts"]) {
		assert.equal(isPackaged(path), true, path);
	}
	for (const path of [".chiche/project.md", "docs/x.md", "README.md", "test/x.test.ts", "extensions/subagent/jobs.test.ts", ".github/workflows/ci.yml", "scripts/next-release.ts", "LICENSE", "srcs/x.ts"]) {
		assert.equal(isPackaged(path), false, path);
	}
});

test("nextVersion_sin cambios empaquetados no publica", () => {
	assert.equal(nextVersion("0.1.0", [commit("docs(review): evidencia", ".chiche/evidence/x.md")]), null);
	assert.equal(nextVersion("0.1.0", [commit("test(cli): cubre x", "test/x.test.ts")]), null);
	assert.equal(nextVersion("0.1.0", []), null);
});

test("nextVersion_decide el nivel por tipo de commit", () => {
	assert.equal(nextVersion("0.1.0", [commit("fix(cli): x", "src/a.ts")]), "0.1.1");
	assert.equal(nextVersion("0.1.1", [commit("feat(tools): x", "src/a.ts")]), "0.2.0");
	assert.equal(nextVersion("0.1.0", [commit("fix: x", "src/a.ts"), commit("feat: y", "src/b.ts")]), "0.2.0");
});

test("nextVersion_lo empaquetado manda sobre el tipo del commit", () => {
	assert.equal(nextVersion("0.1.0", [commit("chore: subir Pi a 1.6.0", "package.json", "package-lock.json")]), "0.1.1");
	assert.equal(nextVersion("0.1.0", [commit("docs(skills): aclara ship", "skills/ship/SKILL.md")]), "0.1.1");
	assert.equal(nextVersion("0.1.0", [commit("mensaje sin formato", "src/a.ts")]), "0.1.1");
});

test("nextVersion_un feat que no toca el binario no sube el minor", () => {
	assert.equal(nextVersion("0.1.0", [commit("feat(ci): x", ".github/workflows/ci.yml"), commit("fix(cli): y", "src/a.ts")]), "0.1.1");
});

test("nextVersion_lo incompatible antes de 1.0 sube el minor", () => {
	assert.equal(nextVersion("0.3.2", [commit("feat!: x", "src/a.ts")]), "0.4.0");
	assert.equal(nextVersion("0.3.2", [commit("fix(cli)!: x", "src/a.ts")]), "0.4.0");
	assert.equal(nextVersion("0.3.2", [commit("fix: x\n\nBREAKING CHANGE: y", "src/a.ts")]), "0.4.0");
});

test("nextVersion_lo incompatible desde 1.0 sube el major", () => {
	assert.equal(nextVersion("1.2.3", [commit("feat!: x", "src/a.ts")]), "2.0.0");
	assert.equal(nextVersion("1.2.3", [commit("feat: x", "src/a.ts")]), "1.3.0");
});

test("nextVersion_force publica al menos un patch", () => {
	assert.equal(nextVersion("0.1.0", [], true), "0.1.1");
	assert.equal(nextVersion("0.1.0", [commit("feat: x", "src/a.ts")], true), "0.2.0");
});

test("latestVersion_compara numéricamente e ignora otros tags", () => {
	assert.equal(latestVersion(["v0.9.0", "v0.10.0", "v0.2.5", ""]), "0.10.0");
	assert.equal(latestVersion(["v1.0.0-rc.1", "api/v9.9.9", "vieja", "v0.1.0"]), "0.1.0");
	assert.equal(latestVersion(["vieja"]), null);
});

test("parseLog_separa mensaje y archivos", () => {
	const raw = "\x1efeat: x\n\nBREAKING CHANGE: y\n\x1f\n\nsrc/a.ts\nsrc/b.ts\n\x1edocs: z\n\x1f\n\ndocs/c.md\n";
	assert.deepEqual(parseLog(raw), [
		{ message: "feat: x\n\nBREAKING CHANGE: y", files: ["src/a.ts", "src/b.ts"] },
		{ message: "docs: z", files: ["docs/c.md"] },
	]);
	assert.deepEqual(parseLog(""), []);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
	});
}

async function commitFile(repo: string, path: string, message: string): Promise<void> {
	await mkdir(dirname(join(repo, path)), { recursive: true });
	await writeFile(join(repo, path), `${message}\n`);
	git(repo, "add", ".");
	git(repo, "commit", "-m", message);
}

async function repoWithTag(t: TestContext): Promise<string> {
	const repo = await tempDir(t);
	git(repo, "init", "-b", "main");
	await commitFile(repo, "src/a.ts", "feat: inicio");
	git(repo, "tag", "v0.1.0");
	return repo;
}

const plan = (repo: string, ...args: string[]): string => execFileSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });

test("next-release_sin commits después del tag no publica", async (t) => {
	assert.equal(plan(await repoWithTag(t)), "version=\n");
});

test("next-release_con sólo docs no publica", async (t) => {
	const repo = await repoWithTag(t);
	await commitFile(repo, ".chiche/evidence/x.md", "docs(review): evidencia");
	assert.equal(plan(repo), "version=\n");
});

test("next-release_calcula la versión desde el último tag", async (t) => {
	const repo = await repoWithTag(t);
	await commitFile(repo, "src/b.ts", "fix(cli): x");
	assert.equal(plan(repo), "version=0.1.1\n");
	git(repo, "tag", "v0.1.1");
	assert.equal(plan(repo), "version=\n");
	await commitFile(repo, "skills/ship/SKILL.md", "feat(skills): y");
	assert.equal(plan(repo), "version=0.2.0\n");
});

test("next-release_lee los commits de un PR mergeado e ignora el merge", async (t) => {
	const repo = await repoWithTag(t);
	git(repo, "switch", "-c", "rama");
	await commitFile(repo, "src/b.ts", "feat(tools): x");
	git(repo, "switch", "main");
	await commitFile(repo, "docs/c.md", "docs: z");
	git(repo, "merge", "--no-ff", "-m", "Merge pull request #1 from chichex/rama", "rama");
	assert.equal(plan(repo), "version=0.2.0\n");
});

test("next-release_force fuerza un patch sin cambios empaquetados", async (t) => {
	assert.equal(plan(await repoWithTag(t), "--force"), "version=0.1.1\n");
});

test("next-release_falla si no hay tags en vez de inventar una versión", async (t) => {
	const repo = await tempDir(t);
	git(repo, "init", "-b", "main");
	await commitFile(repo, "src/a.ts", "feat: inicio");
	const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no hay tags/);
});
