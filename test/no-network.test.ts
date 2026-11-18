// El guard de red de `npm test`, probado en procesos aparte: un entorno explícito sin NODE_OPTIONS
// lo deja afuera de los hijos, así que cada caso lo carga con --import y su propio log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";

const guard = fileURLToPath(new URL("./helpers/no-network.ts", import.meta.url));
// TEST-NET-1 (RFC 5737): nunca es un host real.
const OUTSIDE = "192.0.2.1:9";

// Conecta a cada host:puerto e imprime cómo terminó. "parent" repite lo mismo en un hijo con el entorno heredado.
const PROBE = `
import net from "node:net";
import { spawn } from "node:child_process";
const [role, ...targets] = process.argv.slice(2);
const probe = (target) => new Promise((resolve) => {
	const split = target.lastIndexOf(":");
	let socket;
	try { socket = net.connect({ host: target.slice(0, split), port: Number(target.slice(split + 1)) }); }
	catch (error) { resolve("threw:" + error.code); return; }
	socket.setTimeout(3000, () => { socket.destroy(); resolve("timeout"); });
	socket.on("error", (error) => resolve(error.code));
	socket.on("connect", () => { socket.destroy(); resolve("connected"); });
});
const results = [];
for (const target of targets) results.push(await probe(target));
let child;
if (role === "parent") {
	const spawned = spawn(process.execPath, [process.argv[1], "child", ...targets], { stdio: ["ignore", "pipe", "inherit"] });
	let out = ""; spawned.stdout.on("data", (chunk) => { out += chunk; });
	await new Promise((resolve) => spawned.on("close", resolve));
	child = JSON.parse(out).results;
}
console.log(JSON.stringify({ results, child }));
`;

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("no-network: corta TCP fuera de loopback en el proceso y en un hijo que hereda NODE_OPTIONS", async (t) => {
	const dir = await tempDir(t);
	const probe = join(dir, "probe.mjs");
	await writeFile(probe, PROBE);
	const log = join(dir, "network.log");
	const result = await run(["--import", guard, probe, "parent", OUTSIDE], dir, { OMI_TEST_NETWORK_LOG: log });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { results: ["ECONNREFUSED"], child: ["ECONNREFUSED"] });
	const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
	assert.deepEqual(lines, [`${OUTSIDE} desde ${probe} parent ${OUTSIDE}`, `${OUTSIDE} desde ${probe} child ${OUTSIDE}`]);
});

test("no-network: deja pasar loopback con cualquier grafía, y 0.0.0.0, que no sale de la máquina", async (t) => {
	const dir = await tempDir(t);
	const probe = join(dir, "probe.mjs");
	await writeFile(probe, PROBE);
	const server = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as AddressInfo).port;
	const hosts = ["127.0.0.1", "localhost", "LOCALHOST", "localhost.", "LocalHost.", "0.0.0.0"];
	const log = join(dir, "network.log");
	const result = await run(["--import", guard, probe, "child", ...hosts.map((host) => `${host}:${port}`)], dir, { OMI_TEST_NETWORK_LOG: log });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { results: hosts.map(() => "connected") });
	await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" }, "loopback no se anota");
});

test("no-network: un hijo rezagado, después de borrar el log, también recibe ECONNREFUSED", async (t) => {
	const dir = await tempDir(t);
	const probe = join(dir, "probe.mjs");
	await writeFile(probe, PROBE);
	// Así queda el log cuando el after del archivo ya limpió su directorio.
	const result = await run(["--import", guard, probe, "child", OUTSIDE], dir, { OMI_TEST_NETWORK_LOG: join(dir, "borrado", "network.log") });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { results: ["ECONNREFUSED"] });
	assert.match(result.stderr, /red bloqueada en tests: 192\.0\.2\.1:9 desde /);
});

test("no-network: un archivo de test que sale de loopback falla aunque sus tests pasen", async (t) => {
	const dir = await tempDir(t);
	await writeFile(join(dir, "afuera.test.ts"), `import net from "node:net";
import { test } from "node:test";
test("conecta afuera y no mira el resultado", () => new Promise((resolve) => {
	const socket = net.connect({ host: "192.0.2.1", port: 9 });
	socket.setTimeout(3000, () => { socket.destroy(); resolve(undefined); });
	socket.on("error", () => resolve(undefined)); socket.on("connect", () => { socket.destroy(); resolve(undefined); });
}));
`);
	const result = await run(["--test", "--import", guard, "afuera.test.ts"], dir, {});
	assert.notEqual(result.code, 0, result.stdout);
	assert.match(result.stdout, /afuera\.test\.ts: un proceso del test intentó salir de loopback/);
	assert.match(result.stdout, /192\.0\.2\.1:9 desde/);
});
