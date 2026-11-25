import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isSimpleCommand } from "../src/harness/authorization.ts";
import { tempDir } from "./helpers/io.ts";

// Los gates de AGENTS.md como scripts: comandos simples que Foundations no frena por sintaxis.
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
async function repo(t: TestContext) {
	const root = await tempDir(t);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false");
	const commit = async (subject: string, files: Record<string, string> = { [`f-${subject.length}-${Math.abs(hash(subject))}.txt`]: subject }) => {
		for (const [file, content] of Object.entries(files)) { await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), content); }
		git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", subject);
	};
	await commit("chore: base");
	const base = git("rev-parse", "HEAD");
	const run = (name: string, ...args: string[]) => {
		const result = spawnSync(process.execPath, [script(name), ...args], { cwd: root, encoding: "utf8" });
		return { code: result.status, out: `${result.stdout}${result.stderr}` };
	};
	return { root, git, commit, base, run };
}
function hash(text: string): number { let value = 0; for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0; return value; }
const lines = (count: number) => "x\n".repeat(count);

test("gate_scripts: commits convencionales pasan y uno inválido falla mostrándolo", async (t) => {
	const r = await repo(t);
	await r.commit("feat(harness): algo nuevo"); await r.commit("fix: arreglo"); await r.commit("refactor!: cambio grande");
	let result = r.run("gate-commits.ts", r.base);
	assert.equal(result.code, 0, result.out); assert.match(result.out, /CONVENTIONAL_COMMITS=PASS/);
	await r.commit("arreglé cosas"); await r.commit("Feat: mayúscula");
	result = r.run("gate-commits.ts", r.base);
	assert.equal(result.code, 1, result.out); assert.match(result.out, /arreglé cosas/); assert.match(result.out, /Feat: mayúscula/);
	assert.doesNotMatch(result.out, /PASS/); assert.doesNotMatch(result.out, /feat\(harness\): algo nuevo/, "sólo lista los inválidos");
});
test("gate_scripts: un merge no cuenta como commit y un rango vacío pasa", async (t) => {
	const r = await repo(t);
	assert.equal(r.run("gate-commits.ts", r.base).code, 0, "sin commits nuevos");
	r.git("checkout", "-q", "-b", "lado"); await r.commit("feat: del lado");
	r.git("checkout", "-q", "main"); await r.commit("fix: en main");
	r.git("merge", "-q", "--no-ff", "-m", "Merge branch 'lado'", "lado");
	const result = r.run("gate-commits.ts", r.base);
	assert.equal(result.code, 0, result.out);
});
test("gate_scripts: más de 500 líneas en un .ts que no es test falla; tests, otros tipos y borrados no cuentan", async (t) => {
	const r = await repo(t);
	await r.commit("chore: viejo", { "src/borrar.ts": lines(600) });
	const base = r.git("rev-parse", "HEAD");
	await rm(join(r.root, "src/borrar.ts")); r.git("add", "-A"); r.git("commit", "-q", "-m", "chore: borrar");
	await r.commit("feat: archivos", { "src/justo.ts": lines(500), "test/largo.test.ts": lines(900), "docs/largo.md": lines(900), "src/configuración.ts": lines(10) });
	let result = r.run("gate-max-lines.ts", base);
	assert.equal(result.code, 0, result.out); assert.match(result.out, /MAX_LINES=PASS/);
	await r.commit("feat: largo", { "src/largo.ts": lines(501), "src/acción.ts": lines(600) });
	result = r.run("gate-max-lines.ts", base);
	assert.equal(result.code, 1, result.out);
	const nested = spawnSync(process.execPath, [script("gate-max-lines.ts"), base], { cwd: join(r.root, "docs"), encoding: "utf8" });
	assert.equal(nested.status, 1, "desde un subdirectorio mide los mismos archivos"); assert.match(nested.stdout, /FALLA src\/largo\.ts/); assert.match(result.out, /FALLA src\/largo\.ts \(501 > 500\)/); assert.match(result.out, /FALLA src\/acción\.ts \(600 > 500\)/, "una ruta con acento se mide, no se escapa"); assert.doesNotMatch(result.out, /justo|largo\.test|PASS/);
});
test("gate_scripts: una base inválida o ausente falla sin decir PASS", async (t) => {
	const r = await repo(t);
	for (const name of ["gate-commits.ts", "gate-max-lines.ts"]) {
		const invalid = r.run(name, "no-existe");
		assert.equal(invalid.code, 1, invalid.out); assert.match(invalid.out, /BASE inválido: no-existe/);
		const missing = r.run(name);
		assert.equal(missing.code, 2, missing.out); assert.match(missing.out, /Uso: node scripts\//); assert.doesNotMatch(`${invalid.out}${missing.out}`, /PASS/);
	}
});
test("gate_scripts: invocados con una base son comandos simples para Foundations", () => {
	for (const command of ["node scripts/gate-commits.ts origin/main", "node scripts/gate-max-lines.ts 9aa9da8a81b59109101988ecf099ccd032ec1038"]) assert.equal(isSimpleCommand(command), true, command);
});
