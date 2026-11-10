import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { exerciseWorkspace, plainTerminal } from "./helpers/workspace-pty.ts";

test("workspace_PR: clic SGR real en el botón abre la URL y no Ubicación de trabajo", { skip: process.platform === "win32", timeout: 25000 }, async (t) => {
	const home = await tempDir(t); const bin = join(home, "mock-bin"); await mkdir(bin);
	execFileSync("git", ["init", "-b", "feature"], { cwd: home, stdio: "ignore" });
	const log = join(home, "browser.jsonl"); const url = "https://github.com/test/repo/pull/21";
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'status') {
 console.log(JSON.stringify({currentBranch: {number: 21, title: 'Click PR', url: ${JSON.stringify(url)}, isDraft: false, state: 'OPEN'}}));
} else if (args.includes('--web')) {
 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
} else console.log('[]');\n`, { mode: 0o755 });
	// Nunca abrir el navegador del desarrollador durante la prueba, ni siquiera por el fallback OSC 8.
	for (const command of ["xdg-open", "open"]) await writeFile(join(bin, command), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await exerciseWorkspace(process.execPath, [binary, "--no-extensions", "--no-context-files", "--no-skills", "--approve"], home,
		{ ...process.env, HOME: home, OMI_HOME: "", PATH: bin + delimiter + (process.env.PATH ?? ""), OMI_TEST_PR_CLICK: "1", OMI_TEST_BROWSER_LOG: log });
	assert.equal(result.code, 0, result.output);
	const plain = plainTerminal(result.output);
	assert.match(plain, /PR #21/); assert.doesNotMatch(plain, /Ubicación de trabajo|Extension error|TypeError/);
	assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [["pr", "view", url, "--web"]]);
});
