// El guion de PTY contra un hijo mínimo en lugar de la TUI: escribe marcas a destiempo y sale con Ctrl+D.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";
import { ptyReport, runPty } from "./helpers/pty-driver.ts";

/** Escribe cada marca `ms` después de la anterior y sale cuando el PTY le da EOF (Ctrl+D). */
const marks = (list: [string, number][], extra = "") => `${extra}; let at = 0; for (const [text, ms] of ${JSON.stringify(list)}) setTimeout(() => process.stdout.write(text + "\\n"), at += ms); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`;
const node = (script: string): [string, string[]] => [process.execPath, ["-e", script]];
const names = (trace: string[]) => trace.map((line) => line.replace(/^[\d.]+ /, ""));

test("pty_driver: el plazo es por fase: dos fases de 2 s pasan con 3 s sin avance, aunque juntas sumen más", { timeout: 60_000 }, async (t) => {
	const [command, args] = node(marks([["listo", 0], ["uno", 2000], ["dos", 2000]]));
	const run = await runPty(String.raw`
def run():
    for text in ('listo', 'uno', 'dos'): wait(text, lambda: painted(text + '\r\n'))
    leave('salida')
`, command, args, { cwd: await tempDir(t), env: process.env, totalSeconds: 60, stallSeconds: 3 });
	assert.equal(run.result, "fin", ptyReport(run)); assert.equal(run.code, 0, ptyReport(run));
	assert.deepEqual(names(run.trace), ["listo", "uno", "dos", "salida"]); assert.equal(run.phase, "salida");
});

test("pty_driver: una fase sin avance corta enseguida con su nombre, el recorrido y el final de la terminal", { timeout: 60_000 }, async (t) => {
	const [command, args] = node(marks([["hola", 0]]));
	const started = Date.now();
	const run = await runPty(String.raw`
def run():
    wait('saludo', lambda: painted('hola'))
    wait('despedida', lambda: painted('chau'))
`, command, args, { cwd: await tempDir(t), env: process.env, totalSeconds: 60, stallSeconds: 1 });
	assert.equal(run.result, "falla: sin avance en 1 s"); assert.equal(run.code, 3); assert.equal(run.phase, "despedida");
	assert.deepEqual(names(run.trace), ["saludo", "despedida"]);
	assert.ok(Date.now() - started < 20_000, "corta por la fase, no por el tope");
	const report = ptyReport(run); assert.match(report, /fase «despedida»/); assert.match(report, /saludo → [\d.]+ despedida/); assert.match(report, /hola/);
});

test("pty_driver: el tope total corta aunque cada fase avance", { timeout: 60_000 }, async (t) => {
	const [command, args] = node(`let i = 0; setInterval(() => process.stdout.write("p" + i++ + ".\\n"), 300); process.stdin.resume();`);
	const run = await runPty(String.raw`
def run():
    i = 0
    while True:
        wait('p%d' % i, lambda: painted('p%d.' % i)); i += 1
`, command, args, { cwd: await tempDir(t), env: process.env, totalSeconds: 2, stallSeconds: 10 });
	assert.equal(run.result, "falla: pasó el tope de 2 s", ptyReport(run)); assert.equal(run.code, 3);
	assert.ok(run.trace.length > 2, ptyReport(run));
});

test("pty_driver: si la TUI termina antes, lo dice, y no deja vivo a un nieto del grupo", { timeout: 60_000 }, async (t) => {
	const dir = await tempDir(t); const pidFile = join(dir, "nieto");
	const [command, args] = node(`const child = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.exit(0);`);
	const run = await runPty(String.raw`
def run():
    wait('nunca', lambda: painted('nunca'))
`, command, args, { cwd: dir, env: process.env, totalSeconds: 30, stallSeconds: 10 });
	assert.equal(run.result, "falla: la TUI terminó"); assert.equal(run.phase, "nunca"); assert.equal(run.code, 3);
	const grandchild = Number(await readFile(pidFile, "utf8"));
	const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
	for (let tries = 0; alive() && tries < 40; tries++) await new Promise((done) => setTimeout(done, 50));
	assert.equal(alive(), false, "el sleep del mismo grupo murió con el guion");
});

test("pty_driver: un error del propio guion se informa y no deja la TUI viva", { timeout: 60_000 }, async (t) => {
	const [command, args] = node(marks([["hola", 0]]));
	const run = await runPty(String.raw`
def run():
    wait('saludo', lambda: painted('hola'))
    exists('NO_EXISTE')
`, command, args, { cwd: await tempDir(t), env: process.env, totalSeconds: 30, stallSeconds: 10 });
	assert.match(run.result, /^falla: el guion falló: KeyError\('NO_EXISTE'\)/); assert.equal(run.code, 3); assert.equal(run.phase, "saludo");
});
