import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { commandAuthorization, matchesAllowedPrefix } from "../src/harness/authorization.ts";
import { commandPrefix, MAX_ALLOWED, prefixLabel } from "../src/harness/command-allow.ts";
import { addAllowedPrefix, readAllowedPrefixes, removeAllowedPrefix } from "../src/harness/command-allow-store.ts";
import { STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { sourceHash } from "../src/harness/model.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { tempDir } from "./helpers/io.ts";

// Pedido del dueño (2026-11-24): «Sí, y no volver a preguntar por git log *», como Claude Code, para no aprobar cada variante.
const state = () => createWorkflow({ number: 7, title: "T", body: "B", url: "https://github.com/test/repo/issues/7", hash: sourceHash("T", "B") }, { root: "/tmp/t", commonDir: "/tmp/.git", branch: "feat/t", baseCommit: "a".repeat(40) }, "work", "now");
const block = (confirmar: string[]): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...STRICT_POLICY } });
const key = { kbUrl: "https://kb.test/mcp", product: "repo", repo: "test/repo" };

test("command_allow: el prefijo propuesto es programa y subcomando, con el script de npm run y el módulo de -m", () => {
	const cases: [string, string][] = [
		["git log --oneline origin/main..HEAD", "git log"], ["git status", "git status"], ["make", "make"], ["npm test", "npm test"],
		["npm run typecheck", "npm run typecheck"], ["pnpm exec tsc --noEmit", "pnpm exec tsc"], ["bun x prettier --check .", "bun x prettier"],
		["node scripts/gate-commits.ts origin/main", "node scripts/gate-commits.ts"], ["python3 -m pytest test/a.py", "python3 -m pytest"], ["node --test test/a.test.ts", "node --test"],
	];
	for (const [command, prefix] of cases) assert.equal(commandPrefix(command), prefix, command);
	assert.equal(prefixLabel("git log"), "git log *");
});
test("command_allow: un comando compuesto, con comillas o con VAR= no propone prefijo", () => {
	for (const command of ['echo "texto"', "git log | head", "npm test && git push origin main", "VAR=x npm test", "echo $(id)", "if npm test", "", " npm test"]) assert.equal(commandPrefix(command), undefined, command);
});
test("command_allow: un prefijo cubre el comando igual o con más argumentos, token por token, y nunca otra sintaxis", () => {
	assert.equal(matchesAllowedPrefix("git log", "git log"), true);
	assert.equal(matchesAllowedPrefix("git log", "git log --oneline -5"), true);
	for (const command of ["git logs", "git", "git  log x", "git log | head", "git log; rm -rf x", 'git log "x"', "Git log", "git log\nrm x"]) assert.equal(matchesAllowedPrefix("git log", command), false, command);
	for (const prefix of ["", "git log *", "git log;", " git log"]) assert.equal(matchesAllowedPrefix(prefix, "git log x"), false, `prefijo ${JSON.stringify(prefix)}`);
});
test("command_allow: un prefijo permitido gana sobre una regla sólo para comandos simples y nunca sin Foundations aceptada", () => {
	const policy = (allow: string[], rules = ["git *"], accepted = true) => ({ block: block(rules), accepted, allow });
	assert.equal(commandAuthorization(state(), "git log --oneline", policy(["git log"])), "allowed");
	assert.equal(commandAuthorization(state(), "git push origin main", policy(["git log"])), "ask", "otro prefijo sigue preguntando");
	assert.equal(commandAuthorization(state(), "git log | head", policy(["git log"])), "ask", "lo compuesto sigue preguntando con reglas");
	assert.equal(commandAuthorization(state(), "npm test", policy(["git log"])), "auto", "simple no coincidente, como siempre");
	assert.equal(commandAuthorization(state(), "git log", policy(["git log"], [])), "auto", "sin reglas no pregunta nada");
	assert.equal(commandAuthorization(state(), "git log", policy(["git log"], ["git *"], false)), "auto", "sin v2 aceptada, el default");
	assert.equal(commandAuthorization(state(), "git log", { block: block(["git *"]), accepted: true }), "ask", "sin prefijos, la regla pregunta");
});
test("command_allow_store: agrega, no duplica, quita y separa por KB, producto y repo", async (t) => {
	const dir = join(await tempDir(t), "command-allow");
	assert.deepEqual(await readAllowedPrefixes(dir, key), []);
	await addAllowedPrefix(dir, key, "git log"); await addAllowedPrefix(dir, key, "npm run typecheck"); await addAllowedPrefix(dir, key, "git log");
	assert.deepEqual(await readAllowedPrefixes(dir, key), ["git log", "npm run typecheck"]);
	assert.deepEqual(await readAllowedPrefixes(dir, { ...key, repo: "test/otro" }), [], "otro repo no hereda");
	assert.deepEqual(await readAllowedPrefixes(dir, { ...key, kbUrl: "https://otra.kb/mcp" }), [], "otra KB no hereda");
	await removeAllowedPrefix(dir, key, "git log");
	assert.deepEqual(await readAllowedPrefixes(dir, key), ["npm run typecheck"]);
	await removeAllowedPrefix(dir, key, "no estaba");
	assert.deepEqual(await readAllowedPrefixes(dir, key), ["npm run typecheck"]);
});
test("command_allow_store: rechaza prefijos que no son simples y respeta el máximo", async (t) => {
	const dir = join(await tempDir(t), "command-allow");
	for (const prefix of ["", "git log | head", 'echo "x"', "VAR=x npm", "git log *"]) await assert.rejects(addAllowedPrefix(dir, key, prefix), /no es un prefijo simple/, prefix);
	for (let index = 0; index < MAX_ALLOWED; index++) await addAllowedPrefix(dir, key, `tool-${index}`);
	await assert.rejects(addAllowedPrefix(dir, key, "uno-mas"), /máximo de 100/);
	assert.equal((await readAllowedPrefixes(dir, key)).length, MAX_ALLOWED);
});
test("command_allow_store: un archivo roto, ajeno o un symlink cuentan como nada permitido y no se siguen", async (t) => {
	const home = await tempDir(t), dir = join(home, "command-allow");
	await addAllowedPrefix(dir, key, "git log");
	const target = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json"))!);
	const saved = JSON.parse(await readFile(target, "utf8"));
	await writeFile(target, JSON.stringify({ ...saved, repo: "test/otro" }));
	assert.deepEqual(await readAllowedPrefixes(dir, key), [], "un registro de otro repo no vale");
	await writeFile(target, "{ roto");
	assert.deepEqual(await readAllowedPrefixes(dir, key), []);
	await writeFile(target, JSON.stringify({ ...saved, prefixes: ["git log", "rm -rf /; echo"] }));
	assert.deepEqual(await readAllowedPrefixes(dir, key), [], "un prefijo que no es simple invalida el registro entero");
	const linked = join(home, "linked"); await mkdir(join(home, "real"));
	await symlink(join(home, "real"), linked);
	await assert.rejects(addAllowedPrefix(linked, key, "git log"), /inseguro/);
	assert.deepEqual(await readAllowedPrefixes(linked, key), []);
});
