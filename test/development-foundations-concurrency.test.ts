import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, foundationsHash, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { readTrust, writeTrust } from "../src/harness/foundations-trust.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { FoundationsGate } from "../src/tui/development-foundations.ts";
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
/** La lectura inicial de la sesión (A) queda retenida hasta `release`; las demás pasan. */
function slowFirstRead(kb: ReturnType<typeof memoryKb>) {
	const current = kb.currentPerillas.bind(kb); let release: () => void = () => { throw new Error("falta la lectura A"); };
	const held = new Promise<void>((resolve) => { release = resolve; }); let started: () => void = () => {};
	const reading = new Promise<void>((resolve) => { started = resolve; }); let first = true;
	kb.currentPerillas = async (product, abort) => {
		if (first) { first = false; const value = await current(product, abort); started(); await held; return value; }
		return current(product, abort);
	};
	return { release: () => release(), reading };
}
for (const order of ["antes de reemplazar el pin", "después de reemplazar el pin"] as const) test(`foundations_concurrency: una decisión automática pendiente no pisa la confianza ni el pin de un Guardar (${order})`, async (t) => {
	const dir = await tempDir(t); const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", renderFoundationsBlock(block()));
	const runner = { run: async () => ({ code: 0, stdout: "https://github.com/test/repo.git\n", stderr: "" }) };
	const gate = new FoundationsGate({ kb, runner, trustDir: dir, now: () => "now" });
	const ctx = { cwd: dir, hasUI: true, ui: { notify() {} }, sessionManager: { getSessionFile: () => `${dir}/race-session` } } as unknown as ExtensionContext;
	const slow = slowFirstRead(kb); const pending = gate.pin(ctx); await slow.reading;
	const key = { kbUrl: kb.url, product: "repo", repo: "test/repo" }; const next = block(["git push *"]);
	const prepared = await prepareFoundationsSave(kb, key, next, signal());
	// Como editFoundations: el guardado explícito deja obsoleta la decisión automática pendiente.
	gate.supersede(ctx);
	await commitFoundationsSave(kb, key, next, prepared, { trustDir: dir, now: () => "now", signal: signal(),
		writeAcceptance: async (target, record, options) => {
			await writeTrust(target, record, options);
			// A termina DESPUÉS de la escritura de B y antes de su replace, sin sleeps ni polling.
			if (order === "antes de reemplazar el pin") { slow.release(); await pending; }
		}, onAccepted: (pin) => gate.replace(ctx, pin),
	});
	if (order === "después de reemplazar el pin") { slow.release(); await pending; }
	assert.equal(gate.current(ctx)?.hash, foundationsHash(next));
	assert.equal((await readTrust(dir, key))?.accepted?.blockHash, foundationsHash(next), "A no sobrescribe la aceptación durable de B");
});
