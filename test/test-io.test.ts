import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";

test("tempDir devuelve una ruta canónica aunque el directorio temporal sea un alias", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "omi-fixture-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "physical");
	const alias = join(root, "alias");
	await mkdir(target);
	await symlink(target, alias, "dir");
	const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	Object.assign(process.env, { TMPDIR: alias, TMP: alias, TEMP: alias });
	const dir = await tempDir(t, "canonical-");
	assert.equal(dir, await realpath(dir));
	assert.equal(dirname(dir), target);
});
