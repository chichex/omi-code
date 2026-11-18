// startupNetwork no puede colgar la suite: un nieto que abre una conexión al proxy y no manda nada,
// o un arranque que no termina, tienen que fallar o resolverse en segundos, no a los 300 s.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { tempDir } from "./helpers/io.ts";
import { SENTINEL_CONNECT, startupNetwork } from "./helpers/startup-network.ts";

const skip = process.platform === "win32";

// Abre una conexión al proxy y no manda nada. Con setsid termina cuando el proxy la corta; en el
// grupo sigue vivo, como un nohup, hasta que maten al grupo. Nunca más de 45 s.
const HOLD = `import os, signal, socket, sys, time, urllib.parse
signal.signal(signal.SIGHUP, signal.SIG_IGN)
proxy = urllib.parse.urlsplit(os.environ["HTTPS_PROXY"])
connection = socket.create_connection((proxy.hostname, proxy.port))
if sys.argv[2] == "escape": os.setsid()
with open(sys.argv[1], "w") as f: f.write(str(os.getpid()))
connection.settimeout(45)
try: connection.recv(1)
except OSError: pass
if sys.argv[2] == "group": time.sleep(45)
`;

// Lo que haría la sonda al iniciar la sesión: un CONNECT con la marca.
const MARK = `import os, socket, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["HTTPS_PROXY"])
socket.create_connection((proxy.hostname, proxy.port)).sendall(b"CONNECT ${SENTINEL_CONNECT} HTTP/1.1\\r\\n\\r\\n")
`;

interface FakeOmi {
	command: string;
	/** Donde el nieto anota su pid. */
	holder: string;
	/** Donde el propio comando anota su pid. */
	self: string;
}

/** Un "omi" que deja un nieto con una conexión muda al proxy y, si `mark`, manda la marca. */
async function fakeOmi(t: TestContext, dir: string, options: { mode: "group" | "escape" | "none"; mark: boolean }): Promise<FakeOmi> {
	const scripts = await tempDir(t);
	const holder = join(dir, "holder.pid");
	const self = join(dir, "self.pid");
	await writeFile(join(scripts, "hold.py"), HOLD);
	await writeFile(join(scripts, "mark.py"), MARK);
	const command = join(scripts, "omi");
	await writeFile(command, `#!/bin/sh
echo $$ > '${self}'
${options.mode === "none" ? "" : `python3 -I '${join(scripts, "hold.py")}' '${holder}' ${options.mode} &`}
${options.mark ? `python3 -I '${join(scripts, "mark.py")}'` : ""}
exec sleep 60
`, { mode: 0o755 });
	return { command, holder, self };
}

async function pidIn(path: string): Promise<number> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text.trim() !== "") return Number(text.trim());
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`nadie escribió ${path}`);
}

async function gone(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 30; attempt++) {
		try { process.kill(pid, 0); } catch { return true; }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

for (const mode of ["group", "escape"] as const) {
	test(`startupNetwork_un nieto con una conexión muda al proxy no lo cuelga (${mode === "group" ? "mismo grupo" : "con setsid"})`, { skip, timeout: 20000 }, async (t) => {
		const dir = await tempDir(t);
		const omi = await fakeOmi(t, dir, { mode, mark: true });
		const seen = await startupNetwork(omi.command, [], dir, { PATH: process.env.PATH });
		assert.ok(seen.connects.includes(SENTINEL_CONNECT), seen.connects.join(", "));
		// Mismo grupo: lo mata el driver. Con setsid: termina cuando el proxy le corta la conexión.
		assert.equal(await gone(await pidIn(omi.holder)), true, "el nieto sigue vivo");
	});
}

test("startupNetwork_un arranque que no termina falla a tiempo, con el registro y el final de la terminal", { skip, timeout: 20000 }, async (t) => {
	const dir = await tempDir(t);
	const omi = await fakeOmi(t, dir, { mode: "none", mark: false });
	const started = Date.now();
	await assert.rejects(startupNetwork(omi.command, [], dir, { PATH: process.env.PATH }, { timeoutMs: 3000 }), (error: Error) => {
		assert.match(error.message, /no terminó en 3000 ms/);
		assert.match(error.message, /registro/);
		assert.match(error.message, /terminal/);
		return true;
	});
	assert.ok(Date.now() - started < 8000, `tardó ${Date.now() - started} ms`);
	assert.equal(await gone(await pidIn(omi.self)), true, "el comando sigue vivo");
});
