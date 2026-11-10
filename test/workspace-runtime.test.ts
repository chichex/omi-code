import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { exerciseWorkspace, plainTerminal } from "./helpers/workspace-pty.ts";

test("workspace_TUI real: Enter abre un archivo nuevo dentro de un directorio sin agregarlo al chat", { skip: process.platform === "win32", timeout: 25000 }, async (t) => {
	const home = await tempDir(t); const cwd = join(home, "repo"); await mkdir(cwd);
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	await mkdir(join(cwd, "test")); await writeFile(join(cwd, "test/preview.test.ts"), "LOCAL_FILE_PREVIEW_OK\n");
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await exerciseWorkspace(process.execPath, [binary, "--no-extensions", "--no-context-files", "--no-skills", "--offline"], cwd, { ...process.env, HOME: home, OMI_HOME: "", OMI_TEST_PREVIEW: "1" });
	assert.equal(result.code, 0, result.output);
	const plain = plainTerminal(result.output);
	assert.match(plain, /ARCHIVO NUEVO.*test\/preview.test.ts/); assert.match(plain, /LOCAL_FILE_PREVIEW_OK/);
	assert.match(plain, /no enviado al modelo/);
	assert.doesNotMatch(plain, /No se lee automáticamente|Extension error|TypeError|exceeds terminal width/);
});

test("workspace_TUI real: layout, selector propio, vistas, métricas, settings, reload y resize",  { skip: process.platform === "win32", timeout: 25000 }, async (t) => {
	const home = await tempDir(t);
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await exerciseWorkspace(process.execPath, [binary, "--no-extensions", "--no-context-files", "--no-skills", "--offline"], home, { ...process.env, HOME: home, OMI_HOME: "" });
	assert.equal(result.code, 0, result.output);
	const plain = plainTerminal(result.output);
	assert.match(plain, /omi code/);
	assert.match(plain, /¿Qué hacemos en/);
	assert.match(plain, /CONTEXTO/);
	assert.match(plain, /Modelo:/);
	assert.match(plain, /█{30}/);
	assert.doesNotMatch(plain, /\[Extensions\]|<inline:omi-|Update Available|pi update/);
	assert.match(plain, /Elegir modelo · OMI/);
	assert.match(plain, /OMI · Comandos/); assert.match(plain, /Ventana de contexto/);
	assert.match(plain, /Cambios locales/);
	assert.match(plain, /Issues abiertos/); assert.match(plain, /PRs abiertos/); assert.match(plain, /PROYECTO OMI/);
	assert.doesNotMatch(plain, /Entregas|ENTREGAS/);
	assert.match(plain, /▌ GITHUB ACTIONS/); assert.match(plain, /Claude reviews/); assert.match(plain, /Releases/);
	assert.match(plain, /Ctrl 1–5 vistas/);
	assert.match(plain, /Ubicación de trabajo/);
	assert.match(plain, /Recursos · equipo donde corre OMI/);
	assert.match(plain, /CPU total/);
	assert.doesNotMatch(plain, /Extension error|TypeError|not compatible|no compatible|exceeds terminal width|Maximum call stack/);
});
