import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, DEFAULT_POLICY, foundationsHash, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { readTrust, trustPath, writeTrust } from "../src/harness/foundations-trust.ts";
import { FoundationsGate, decideFoundations, effectivePolicy, foundationsDetail, foundationsLines, readFoundations, type FoundationsPin } from "../src/tui/development-foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";

const value: FoundationsBlock = { version: 2, repo: "test/repo", confirmar: [], politica: { ...STRICT_POLICY } };
const key = { kbUrl: "https://kb.test/mcp", product: "repo", repo: "test/repo" };
const perillas = { id: "doc", titulo: "Perillas", cuerpo: renderFoundationsBlock(value), producto: "repo", tipo: "perillas" as const };
const reading = { kind: "valid" as const, key, block: value, hash: foundationsHash(value), perillas };
const pin = (): FoundationsPin => ({ version: 2, origin: "kb", block: value, hash: reading.hash, docId: "doc", author: "", date: "", notice: "", reading });
const notices: string[] = [];
const ctx = { hasUI: true, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext; // Frontera UI mínima: decideFoundations sólo avisa.
const byDefault = (candidate: unknown) => {
	const policy = Reflect.apply(effectivePolicy, undefined, [candidate]);
	assert.deepEqual(policy, { politica: DEFAULT_POLICY, command: { block: null, accepted: false }, hash: null });
};
test("foundations_pin: pins legacy/invalid/hash alterado/default nunca aplican reglas ni crashean: vale el default", () => {
	const legacy = { version: 1, repo: "test/repo", comandos: ["npm test"], politica: { ...STRICT_POLICY, fuera_de_catalogo: "auto" } };
	for (const candidate of [undefined, { ...pin(), version: 1 }, { ...pin(), block: legacy }, { ...pin(), block: { ...value, confirmar: [""] } }, { ...pin(), hash: "0".repeat(64) }, { ...pin(), origin: "default" }, { ...pin(), reading: { ...reading, hash: "otro" } }]) byDefault(candidate);
	assert.deepEqual(effectivePolicy(pin()).command, { block: value, accepted: true });
	assert.match(foundationsLines({ ...pin(), version: 1 } as never).join("\n"), /sin configurar/i);
	assert.doesNotMatch(foundationsLines({ ...pin(), version: 1 } as never).join("\n"), /\bv[12]\b|obsolet/i);
});
test("foundations_pin: resumen vertical distingue lista vacía aceptada del default", () => {
	assert.match(foundationsLines(pin()).join("\n"), /ningún comando pide confirmación por esta política/);
	assert.match(foundationsLines(undefined).join("\n"), /se decide en el primer punto/);
	assert.match(foundationsLines({ ...pin(), origin: "default", block: null, hash: null }).join("\n"), /sin configurar: nada pregunta/);
	const rules = { ...value, confirmar: ["git push *", "npm publish"] }; const hash = foundationsHash(rules);
	const rows = foundationsLines({ ...pin(), block: rules, hash, reading: { ...reading, block: rules, hash } });
	assert.ok(rows.includes("  git push *")); assert.ok(rows.includes("  npm publish"));
	assert.ok(rows.includes("  arranque: ask")); assert.ok(rows.includes("  receta: ask")); assert.ok(rows.includes("  push + PR draft: ask"));
	assert.ok(!rows.some((row) => row.includes(" | ")));
});
test("foundations_pin: una revisión v2 nueva se acepta sola, avisa la lista vacía y queda durable", async (t) => {
	const dir = await tempDir(t); notices.length = 0;
	const result = await decideFoundations(reading, ctx, { trustDir: dir, now: () => "now" });
	assert.equal(notices.length, 1); assert.match(notices[0]!, /ningún comando.*pide confirmación por esta política/);
	assert.equal(effectivePolicy(result).command.accepted, true);
	assert.equal((await readTrust(dir, key))?.accepted?.blockHash, reading.hash);
});
test("foundations_pin: missing/invalid/unavailable usan la última v2 aceptada; sin ninguna, el default", async (t) => {
	const failures = [{ kind: "missing" as const, key, perillas: null }, { kind: "invalid" as const, key, perillas, reason: "Foundations v1 obsoleto" }, { kind: "unavailable" as const, key, reason: "sin KB" }];
	const empty = await tempDir(t);
	for (const next of failures) byDefault(await decideFoundations(next, ctx, { trustDir: empty, now: () => "now" }));
	const dir = await tempDir(t);
	await writeTrust(dir, { version: 2, ...key, accepted: { docId: "old", blockHash: reading.hash, block: value, author: "", date: "", acceptedAt: "now" }, deferred: null });
	for (const next of failures) {
		const result = await decideFoundations(next, ctx, { trustDir: dir, now: () => "now" });
		assert.equal(result.origin, "local", next.kind); assert.deepEqual(effectivePolicy(result).command, { block: value, accepted: true }, next.kind);
	}
});
test("foundations_pin: lectura legacy conservada y aceptación v1 nunca se convierten en lista vacía aceptada", async (t) => {
	const dir = await tempDir(t); await mkdir(dir, { recursive: true });
	const raw = JSON.stringify({ version: 1, ...key, accepted: null, offerDeclined: false });
	await writeFile(trustPath(dir, key), raw);
	const checked = checkBlock({ version: 1 }); assert.ok("reason" in checked);
	const oldReading = { ...reading, block: { version: 1, repo: "test/repo", comandos: [] } };
	const result = await Reflect.apply(decideFoundations, undefined, [oldReading, ctx, { trustDir: dir, now: () => "now" }]);
	byDefault(result); assert.equal(await readFile(trustPath(dir, key), "utf8"), raw);
});
test("foundations_pin: leer para abrir panel no acepta, no escribe KB ni confianza", async (t) => {
	const dir = await tempDir(t); const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", perillas.cuerpo);
	const runner = { run: async () => ({ code: 0, stdout: "https://github.com/test/repo.git\n", stderr: "" }) };
	const gate = new FoundationsGate({ kb, runner, trustDir: dir, now: () => "now" });
	const context = { cwd: "/tmp", sessionManager: { getSessionFile: () => "/tmp/session-test-pin" } } as ExtensionContext;
	const result = await gate.read(context, new AbortController().signal);
	assert.equal(result.kind, "valid"); assert.equal(gate.current(context), undefined);
	assert.ok(!kb.calls.some((call) => call.tool === "guardar")); assert.equal(await readTrust(dir, { ...key, kbUrl: kb.url }), undefined);
	assert.equal((await readFoundations(undefined, "/tmp", runner, new AbortController().signal)).kind, "unavailable");
});

// Cambio de requisito del dueño (2026-11-23): la pantalla OMI muestra todo, sin apretar f; ya no es un resumen corto.
test("foundations_pin: detalle para la pantalla OMI: origen, cada política con su significado, todos los patrones y el aviso", () => {
	assert.deepEqual(foundationsDetail(undefined), ["Todavía no se leyó de la KB: se lee al abrir la sesión."]);
	const unset = foundationsDetail({ ...pin(), version: 1 } as never).join("\n");
	assert.match(unset, /^Origen: por defecto \(sin configurar: nada pregunta\)$/m); assert.match(unset, /^Vigente en esta sesión\.$/m);
	assert.match(unset, /^Arranque: auto\. Crea el issue, el worktree y la sesión sin preguntar, con el texto del agente\.$/m);
	assert.match(unset, /^Patrones que requieren confirmación:$/m); assert.match(unset, /^ {2}\(sin configurar: nada pregunta\)$/m);
	assert.match(unset, /^Aviso: Foundations sin configurar/m, "el aviso se ve también con el default"); assert.doesNotMatch(unset, /\bv[12]\b|obsolet/i);
	const many = { ...value, confirmar: ["git push *", "npm publish*", "rm -rf *", "gh pr merge *"] }; const hash = foundationsHash(many);
	const accepted = foundationsDetail({ ...pin(), block: many, hash, reading: { ...reading, block: many, hash } });
	assert.ok(accepted.includes("Arranque: ask. Te pide el sí antes de crear el issue, el worktree y la sesión."));
	assert.ok(accepted.includes("Receta: ask. Te muestra la receta para que la apruebes antes de implementar."));
	assert.ok(accepted.includes("Push + PR draft: ask. Te pide el sí antes del push de la rama y del PR draft."));
	for (const rule of many.confirmar) assert.ok(accepted.includes(`  ${rule}`), rule);
	assert.ok(accepted.includes(`Origen: KB · revisión ${hash.slice(0, 8)} · perillas doc`)); assert.doesNotMatch(accepted.join("\n"), /y \d+ más|Sin configurar|Aviso/);
	const empty = foundationsDetail(pin()).join("\n");
	assert.match(empty, /ningún comando pide confirmación por esta política/, "lista vacía aceptada no es el default");
});
