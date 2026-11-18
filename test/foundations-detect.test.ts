import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { detectFoundationsCandidates, proposeFoundations } from "../src/harness/foundations-detect.ts";
import { checkBlock } from "../src/harness/foundations.ts";
import { tempDir } from "./helpers/io.ts";

const scripts = { omi: "node bin/omi.ts", test: "node --test", typecheck: "tsc", lint: "eslint .", "lint:fix": "eslint --fix .", "test:e2e": "playwright", deploy: "rm -rf /", postinstall: "touch pwned", "test; rm -rf /": "x", "format:check": "prettier --check .", "format": "prettier -w ." };
/** Sólo los comandos, en el orden en que se proponen. */
const detectFoundationsCommands = async (root: string) => (await detectFoundationsCandidates(root)).map((entry) => entry.command);
async function project(t: import("node:test").TestContext, files: Record<string, string>): Promise<string> {
	const root = await tempDir(t);
	for (const [name, body] of Object.entries(files)) { await mkdir(join(root, name, ".."), { recursive: true }); await writeFile(join(root, name), body); }
	return root;
}

for (const [lock, install, run, testCommand] of [
	["package-lock.json", "npm ci", "npm run", "npm test"],
	["pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm run", "pnpm test"],
	["yarn.lock", "yarn install --frozen-lockfile", "yarn run", "yarn test"],
	["bun.lock", "bun install --frozen-lockfile", "bun run", "bun run test"],
] as const) test(`foundations_detect: ${lock} elige el gestor y sus scripts`, async (t) => {
	const root = await project(t, { "package.json": JSON.stringify({ scripts }), [lock]: "" });
	assert.deepEqual(await detectFoundationsCommands(root), [install, testCommand, `${run} typecheck`, `${run} lint`, `${run} lint:fix`, `${run} test:e2e`, `${run} format:check`]);
});

test("foundations_detect: sin lockfile usa npm sin instalar", async (t) => {
	const root = await project(t, { "package.json": JSON.stringify({ scripts: { test: "x", build: "y", check: "z" } }) });
	assert.deepEqual(await detectFoundationsCommands(root), ["npm test", "npm run build", "npm run check"]);
});

test("foundations_detect: Go", async (t) => {
	const root = await project(t, { "go.mod": "module example.test/x\n" });
	assert.deepEqual(await detectFoundationsCandidates(root), [
		{ command: "go test ./...", source: "Tests del módulo de go.mod" },
		{ command: "go vet ./...", source: "Análisis estático del módulo de go.mod" },
	]);
});

test("foundations_detect: cada comando dice de dónde sale: el lockfile o el script de package.json", async (t) => {
	const root = await project(t, { "package.json": JSON.stringify({ scripts: { test: "x", "test:e2e": "y", deploy: "z" } }), "pnpm-lock.yaml": "" });
	assert.deepEqual(await detectFoundationsCandidates(root), [
		{ command: "pnpm install --frozen-lockfile", source: "Instala las dependencias según pnpm-lock.yaml" },
		{ command: "pnpm test", source: "Script «test» de package.json" },
		{ command: "pnpm run test:e2e", source: "Script «test:e2e» de package.json" },
	]);
	const both = await project(t, { "package.json": JSON.stringify({ scripts: { lint: "x" } }), "go.mod": "module x\n" });
	assert.deepEqual((await detectFoundationsCandidates(both)).map((entry) => entry.source), ["Script «lint» de package.json", "Tests del módulo de go.mod", "Análisis estático del módulo de go.mod"], "sin lockfile no se propone instalar");
});

test("foundations_detect: nada que detectar, package.json roto o enorme no proponen comandos", async (t) => {
	assert.deepEqual(await detectFoundationsCommands(await project(t, {})), []);
	assert.deepEqual(await detectFoundationsCommands(await project(t, { "package.json": "{ roto" })), []);
	assert.deepEqual(await detectFoundationsCommands(await project(t, { "package.json": JSON.stringify({ scripts: [1, 2] }) })), []);
	assert.deepEqual(await detectFoundationsCommands(await project(t, { "package.json": JSON.stringify({ scripts: { test: "x" }, pad: "x".repeat(2 * 1024 * 1024) }) })), []);
});

test("foundations_detect: sólo lee archivos, nunca ejecuta un script", async (t) => {
	const root = await project(t, { "package.json": JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran','1')\"", preinstall: "touch ran" } }), "package-lock.json": "{}" });
	assert.deepEqual(await detectFoundationsCommands(root), ["npm ci", "npm test"]);
	await assert.rejects(access(join(root, "ran")));
});

test("foundations_detect: este repo propone sus cuatro comandos y todo en ask", async () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const commands = await detectFoundationsCommands(root);
	assert.deepEqual([...commands].sort(), ["npm ci", "npm run test:packaging", "npm run typecheck", "npm test"]);
	const block = proposeFoundations("chichex/omi-code", commands);
	assert.deepEqual(checkBlock(block), { block });
	assert.deepEqual(block.politica, { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" });
});
