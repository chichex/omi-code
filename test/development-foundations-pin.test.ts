import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, foundationsHash, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { readTrust, trustPath, writeTrust } from "../src/harness/foundations-trust.ts";
import { FoundationsGate, decideFoundations, effectivePolicy, foundationsLines, readFoundations, type FoundationsPin } from "../src/tui/development-foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";

const value: FoundationsBlock = { version: 2, repo: "test/repo", confirmar: [], politica: { ...STRICT_POLICY } };
const key = { kbUrl: "https://kb.test/mcp", product: "repo", repo: "test/repo" };
const perillas = { id: "doc", titulo: "Perillas", cuerpo: renderFoundationsBlock(value), producto: "repo", tipo: "perillas" as const };
const reading = { kind: "valid" as const, key, block: value, hash: foundationsHash(value), perillas };
const pin = (): FoundationsPin => ({ version: 2, origin: "kb", block: value, hash: reading.hash, docId: "doc", author: "", date: "", notice: "", reading });
const ctx = { hasUI: true } as ExtensionContext; // Frontera UI mínima: decideFoundations sólo usa hasUI y confirm inyectado.
const strict = (candidate: unknown) => {
	const policy = Reflect.apply(effectivePolicy, undefined, [candidate]);
	assert.deepEqual(policy, { politica: STRICT_POLICY, command: { block: null, accepted: false }, hash: null });
};
test("foundations_pin: pins legacy/invalid/hash alterado/estrictos nunca autoautorizan ni crashean", () => {
	const legacy = { version: 1, repo: "test/repo", comandos: ["npm test"], politica: { ...STRICT_POLICY, fuera_de_catalogo: "auto" } };
	for (const candidate of [undefined, { ...pin(), version: 1 }, { ...pin(), block: legacy }, { ...pin(), block: { ...value, confirmar: [""] } }, { ...pin(), hash: "0".repeat(64) }, { ...pin(), origin: "strict" }, { ...pin(), reading: { ...reading, hash: "otro" } }]) strict(candidate);
	assert.deepEqual(effectivePolicy(pin()).command, { block: value, accepted: true });
	assert.match(foundationsLines({ ...pin(), version: 1 } as never).join("\n"), /obsoleto|configur/i);
});
test("foundations_pin: resumen vertical distingue lista vacía aceptada de política estricta", () => {
	assert.match(foundationsLines(pin()).join("\n"), /todo comando SIMPLE sin confirmación por esta política/);
	const rules = { ...value, confirmar: ["git push *", "npm publish"] }; const hash = foundationsHash(rules);
	const rows = foundationsLines({ ...pin(), block: rules, hash, reading: { ...reading, block: rules, hash } });
	assert.ok(rows.includes("  git push *")); assert.ok(rows.includes("  npm publish"));
	assert.ok(rows.includes("  arranque: ask")); assert.ok(rows.includes("  receta: ask")); assert.ok(rows.includes("  push + PR draft: ask"));
	assert.ok(!rows.some((row) => row.includes(" | ")));
});
test("foundations_pin: nueva revisión sólo se acepta con sí explícito durable; no o error dejan todo-pregunta", async (t) => {
	for (const answer of [false, true]) {
		const dir = await tempDir(t); const prompts: string[] = [];
		const result = await decideFoundations(reading, ctx, { trustDir: dir, now: () => "now", confirm: async (_ctx, _title, detail) => { prompts.push(detail); return answer; } });
		assert.equal(prompts.length, 1); assert.match(prompts[0]!, /todo comando SIMPLE.*sin confirmación por esta política/);
		assert.equal(effectivePolicy(result).command.accepted, answer);
		assert.equal((await readTrust(dir, key))?.accepted?.blockHash ?? null, answer ? reading.hash : null);
	}
});
test("foundations_pin: missing/invalid/unavailable/no aceptada fallan cerrados incluso con aceptación anterior", async (t) => {
	const dir = await tempDir(t);
	await writeTrust(dir, { version: 2, ...key, accepted: { docId: "old", blockHash: reading.hash, block: value, author: "", date: "", acceptedAt: "now" }, offerDeclined: false });
	for (const next of [{ kind: "missing" as const, key, perillas: null }, { kind: "invalid" as const, key, perillas, reason: "Foundations v1 obsoleto" }, { kind: "unavailable" as const, key, reason: "sin KB" }]) {
		const result = await decideFoundations(next, ctx, { trustDir: dir, now: () => "now", confirm: async () => { assert.fail("no hay revisión válida para aceptar"); } });
		strict(result);
	}
	const newer = { ...value, confirmar: ["git push *"] };
	const rejected = await decideFoundations({ ...reading, block: newer, hash: foundationsHash(newer) }, ctx, { trustDir: dir, now: () => "now", confirm: async () => false });
	strict(rejected);
});
test("foundations_pin: lectura legacy conservada y aceptación v1 nunca se convierten en lista vacía aceptada", async (t) => {
	const dir = await tempDir(t); await mkdir(dir, { recursive: true });
	const raw = JSON.stringify({ version: 1, ...key, accepted: null, offerDeclined: false });
	await writeFile(trustPath(dir, key), raw);
	let confirmations = 0;
	const checked = checkBlock({ version: 1 }); assert.ok("reason" in checked);
	const oldReading = { ...reading, block: { version: 1, repo: "test/repo", comandos: [] } };
	const result = await Reflect.apply(decideFoundations, undefined, [oldReading, ctx, { trustDir: dir, now: () => "now", confirm: async () => { confirmations++; return true; } }]);
	strict(result); assert.equal(confirmations, 0); assert.equal(await readFile(trustPath(dir, key), "utf8"), raw);
});
test("foundations_pin: leer para abrir panel no acepta, no escribe KB ni confianza", async (t) => {
	const dir = await tempDir(t); const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", perillas.cuerpo);
	const runner = { run: async () => ({ code: 0, stdout: "https://github.com/test/repo.git\n", stderr: "" }) };
	let accepted = 0;
	const gate = new FoundationsGate({ kb, runner, trustDir: dir, now: () => "now", confirm: async () => { accepted++; return true; } });
	const context = { cwd: "/tmp", sessionManager: { getSessionFile: () => "/tmp/session-test-pin" } } as ExtensionContext;
	const result = await gate.read(context, new AbortController().signal);
	assert.equal(result.kind, "valid"); assert.equal(accepted, 0); assert.equal(gate.current(context), undefined);
	assert.ok(!kb.calls.some((call) => call.tool === "guardar")); assert.equal(await readTrust(dir, { ...key, kbUrl: kb.url }), undefined);
	assert.equal((await readFoundations(undefined, "/tmp", runner, new AbortController().signal)).kind, "unavailable");
});
