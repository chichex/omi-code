import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { linkBundledTools } from "../src/tui/managed-tools.ts";
import { tempDir } from "./helpers/io.ts";

interface Layout {
	/** `<agent>/bin`: Pi busca ahí antes que en el PATH. */
	bin: string;
	/** `<runtime>/bin`, con fd y rg incluidos. */
	tools: string;
	/** Un directorio del PATH del usuario. */
	user: string;
}

async function layout(t: TestContext): Promise<Layout> {
	const root = await tempDir(t);
	const tools = join(root, "runtime/bin");
	const user = join(root, "usuario");
	await mkdir(tools, { recursive: true });
	await mkdir(user);
	for (const name of ["fd", "rg"]) await writeFile(join(tools, name), `#!/bin/sh\necho ${name} incluido\n`, { mode: 0o755 });
	return { bin: join(root, "agent/bin"), tools, user };
}

const link = (bin: string, name: string): Promise<string | undefined> => readlink(join(bin, name)).catch(() => undefined);

test("linkBundledTools_sin fd ni rg en el PATH los enlaza donde Pi busca primero", async (t) => {
	const { bin, tools, user } = await layout(t);
	await linkBundledTools(bin, tools, user);
	await linkBundledTools(bin, tools, user);
	for (const name of ["fd", "rg"]) {
		assert.equal(await link(bin, name), join("..", "..", "runtime", "bin", name), "relativo: sobrevive a mover la instalación");
		assert.equal(execFileSync(join(bin, name), { encoding: "utf8" }), `${name} incluido\n`);
	}
});

test("linkBundledTools_los del usuario ganan: no enlaza lo que ya tiene y saca el enlace de antes", async (t) => {
	const { bin, tools, user } = await layout(t);
	await linkBundledTools(bin, tools, user);
	// Debian instala fd como fdfind; Pi también lo acepta.
	await writeFile(join(user, "fdfind"), "#!/bin/sh\n", { mode: 0o755 });
	await writeFile(join(user, "rg"), "#!/bin/sh\n", { mode: 0o755 });
	await linkBundledTools(bin, tools, `/no/existe:${user}`);
	assert.equal(await link(bin, "fd"), undefined);
	assert.equal(await link(bin, "rg"), undefined);
});

test("linkBundledTools_un archivo del PATH sin permiso de ejecución no cuenta como del usuario", async (t) => {
	const { bin, tools, user } = await layout(t);
	await writeFile(join(user, "rg"), "no es un binario\n", { mode: 0o644 });
	await linkBundledTools(bin, tools, user);
	assert.equal(await link(bin, "rg"), join("..", "..", "runtime", "bin", "rg"));
});

test("linkBundledTools_no toca un fd que Pi ya bajó ni un enlace ajeno", async (t) => {
	const { bin, tools, user } = await layout(t);
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "fd"), "bajado por Pi\n", { mode: 0o755 });
	await symlink("/opt/otro/rg", join(bin, "rg"));
	await linkBundledTools(bin, tools, user);
	assert.equal(await readFile(join(bin, "fd"), "utf8"), "bajado por Pi\n");
	assert.equal(await link(bin, "rg"), "/opt/otro/rg");
	await writeFile(join(user, "rg"), "#!/bin/sh\n", { mode: 0o755 });
	await linkBundledTools(bin, tools, user);
	assert.equal(await link(bin, "rg"), "/opt/otro/rg", "sólo saca los enlaces propios");
});

test("linkBundledTools_ignora su propio directorio en el PATH, como en un omi dentro de un bash de omi", async (t) => {
	const { bin, tools, user } = await layout(t);
	await linkBundledTools(bin, tools, user);
	await linkBundledTools(bin, tools, `${bin}:${tools}:${user}`);
	for (const name of ["fd", "rg"]) assert.equal(await link(bin, name), join("..", "..", "runtime", "bin", name));
});

test("linkBundledTools_sin el binario en el runtime no deja un enlace roto", async (t) => {
	const { bin, tools, user } = await layout(t);
	await linkBundledTools(bin, tools, user);
	await rm(join(tools, "rg"));
	await linkBundledTools(bin, tools, user);
	await assert.rejects(lstat(join(bin, "rg")), { code: "ENOENT" });
	assert.equal(await link(bin, "fd"), join("..", "..", "runtime", "bin", "fd"));
});

test("linkBundledTools_dos omi que arrancan a la vez sacan el mismo enlace sin fallar", async (t) => {
	const { bin, tools, user } = await layout(t);
	await linkBundledTools(bin, tools, user);
	for (const name of ["fd", "rg"]) await writeFile(join(user, name), "#!/bin/sh\n", { mode: 0o755 });
	const results = await Promise.allSettled([linkBundledTools(bin, tools, user), linkBundledTools(bin, tools, user)]);
	assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
	for (const name of ["fd", "rg"]) await assert.rejects(lstat(join(bin, name)), { code: "ENOENT" });
});
