import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import * as foundations from "../src/harness/foundations.ts";

// La ausencia inicial del API debe ser un assert rojo, no un error al importar un archivo todavía inexistente.
function match(pattern: string, command: string): boolean {
	const candidate: unknown = Reflect.get(foundations, "matchCommandPattern");
	assert.equal(typeof candidate, "function", "foundations.ts exporta matchCommandPattern(pattern, command)");
	assert.ok(typeof candidate === "function");
	const result: unknown = candidate(pattern, command);
	assert.ok(typeof result === "boolean", "el matcher devuelve un booleano");
	return result;
}
function problem(rule: string): string | undefined {
	const candidate: unknown = Reflect.get(foundations, "ruleProblem");
	assert.equal(typeof candidate, "function", "foundations.ts exporta ruleProblem(rule)");
	assert.ok(typeof candidate === "function");
	const result: unknown = candidate(rule);
	assert.ok(result === undefined || typeof result === "string", "el validador devuelve motivo o undefined");
	return result;
}

test("foundations matcher: API pública sin módulo nuevo obligatorio para cargar el test", () => {
	assert.equal(typeof Reflect.get(foundations, "matchCommandPattern"), "function");
	assert.equal(typeof Reflect.get(foundations, "ruleProblem"), "function");
});

const matches: [string, string, boolean][] = [
	["npm test", "npm test", true],
	["npm test", "NPM test", false],
	["npm test", " npm test", false],
	["npm test", "npm test ", false],
	["npm test", "npm  test", false],
	["npm test", "npm test --watch", false],
	["npm test", "env npm test", false],
	["git push *", "git push origin main", true],
	["git push *", "git push ", true],
	["git push *", "git push", false],
	["git push *", "Git push origin main", false],
	["git push *", "npm test && git push origin main", false],
	["git push *", "git  push origin main", false],
	["*", "", true],
	["*", "anything including spaces / directories", true],
	["echo *", "echo uno\ndos", true],
	["*test", "test", true],
	["*test", "npm test", true],
	["*test", "npm tests", false],
	["npm * test", "npm run test", true],
	["npm * test", "npm  test", true],
	["npm * test", "npm test", false],
	["*a*b*c", "aaabbbcc", true],
	["*a*b*c", "aaabbbcd", false],
	["a**b***c", "abc", true],
	["a**b***c", "axbyc", true],
	["?", "a", true],
	["?", "😀", true],
	["?", "", false],
	["?", "ab", false],
	["?", "e\u0301", false],
	["??", "e\u0301", true],
	["??", "😀", false],
	["echo ?", "echo 🧪", true],
	["echo ?", "echo 🧪x", false],
	["?*?", "😀🧪", true],
	["?*?", "😀", false],
	["café", "cafe\u0301", false],
	["echo ☕️", "echo ☕", false],
	[String.raw`echo \*`, "echo *", true],
	[String.raw`echo \*`, "echo file.txt", false],
	[String.raw`echo \?`, "echo ?", true],
	[String.raw`echo \?`, "echo x", false],
	[String.raw`echo \\`, "echo \\", true],
	[String.raw`echo \\`, "echo /", false],
	[String.raw`echo \**`, "echo *tail", true],
	[String.raw`echo \**`, "echo tail", false],
	[String.raw`echo \\?`, "echo \\😀", true],
	["file[0].(txt)+$^|{2}", "file[0].(txt)+$^|{2}", true],
	["file[0].(txt)+$^|{2}", "file0Xtxttxt", false],
	["echo (a|b)", "echo a", false],
	["echo .", "echo x", false],
	["git push origin/*", "git push origin/a/b", true],
];
for (const [pattern, command, expected] of matches) test(`foundations matcher: ${JSON.stringify(pattern)} contra ${JSON.stringify(command)} → ${expected}`, () => {
	assert.equal(match(pattern, command), expected);
});

test("foundations matcher: no modifica los argumentos ni expande shell, rutas o archivos", () => {
	const pattern = "git push *";
	const command = "git push $REMOTE main";
	assert.equal(match(pattern, command), true, "el matcher es textual; no promete seguridad semántica ni decide la puerta sintáctica");
	assert.equal(pattern, "git push *");
	assert.equal(command, "git push $REMOTE main");
	assert.equal(match("~/file", "/home/ana/file"), false);
	assert.equal(match("echo ${HOME}", "echo /home/ana"), false);
});

test("foundations matcher: ruleProblem acepta solo escapes de *, ? y backslash", () => {
	for (const rule of ["*", "?", "git push *", "echo [a-z](x)+.$^|{2}", String.raw`echo \*`, String.raw`echo \?`, String.raw`echo \\`, String.raw`echo \\\*`]) {
		assert.equal(problem(rule), undefined, JSON.stringify(rule));
	}
	for (const rule of [String.raw`echo \a`, String.raw`echo \n`, String.raw`echo \t`, String.raw`echo \ `, String.raw`echo \/`, String.raw`echo \[`, "echo \\"]) {
		const reason = problem(rule);
		assert.equal(typeof reason, "string", JSON.stringify(rule));
		assert.match(reason ?? "", /escape|barra|backslash/i);
	}
});

test("foundations matcher: ruleProblem comparte límites UTF-16 y rechazo de invisibles del bloque", () => {
	for (const rule of ["x", "x".repeat(2000), "😀".repeat(1000), "echo ☕️"]) assert.equal(problem(rule), undefined);
	for (const rule of ["", "x".repeat(2001), "😀".repeat(1000) + "x", " x", "x ", "x\tx", "x\nx", "x\u202ex", "x\u2028x", "x\u2029x", "x\u{E0100}x", "x\u{E01EF}x"]) {
		const reason = problem(rule);
		assert.equal(typeof reason, "string", JSON.stringify(rule));
		assert.ok((reason ?? "").length > 0);
		assert.doesNotMatch(reason ?? "", /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0100}-\u{E01EF}]/u);
	}
});

test("foundations matcher: patrones adversariales terminan sin backtracking exponencial", async () => {
	assert.equal(match("x", "x"), true);
	// Aislar el caso evita que un matcher sin cota bloquee todo el proceso de tests.
	const worker = new Worker(`
		(async () => {
			const { parentPort, workerData } = await import("node:worker_threads");
			const api = await import(workerData.moduleUrl);
			parentPort.postMessage(workerData.cases.map(([pattern, command]) => api.matchCommandPattern(pattern, command)));
		})().catch((error) => { throw error; });
	`, {
		eval: true,
		workerData: {
			moduleUrl: new URL("../src/harness/foundations.ts", import.meta.url).href,
			cases: [["*a".repeat(60) + "b", "a".repeat(1500) + "c"], ["*?".repeat(500) + "z", "😀".repeat(600) + "z"]],
		},
	});
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("el matcher no terminó dentro de 5 s")), 5000);
			worker.once("message", (value: unknown) => { clearTimeout(timer); resolve(value); });
			worker.once("error", (error) => { clearTimeout(timer); reject(error); });
			worker.once("exit", (code) => { clearTimeout(timer); reject(new Error(`worker salió sin resultado (${code})`)); });
		});
		assert.deepEqual(result, [false, true]);
	} finally {
		await worker.terminate();
	}
});
