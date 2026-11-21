import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, foundationsHash, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { readTrust, writeTrust } from "../src/harness/foundations-trust.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { FoundationsGate, readFoundations, type FoundationsPin } from "../src/tui/development-foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
const block = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...STRICT_POLICY } });
const signal = () => new AbortController().signal;

test("foundations_concurrency: un retry no publica sobre una revisión concurrente aparecida durante el primer fallo", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", "Documento A");
	const key = { kbUrl: kb.url, product: "repo", repo: "test/repo" }; const dir = await tempDir(t);
	const prepared = await prepareFoundationsSave(kb, key, block(), signal()); let first = true;
	kb.hook = (tool) => { if (tool === "guardar" && first) { first = false; kb.perillas("repo", "Documento B concurrente"); return "error"; } };
	await assert.rejects(commitFoundationsSave(kb, key, block(), prepared, { trustDir: dir, now: () => "now", signal: signal() }), /cambi|concurr|confirm/i);
	assert.equal(kb.calls.filter((call) => call.tool === "guardar").length, 1, "no reenvía una propuesta sobre una base que ya cambió");
	assert.equal(kb.documents.at(-1)?.cuerpo, "Documento B concurrente");
	assert.equal(await readTrust(dir, key), undefined);
});
test("foundations_concurrency: tamaño ilegible se rechaza antes de enviar a KB, incluidos escapes JSON", async (t) => {
	const rules = Array.from({ length: 100 }, (_, index) => `${index}-` + "\\".repeat(1996));
	assert.ok("block" in checkBlock(block(rules)), "las reglas en sí respetan el contrato, el límite es el documento de KB");
	for (const [body, value] of [["x".repeat(399_950), block()], ["# Perillas\n", block(rules)]] as const) {
		const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", body);
		const key = { kbUrl: kb.url, product: "repo", repo: "test/repo" };
		await assert.rejects(prepareFoundationsSave(kb, key, value, signal()), /tamaño|400.?000|grande|límite/i);
		assert.equal(kb.calls.filter((call) => call.tool === "guardar").length, 0);
	}
});
test("foundations_concurrency: ningún modo interno puede aceptar un guardado que ya dejó de ser vigente", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", "Base");
	const key = { kbUrl: kb.url, product: "repo", repo: "test/repo" }; const dir = await tempDir(t);
	const prepared = await prepareFoundationsSave(kb, key, block(), signal()); let changed = false;
	kb.hook = (tool) => { if (tool === "buscar" && !changed && kb.calls.some((call) => call.tool === "guardar")) { changed = true; kb.perillas("repo", "Revisión externa más nueva"); } };
	await assert.rejects(() => Reflect.apply(commitFoundationsSave, undefined, [kb, key, block(), prepared, { trustDir: dir, now: () => "now", signal: signal(), requireLatest: false }]), /cambi|nueva|vigente/i);
	assert.equal(await readTrust(dir, key), undefined);
});
for (const response of [false, true]) test(`foundations_concurrency: una aceptación pendiente (${response}) no pisa un pin guardado ni su confianza durable`, async (t) => {
	const dir = await tempDir(t); const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", renderFoundationsBlock(block()));
	const runner = { run: async () => ({ code: 0, stdout: "https://github.com/test/repo.git\n", stderr: "" }) };
	let answer: (value: boolean) => void = () => { throw new Error("falta diálogo"); };
	const waiting = new Promise<boolean>((resolve) => { answer = resolve; });
	let opened: () => void = () => { throw new Error("falta señal"); };
	const shown = new Promise<void>((resolve) => { opened = resolve; });
	const gate = new FoundationsGate({ kb, runner, trustDir: dir, now: () => "now", confirm: async () => { opened(); return waiting; } });
	const ctx = { cwd: dir, hasUI: true, sessionManager: { getSessionFile: () => `${dir}/session` } } as ExtensionContext;
	const pending = gate.pin(ctx); await shown;
	const next = block(["git push *"]); kb.perillas("repo", renderFoundationsBlock(next));
	const reading = await readFoundations(kb, dir, runner, signal()); assert.equal(reading.kind, "valid"); assert.ok(reading.kind === "valid");
	const key = reading.key; const hash = foundationsHash(next);
	const saved: FoundationsPin = { version: 2, origin: "kb", block: next, hash, docId: reading.perillas.id, author: "", date: "", notice: "", reading };
	await writeTrust(dir, { version: 2, ...key, accepted: { docId: reading.perillas.id, blockHash: hash, block: next, author: "", date: "", acceptedAt: "now" }, offerDeclined: false });
	gate.replace(ctx, saved); answer(response);
	assert.equal((await pending).hash, hash); assert.equal(gate.current(ctx)?.hash, hash);
	assert.equal((await readTrust(dir, key))?.accepted?.blockHash, hash);
});
