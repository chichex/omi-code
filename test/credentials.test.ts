import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { deleteCredentials, loadCredentials, saveCredentials, type Credentials } from "../src/auth/credentials.ts";
import type { OmiError } from "../src/core/errors.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { tempDir } from "./helpers/io.ts";

const credentials: Credentials = {
	apiUrl: "https://app.ohmyinfra.com",
	token: "token-secreto",
	expiresAt: "2026-11-12T00:00:00Z",
	user: { id: "usr_1", name: "Ada", email: "ada@example.com" },
	defaultOrganizationSlug: "acme",
};

test("saveCredentials_escribe el archivo con modo 0600 y sin dejar temporales", async (t) => {
	const home = await tempDir(t);
	const path = credentialsPath(home);
	await saveCredentials(path, credentials);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), credentials);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(dirname(path)), ["credentials.json"]);
});

test("saveCredentials_reemplaza un archivo previo con permisos abiertos", async (t) => {
	const home = await tempDir(t);
	const path = credentialsPath(home);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "{}", { mode: 0o644 });
	await saveCredentials(path, credentials);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("loadCredentials_devuelve null si no hay sesión guardada", async (t) => {
	const home = await tempDir(t);
	assert.equal(await loadCredentials(credentialsPath(home)), null);
});

test("loadCredentials_rechaza un archivo que no cumple el esquema", async (t) => {
	const home = await tempDir(t);
	const path = credentialsPath(home);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ apiUrl: "x" }));
	await assert.rejects(loadCredentials(path), (error: OmiError) => {
		assert.equal(error.code, "credentials_invalid");
		assert.match(error.hint ?? "", /omi login/);
		return true;
	});
});

test("deleteCredentials_borra el archivo y tolera que no exista", async (t) => {
	const home = await tempDir(t);
	const path = credentialsPath(home);
	await saveCredentials(path, credentials);
	await deleteCredentials(path);
	await deleteCredentials(path);
	assert.equal(await loadCredentials(path), null);
});
