import assert from "node:assert/strict";
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentDir } from "../src/core/paths.ts";
import { foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, trustPath, writeTrust, type TrustRecord } from "../src/harness/foundations-trust.ts";
import { tempDir } from "./helpers/io.ts";

const key = { kbUrl: "https://kb.example.test/mcp", product: "omi-code", repo: "chichex/omi-code" };
const block: FoundationsBlock = { version: 1, repo: "chichex/omi-code", comandos: ["npm test"], politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" } };
const record = (overrides: Partial<TrustRecord> = {}): TrustRecord => ({ version: 1, ...key, accepted: { docId: "doc-1", blockHash: foundationsHash(block), block, author: "ana@example.test", date: "2026-11-18T00:00:00Z", acceptedAt: "2026-11-18T01:00:00Z" }, pendingSave: null, offerDeclined: false, ...overrides });

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
	for (const body of ["{ roto", JSON.stringify({ ...record(), repo: "acme/otro" }), JSON.stringify(record({ accepted: { ...record().accepted!, blockHash: "0".repeat(64) } })), JSON.stringify({ ...record(), extra: 1 })]) {
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
	const real = join(home, "real"); await mkdir(real, { mode: 0o700 });
	const aliased = join(home, "alias"); await symlink(real, aliased);
	await assert.rejects(writeTrust(aliased, record()), /inseguro|symlink/i);
});

test("foundations_trust: un guardado pendiente sobrevive un corte", async (t) => {
	const dir = foundationsDir(await tempDir(t));
	const pending = { clave: "omi-foundations|chichex/omi-code|doc-1|abc", previousDocId: "doc-1", bodyHash: "a".repeat(64), at: "2026-11-18T02:00:00Z" };
	await writeTrust(dir, record({ pendingSave: pending, offerDeclined: true }));
	const read = await readTrust(dir, key);
	assert.deepEqual(read?.pendingSave, pending); assert.equal(read?.offerDeclined, true);
	await writeTrust(dir, record({ accepted: null }));
	assert.equal((await readTrust(dir, key))?.accepted, null);
});
