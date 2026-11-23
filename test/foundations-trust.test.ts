import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentDir } from "../src/core/paths.ts";
import { foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, inspectTrust, readTrust, trustPath, writeTrust, type TrustRecord } from "../src/harness/foundations-trust.ts";
import { tempDir } from "./helpers/io.ts";

const key = { kbUrl: "https://kb.example.test/mcp", product: "omi-code", repo: "chichex/omi-code" };
const block: FoundationsBlock = { version: 2, repo: "chichex/omi-code", confirmar: ["git push *"], politica: { arranque: "ask", receta: "ask", push_pr: "ask" } };
const accepted = () => ({ docId: "doc-1", blockHash: foundationsHash(block), block, author: "ana@example.test", date: "2026-11-18T00:00:00Z", acceptedAt: "2026-11-18T01:00:00Z" });
const record = (overrides: Partial<TrustRecord> = {}): TrustRecord => ({ version: 2, ...key, accepted: accepted(), deferred: null, ...overrides });

test("foundations_trust: ida y vuelta bajo <OMI_HOME>/agent/foundations con 0700 y 0600", async (t) => {
	const home = await tempDir(t); const dir = foundationsDir(home);
	assert.equal(dir, join(agentDir(home), "foundations"));
	assert.equal(await readTrust(dir, key), undefined);
	await writeTrust(dir, record());
	assert.deepEqual(await readTrust(dir, key), record());
	const path = trustPath(dir, key);
	assert.equal(dirname(path), dir);
	assert.match(path, /\/[0-9a-f]{32}\.json$/);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "no deja temporales");
});

test("foundations_trust: otra KB, otro producto u otro repo no comparten revisión", async (t) => {
	const dir = foundationsDir(await tempDir(t));
	await writeTrust(dir, record());
	for (const other of [{ ...key, kbUrl: "https://otra.example.test/mcp" }, { ...key, product: "omi" }, { ...key, repo: "acme/omi-code" }]) assert.equal(await readTrust(dir, other), undefined);
});

test("foundations_trust: corrupto, ajeno o con un hash que no coincide cuenta como nada y no se reescribe al leer", async (t) => {
	const dir = foundationsDir(await tempDir(t)); await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = trustPath(dir, key);
	for (const body of ["{ roto", JSON.stringify({ ...record(), repo: "acme/otro" }), JSON.stringify(record({ accepted: { ...accepted(), blockHash: "0".repeat(64) } })), JSON.stringify({ ...record(), extra: 1 })]) {
		await writeFile(path, body, { mode: 0o600 });
		assert.equal(await readTrust(dir, key), undefined);
		assert.equal(await readFile(path, "utf8"), body);
	}
});

test("foundations_trust: rechaza symlinks y hardlinks", async (t) => {
	const home = await tempDir(t); const dir = foundationsDir(home); await mkdir(dir, { recursive: true, mode: 0o700 });
	const outside = join(home, "outside.json"); await writeFile(outside, JSON.stringify(record()), { mode: 0o600 });
	await symlink(outside, trustPath(dir, key));
	assert.equal(await readTrust(dir, key), undefined);
	await assert.rejects(writeTrust(dir, record()), /inseguro|symlink/i);
	assert.equal(await readFile(outside, "utf8"), JSON.stringify(record()), "no escribe a través del symlink");
	const linked = foundationsDir(join(home, "b")); await mkdir(linked, { recursive: true, mode: 0o700 });
	await link(outside, trustPath(linked, key));
	assert.equal(await readTrust(linked, key), undefined);
	await assert.rejects(writeTrust(linked, record()), /inseguro|hardlink/i);
	assert.equal(await readFile(outside, "utf8"), JSON.stringify(record()), "no altera el destino del hardlink");
	const real = join(home, "real"); await mkdir(real, { mode: 0o700 });
	const aliased = join(home, "alias"); await symlink(real, aliased);
	await assert.rejects(writeTrust(aliased, record()), /inseguro|symlink/i);
});

test("foundations_trust: v1 aceptado o sólo «no ofrecer más» es obsoleto y la lectura no reescribe sus bytes", async (t) => {
	const dir = foundationsDir(await tempDir(t)); await mkdir(dir, { recursive: true, mode: 0o700 });
	const oldBlock = { version: 1, repo: key.repo, comandos: ["npm test"], politica: { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } };
	const oldHash = createHash("sha256").update(JSON.stringify(oldBlock)).digest("hex");
	const oldAccepted = { ...accepted(), block: oldBlock, blockHash: oldHash };
	for (const previous of [
		{ version: 1, ...key, accepted: oldAccepted, offerDeclined: false },
		{ version: 1, ...key, accepted: null, offerDeclined: true },
	]) {
		const body = `${JSON.stringify(previous, null, "\t")}\n`;
		const path = trustPath(dir, key); await writeFile(path, body, { mode: 0o600 });
		assert.equal(await readTrust(dir, key), undefined, "ni aceptaciones ni opt-outs v1 se reutilizan");
		assert.equal(await readFile(path, "utf8"), body, "leer no migra, elimina ni reemplaza el archivo viejo");
		assert.deepEqual(await readdir(dir), [path.slice(dir.length + 1)]);
	}
});

test("foundations_trust: writeTrust valida bloque, hash y repo antes de reemplazar una aceptación durable", async (t) => {
	const dir = foundationsDir(await tempDir(t)); await writeTrust(dir, record());
	const path = trustPath(dir, key); const before = await readFile(path, "utf8");
	const foreign = { ...block, repo: "acme/otro" };
	const invalidRules: FoundationsBlock[] = [
		{ ...block, confirmar: [""] }, { ...block, confirmar: ["git push *", "git push *"] },
		{ ...block, confirmar: ["echo\u200b"] }, { ...block, confirmar: ["git \\x"] },
	];
	const inputs: unknown[] = [
		record({ accepted: { ...accepted(), blockHash: "0".repeat(64) } }),
		record({ accepted: { ...accepted(), block: foreign, blockHash: foundationsHash(foreign) } }),
		...invalidRules.map((invalid) => record({ accepted: { ...accepted(), block: invalid, blockHash: foundationsHash(invalid) } })),

		{ ...record(), accepted: { ...accepted(), block: { ...block, politica: { ...block.politica, fuera_de_catalogo: "auto" } } } },
		{ ...record(), accepted: { ...accepted(), block: { version: 1, repo: key.repo, comandos: ["npm test"], politica: { ...block.politica, fuera_de_catalogo: "auto" } } } },
		{ ...record(), version: 1 },
	];
	for (const input of inputs) {
		// Se cruza deliberadamente la frontera runtime: el tipo no demuestra que JSON externo sea válido.
		await assert.rejects(() => Reflect.apply(writeTrust, undefined, [dir, input]), /inválido|hash|repo|bloque|obsoleto/i);
		assert.equal(await readFile(path, "utf8"), before, "el rechazo conserva la aceptación anterior byte por byte");
		assert.deepEqual(await readdir(dir), [path.slice(dir.length + 1)], "sin escrituras parciales ni temporales");
	}
});

test("foundations_trust: actualizar es atómico, mantiene 0600 y no deja temporales", async (t) => {
	const dir = foundationsDir(await tempDir(t)); await writeTrust(dir, record());
	const next = record({ accepted: { ...accepted(), docId: "doc-2", acceptedAt: "2026-11-19T00:00:00Z" } });
	await writeTrust(dir, next);
	assert.deepEqual(await readTrust(dir, key), next);
	assert.equal((await stat(trustPath(dir, key))).mode & 0o777, 0o600);
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("foundations_trust: interrupción antes del reemplazo conserva bytes anteriores y no deja registro parcial", async (t) => {
	const dir = foundationsDir(await tempDir(t)); const previous = record(); await writeTrust(dir, previous);
	const path = trustPath(dir, key); const before = await readFile(path, "utf8");
	const next = record({ accepted: { ...accepted(), docId: "doc-interrumpido" } }); let reached = 0;
	await assert.rejects(() => Reflect.apply(writeTrust, undefined, [dir, next, {
		beforeReplace: async (temporary: string, target: string) => {
			reached++; assert.notEqual(temporary, target);
			assert.equal(await readFile(target, "utf8"), before, "el destino conserva todos sus bytes durante la actualización");
			assert.deepEqual(await readTrust(dir, key), previous, "lectores concurrentes siguen viendo la aceptación anterior completa");
			assert.equal(await readFile(temporary, "utf8"), `${JSON.stringify(next, null, 2)}\n`, "el nuevo registro completo todavía está en un archivo distinto");
			throw new Error("interrumpido antes del reemplazo");
		},
	}]), /interrumpido antes del reemplazo/);
	assert.equal(reached, 1); assert.equal(await readFile(path, "utf8"), before); assert.deepEqual(await readTrust(dir, key), previous);
	assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

// Cambio de requisito del dueño (2026-11-23): «Más adelante» se recuerda por revisión de la KB, no como un «no ofrecer más» global.
test("foundations_trust: «Más adelante» por revisión y nada aceptado sobreviven un corte", async (t) => {
	const dir = foundationsDir(await tempDir(t));
	await writeTrust(dir, record({ accepted: null, deferred: { revision: "missing:doc-1", at: "2026-11-23T00:00:00Z" } }));
	const read = await readTrust(dir, key);
	assert.deepEqual(read?.deferred, { revision: "missing:doc-1", at: "2026-11-23T00:00:00Z" }); assert.equal(read?.accepted, null);
});
test("foundations_trust: un registro v2 con el «no ofrecer más» anterior conserva su aceptación y al reescribirse ya no lo lleva", async (t) => {
	const dir = foundationsDir(await tempDir(t)); await mkdir(dir, { recursive: true, mode: 0o700 });
	const { deferred: _unused, ...rest } = record();
	await writeFile(trustPath(dir, key), `${JSON.stringify({ ...rest, offerDeclined: true }, null, 2)}\n`, { mode: 0o600 });
	const read = await readTrust(dir, key);
	assert.deepEqual(read, record(), "la aceptación sigue valiendo y el campo viejo no se expone");
	assert.ok(read); await writeTrust(dir, { ...read, deferred: { revision: "missing:none", at: "2026-11-23T00:00:00Z" } }, { expected: read });
	const stored: unknown = JSON.parse(await readFile(trustPath(dir, key), "utf8"));
	assert.deepEqual(Object.keys(stored && typeof stored === "object" ? stored : {}).sort(), ["accepted", "deferred", "kbUrl", "product", "repo", "version"]);
});
test("foundations_trust: inspeccionar distingue ausente, formato anterior, ilegible y vigente sin migrar ni reescribir", async (t) => {
	const dir = foundationsDir(await tempDir(t));
	assert.deepEqual(await inspectTrust(dir, key), { kind: "missing" }, "sin directorio");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	assert.deepEqual(await inspectTrust(dir, key), { kind: "missing" }, "sin archivo");
	const path = trustPath(dir, key);
	const legacy = `${JSON.stringify({ version: 1, ...key, accepted: null, offerDeclined: false }, null, "\t")}\n`;
	await writeFile(path, legacy, { mode: 0o600 });
	assert.deepEqual(await inspectTrust(dir, key), { kind: "legacy" });
	assert.equal(await readTrust(dir, key), undefined, "leer sigue sin reutilizarlo");
	assert.equal(await readFile(path, "utf8"), legacy, "inspeccionar no migra ni reescribe");
	await writeFile(path, JSON.stringify({ version: 1, ...key, repo: "otro/repo", accepted: null }), { mode: 0o600 });
	assert.deepEqual(await inspectTrust(dir, key), { kind: "invalid" }, "un v1 ajeno no es el formato anterior de este repo");
	await writeFile(path, "{ roto", { mode: 0o600 });
	assert.deepEqual(await inspectTrust(dir, key), { kind: "invalid" });
	await writeTrust(dir, record());
	assert.deepEqual(await inspectTrust(dir, key), { kind: "valid", record: record() });
});
