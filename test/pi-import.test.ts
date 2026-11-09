import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { run } from "../src/cli/main.ts";
import { painter } from "../src/cli/style.ts";
import { agentDir, sourcePiAgentDir as piAgentDir } from "../src/core/paths.ts";
import { runPiImportOnboarding } from "../src/onboarding/pi-import.ts";
import { tempDir, testIo } from "./helpers/io.ts";

const settings = {
	theme: "dark",
	defaultModel: "claude-opus-5-5",
	packages: ["git:github.com/chichex/skills", "npm:pi-claude-bridge"],
};

async function homeWithPi(t: TestContext): Promise<string> {
	const home = await tempDir(t);
	const pi = piAgentDir(home);
	await mkdir(pi, { recursive: true });
	await writeFile(join(pi, "auth.json"), '{"anthropic":{"key":"sk-falsa"}}', { mode: 0o600 });
	await writeFile(join(pi, "models.json"), '{"providers":{}}', { mode: 0o644 });
	await writeFile(join(pi, "settings.json"), JSON.stringify(settings), { mode: 0o644 });
	return home;
}

async function snapshot(dir: string): Promise<Record<string, { content: string; mtimeMs: number; mode: number }>> {
	const files: Record<string, { content: string; mtimeMs: number; mode: number }> = {};
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		const info = await stat(path);
		files[name] = { content: await readFile(path, "utf8"), mtimeMs: info.mtimeMs, mode: info.mode };
	}
	return files;
}

test("onboarding_importa de Pi sin mutar ~/.pi/agent cuando el usuario acepta", async (t) => {
	const home = await homeWithPi(t);
	const before = await snapshot(piAgentDir(home));
	const io = testIo({ homeDir: home, interactive: true, answers: ["s", "s"] });

	const result = await runPiImportOnboarding(io);

	assert.equal(result.status, "imported");
	assert.deepEqual(result.files, ["auth.json", "models.json", "settings.json"]);
	assert.equal(io.prompts.length, 2);
	const target = agentDir(home);
	assert.equal(await readFile(join(target, "auth.json"), "utf8"), before["auth.json"]?.content);
	assert.equal(await readFile(join(target, "models.json"), "utf8"), before["models.json"]?.content);
	assert.equal((await stat(join(target, "auth.json"))).mode & 0o777, 0o600);
	assert.deepEqual(await snapshot(piAgentDir(home)), before);
});

test("onboarding_conserva todos los paquetes: omi no trae ninguno de fábrica", async (t) => {
	const home = await homeWithPi(t);
	await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["s", "s"] }));
	assert.deepEqual(JSON.parse(await readFile(join(agentDir(home), "settings.json"), "utf8")), settings);
});

test("onboarding_importa sólo los archivos que existen en Pi", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "auth.json"), "{}");
	const result = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["s"] }));
	assert.equal(result.status, "imported");
	assert.deepEqual(result.files, ["auth.json"]);
});

test("onboarding_no vuelve a preguntar si el usuario rechazó", async (t) => {
	const home = await homeWithPi(t);
	const first = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["n", "n"] }));
	assert.equal(first.status, "declined");
	await assert.rejects(stat(join(agentDir(home), "auth.json")));

	const io = testIo({ homeDir: home, interactive: true });
	const second = await runPiImportOnboarding(io);
	assert.equal(second.status, "skipped");
	assert.equal(io.prompts.length, 0);
});

test("onboarding_no ofrece nada si ~/.omi/agent ya tiene proveedores", async (t) => {
	for (const existing of ["auth.json", "models.json"]) {
		const home = await homeWithPi(t);
		await mkdir(agentDir(home), { recursive: true });
		await writeFile(join(agentDir(home), existing), existing === "auth.json" ? '{"anthropic":{"key":"local-key"}}' : '{"providers":{"local":{"baseUrl":"http://localhost"}}}');
		const io = testIo({ homeDir: home, interactive: true });
		assert.equal((await runPiImportOnboarding(io)).status, "skipped");
		assert.equal(io.prompts.length, 0);
	}
});

test("onboarding ofrece importar después de un arranque no interactivo que dejó auth vacío", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "auth.json"), "{}");
	await writeFile(join(agentDir(home), "models.json"), '{"providers":{}}');
	const io = testIo({ homeDir: home, interactive: true, answers: ["s", "s"] });
	assert.equal((await runPiImportOnboarding(io)).status, "imported");
	assert.equal(io.prompts.length, 2);
	assert.match(await readFile(join(agentDir(home), "auth.json"), "utf8"), /sk-falsa/);
});

test("onboarding deja relativo a omi todo lo que apuntaba a Pi y no toca lo de afuera", async (t) => {
	const home = await homeWithPi(t);
	const pi = piAgentDir(home);
	await writeFile(join(pi, "settings.json"), `\uFEFF${JSON.stringify({
		packages: [join(pi, "absoluto"), "~/.pi/agent/con-tilde", { source: join(pi, "objeto"), extensions: [] }, "./relativo", "../afuera", "npm:unrelated", "git:github.com/fake/paquete"],
		extensions: ["~/.pi/agent/a.ts", "/opt/mia.ts", "~/mia.ts"],
		skills: [join(home, ".pi/otro"), "!~/.pi/agent/skills/no", "+./si"],
	})}`);
	await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["s", "s"] }));
	const raw = await readFile(join(agentDir(home), "settings.json"), "utf8");
	assert.deepEqual(JSON.parse(raw), {
		packages: ["./absoluto", "./con-tilde", { source: "./objeto", extensions: [] }, "./relativo", "../afuera", "npm:unrelated", "git:github.com/fake/paquete"],
		extensions: ["./a.ts", "/opt/mia.ts", "~/mia.ts"],
		skills: ["../otro", "!./skills/no", "+./si"],
	});
	assert.doesNotMatch(raw, /\.pi/);
});

test("onboarding tolera temporales de una importación interrumpida", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "auth.json.tmp"), "stale");
	const result = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["s", "s"] }));
	assert.equal(result.status, "imported");
	assert.match(await readFile(join(agentDir(home), "auth.json"), "utf8"), /sk-falsa/);
	assert.equal((await stat(join(agentDir(home), "auth.json"))).mode & 0o777, 0o600);
});

test("onboarding importa snapshots y handoffs de grills sin pisar sesiones existentes", async (t) => {
	const home = await homeWithPi(t);
	const source = join(piAgentDir(home), "grill-sessions");
	const target = join(agentDir(home), "grill-sessions");
	await mkdir(source, { recursive: true });
	await mkdir(target, { recursive: true });
	await writeFile(join(source, "paused.json"), '{"id":"paused","status":"paused"}', { mode: 0o600 });
	await writeFile(join(source, "paused.md"), "handoff de Pi\n");
	await writeFile(join(source, "existing.json"), "vieja de Pi");
	await writeFile(join(target, "existing.json"), "sesión de OMI");
	const before = await snapshot(source);
	const io = testIo({ homeDir: home, interactive: true, answers: ["s", "s", "s"] });
	const result = await runPiImportOnboarding(io);
	assert.match(io.prompts.at(-1) ?? "", /grills/);
	assert.ok(result.files.includes("grill-sessions/paused.json"));
	assert.equal(await readFile(join(target, "paused.json"), "utf8"), '{"id":"paused","status":"paused"}');
	assert.equal(await readFile(join(target, "paused.md"), "utf8"), "handoff de Pi\n");
	assert.equal(await readFile(join(target, "existing.json"), "utf8"), "sesión de OMI");
	assert.deepEqual(await snapshot(source), before);
});

test("onboarding ofrece grills a una instalación que ya importó proveedores sin sobrescribirlos", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(join(piAgentDir(home), "grill-sessions"));
	await writeFile(join(piAgentDir(home), "grill-sessions/paused.json"), '{"id":"paused"}');
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "auth.json"), '{"local":{"key":"no-pisar"}}');
	await writeFile(join(home, ".omi/onboarding.json"), '{"piImport":"imported"}');
	const io = testIo({ homeDir: home, interactive: true, answers: ["s"] });
	assert.equal((await runPiImportOnboarding(io)).status, "imported");
	assert.equal(await readFile(join(agentDir(home), "auth.json"), "utf8"), '{"local":{"key":"no-pisar"}}');
	assert.equal(await readFile(join(agentDir(home), "grill-sessions/paused.json"), "utf8"), '{"id":"paused"}');
	const again = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(again)).status, "skipped");
	assert.deepEqual(again.prompts, []);
});

test("onboarding no sobrescribe un marker de decisión con tipos inválidos", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(join(piAgentDir(home), "grill-sessions"));
	await writeFile(join(piAgentDir(home), "grill-sessions/paused.json"), '{"id":"paused"}');
	await mkdir(agentDir(home), { recursive: true });
	const marker = join(home, ".omi/onboarding.json");
	await writeFile(marker, '{"piImport":["imported"]}');
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.deepEqual(io.prompts, []);
	assert.equal(await readFile(marker, "utf8"), '{"piImport":["imported"]}');
});

test("onboarding_no ofrece nada si Pi no está configurado", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.equal(io.prompts.length, 0);
});

test("onboarding_no pregunta ni importa en modo no interactivo", async (t) => {
	const home = await homeWithPi(t);
	const io = testIo({ homeDir: home, interactive: false });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.equal(io.prompts.length, 0);
	await assert.rejects(stat(join(agentDir(home), "auth.json")));
});

const GRILLS_DIR = "grill-sessions";
const PLAIN = { NO_COLOR: "1" };

async function addGrills(home: string, names: string[]): Promise<void> {
	await mkdir(join(piAgentDir(home), GRILLS_DIR), { recursive: true });
	for (const name of names) await writeFile(join(piAgentDir(home), GRILLS_DIR, name), "{}");
}

async function piWithSettings(t: TestContext, value: string): Promise<string> {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "settings.json"), value);
	return home;
}

test("onboarding resume en filas y cuenta sesiones en vez de listar rutas", async (t) => {
	const home = await homeWithPi(t);
	await addGrills(home, ["a.json", "a.md", "b.json"]);
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["n", "n", "n"] });
	await runPiImportOnboarding(io);
	const summary = io.errors();
	assert.match(summary, /^Encontré una instalación de Pi\.$/m);
	assert.match(summary, /^  Credenciales  auth\.json, models\.json$/m);
	assert.match(summary, /^  Ajustes       settings\.json$/m);
	assert.match(summary, /^  Grills        2 sesiones$/m);
	assert.match(summary, new RegExp(`Se copia a ${agentDir(home)}\\. Pi no se modifica\\.`));
	assert.doesNotMatch(summary, /grill-sessions\//);
	assert.deepEqual(io.prompts, ["¿Copiar credenciales? [s/N] ", "¿Copiar ajustes? [s/N] ", "¿Copiar grills? [S/n] "]);
});

test("onboarding usa color sólo si la terminal lo admite", async (t) => {
	for (const [env, colored] of [[{}, true], [PLAIN, false], [{ TERM: "dumb" }, false], [{ NO_COLOR: "" }, true]] as const) {
		const home = await homeWithPi(t);
		const io = testIo({ homeDir: home, interactive: true, env, answers: ["n", "n"] });
		await runPiImportOnboarding(io);
		const text = io.errors() + io.prompts.join("");
		assert.equal(text.includes("\x1b["), colored, JSON.stringify(env));
	}
});

test("painter no pinta sin terminal interactiva", () => {
	assert.equal(painter({ env: {}, interactive: false })("cyan", "x"), "x");
	assert.equal(painter({ env: {}, interactive: true })("cyan", "x"), "\x1b[36mx\x1b[39m");
});

test("onboarding: Enter no copia credenciales ni ajustes con paquetes, pero sí los grills", async (t) => {
	const home = await homeWithPi(t);
	await addGrills(home, ["a.json"]);
	const result = await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["", "", ""] }));
	assert.equal(result.status, "imported");
	assert.deepEqual(result.files, ["grill-sessions/a.json"]);
	await assert.rejects(stat(join(agentDir(home), "auth.json")));
	await assert.rejects(stat(join(agentDir(home), "settings.json")));
});

test("onboarding: Enter copia ajustes sin paquetes", async (t) => {
	const home = await piWithSettings(t, JSON.stringify({ theme: "dark" }));
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: [""] });
	assert.deepEqual((await runPiImportOnboarding(io)).files, ["settings.json"]);
	assert.deepEqual(io.prompts, ["¿Copiar ajustes? [S/n] "]);
	assert.doesNotMatch(io.errors(), /Instala/);
});

test("onboarding deja elegir cada grupo por separado y recuerda cada decisión", async (t) => {
	const cases: ReadonlyArray<readonly [string[], string[]]> = [
		[["s", "n", "n"], ["auth.json", "models.json"]],
		[["n", "s", "n"], ["settings.json"]],
		[["n", "n", "s"], ["grill-sessions/a.json"]],
	];
	for (const [answers, files] of cases) {
		const home = await homeWithPi(t);
		await addGrills(home, ["a.json"]);
		assert.deepEqual((await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers }))).files, files);
		const again = testIo({ homeDir: home, interactive: true });
		assert.equal((await runPiImportOnboarding(again)).status, "skipped");
		assert.deepEqual(again.prompts, []);
	}
});

test("onboarding sólo acepta un sí explícito: lo que no entiende no copia", async (t) => {
	for (const answer of ["s", "S", "sí", "si", "y", "yes"]) {
		const home = await piWithSettings(t, '{"theme":"dark"}');
		assert.equal((await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: [answer] }))).status, "imported", answer);
	}
	for (const answer of ["n", "no", "x", "ok", "salir"]) {
		const home = await piWithSettings(t, '{"theme":"dark"}');
		assert.equal((await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: [answer] }))).status, "declined", answer);
	}
});

test("onboarding avisa qué paquetes externos instalaría", async (t) => {
	const home = await piWithSettings(t, JSON.stringify({
		packages: ["git:github.com/fake/paquete", "npm:pi-claude-bridge", { source: "npm:otro" }],
		extensions: ["/opt/mia.ts"],
	}));
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["n"] });
	await runPiImportOnboarding(io);
	assert.match(io.errors(), /^ {16}! Instala y carga: git:github\.com\/fake\/paquete, npm:pi-claude-bridge, npm:otro, \/opt\/mia\.ts$/m);
});

test("onboarding avisa de la sesión compartida sólo con OAuth y nunca muestra secretos", async (t) => {
	const home = await tempDir(t);
	await mkdir(piAgentDir(home), { recursive: true });
	await writeFile(join(piAgentDir(home), "auth.json"), '{"anthropic":{"type":"oauth","access":"secreto-a","refresh":"secreto-r"}}');
	const oauth = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["n"] });
	await runPiImportOnboarding(oauth);
	assert.match(oauth.errors(), /^ {16}! Pi y omi compartirían la sesión/m);
	assert.doesNotMatch(oauth.errors() + oauth.prompts.join(""), /secreto/);

	const apiKey = await homeWithPi(t);
	const io = testIo({ homeDir: apiKey, interactive: true, env: PLAIN, answers: ["n", "n"] });
	await runPiImportOnboarding(io);
	assert.doesNotMatch(io.errors(), /compartirían/);
});

test("onboarding no ofrece un settings ilegible ni rompe el arranque", async (t) => {
	for (const broken of ["{nope", "null", "[]", '"texto"']) {
		const home = await homeWithPi(t);
		await writeFile(join(piAgentDir(home), "settings.json"), broken);
		const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["s"] });
		assert.deepEqual((await runPiImportOnboarding(io)).files, ["auth.json", "models.json"], broken);
		assert.match(io.errors(), /^ {16}! Ilegible: no se copia\.$/m);
		await assert.rejects(stat(join(agentDir(home), "settings.json")));
	}
});

test("onboarding: cancelar a mitad de las preguntas no copia ni recuerda nada", async (t) => {
	const home = await homeWithPi(t);
	const io = testIo({ homeDir: home, interactive: true, answers: ["s"] });
	await assert.rejects(runPiImportOnboarding(io), /sin respuesta/);
	await assert.rejects(stat(join(agentDir(home), "auth.json")));
	await assert.rejects(stat(join(home, ".omi/onboarding.json")));
});

test("onboarding recuerda cómo traerlo después sólo si algo quedó afuera", async (t) => {
	const declined = testIo({ homeDir: await homeWithPi(t), interactive: true, answers: ["s", "n"] });
	await runPiImportOnboarding(declined);
	assert.match(declined.errors(), /omi import pi/);
	const all = testIo({ homeDir: await homeWithPi(t), interactive: true, answers: ["s", "s"] });
	await runPiImportOnboarding(all);
	assert.doesNotMatch(all.errors(), /omi import pi/);
});

test("onboarding respeta un marker anterior con piImport como decisión de credenciales y ajustes", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(join(home, ".omi"), { recursive: true });
	await writeFile(join(home, ".omi/onboarding.json"), '{"piImport":"declined"}');
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.deepEqual(io.prompts, []);
});

test("omi import pi vuelve a ofrecer lo rechazado en el onboarding", async (t) => {
	const home = await homeWithPi(t);
	await runPiImportOnboarding(testIo({ homeDir: home, interactive: true, answers: ["n", "n"] }));
	const io = testIo({ homeDir: home, interactive: true, answers: ["s", "n"] });
	assert.equal(await run(["import", "pi"], io), 0);
	assert.match(await readFile(join(agentDir(home), "auth.json"), "utf8"), /sk-falsa/);
	await assert.rejects(stat(join(agentDir(home), "settings.json")));
	const next = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(next)).status, "skipped");
});

test("omi import pi no pisa credenciales y pide un sí explícito para reemplazar ajustes", async (t) => {
	const home = await piWithSettings(t, '{"theme":"pi"}');
	await writeFile(join(piAgentDir(home), "auth.json"), '{"anthropic":{"key":"de-pi"}}');
	await mkdir(agentDir(home), { recursive: true });
	await writeFile(join(agentDir(home), "auth.json"), '{"anthropic":{"key":"de-omi"}}');
	await writeFile(join(agentDir(home), "settings.json"), '{"theme":"omi"}');

	const enter = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: [""] });
	assert.equal(await run(["import", "pi"], enter), 0);
	assert.match(enter.errors(), /omi ya tiene credenciales: no se tocan/);
	assert.match(enter.errors(), /Reemplaza los ajustes actuales de omi/);
	assert.deepEqual(enter.prompts, ["¿Copiar ajustes? [s/N] "]);
	assert.equal(await readFile(join(agentDir(home), "settings.json"), "utf8"), '{"theme":"omi"}');

	assert.equal(await run(["import", "pi"], testIo({ homeDir: home, interactive: true, answers: ["s"] })), 0);
	assert.match(await readFile(join(agentDir(home), "settings.json"), "utf8"), /"pi"/);
	assert.match(await readFile(join(agentDir(home), "auth.json"), "utf8"), /de-omi/);
});

test("omi import pi informa cuando no hay nada para copiar", async (t) => {
	const io = testIo({ homeDir: await tempDir(t), interactive: true });
	assert.equal(await run(["import", "pi"], io), 0);
	assert.match(io.output(), /No hay nada nuevo para copiar de Pi/);
});

test("omi import pi --json devuelve el resultado por stdout", async (t) => {
	const io = testIo({ homeDir: await homeWithPi(t), interactive: true, answers: ["s", "n"] });
	assert.equal(await run(["import", "pi", "--json"], io), 0);
	assert.deepEqual(JSON.parse(io.output()), { status: "imported", files: ["auth.json", "models.json"] });
});

test("omi import rechaza usos inválidos sin copiar nada", async (t) => {
	const home = await homeWithPi(t);
	for (const [args, interactive] of [[["import"], true], [["import", "claude"], true], [["import", "pi", "extra"], true], [["import", "pi"], false]] as const) {
		const io = testIo({ homeDir: home, interactive });
		assert.equal(await run([...args], io), 2, args.join(" "));
		assert.deepEqual(io.prompts, []);
	}
	await assert.rejects(stat(join(agentDir(home), "auth.json")));
});

test("omi import pi no sobrescribe un marker ilegible", async (t) => {
	const home = await homeWithPi(t);
	await mkdir(join(home, ".omi"), { recursive: true });
	await writeFile(join(home, ".omi/onboarding.json"), "{nope");
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal(await run(["import", "pi"], io), 1);
	assert.match(io.errors(), /onboarding\.json/);
	assert.equal(await readFile(join(home, ".omi/onboarding.json"), "utf8"), "{nope");
});

async function addResources(home: string): Promise<void> {
	const pi = piAgentDir(home);
	await mkdir(join(pi, "skills/de-pi"), { recursive: true });
	await writeFile(join(pi, "skills/de-pi/SKILL.md"), "de Pi");
	await writeFile(join(pi, "AGENTS.md"), "instrucciones de Pi");
}

test("onboarding pide un sí explícito para los recursos y dice qué traen", async (t) => {
	const home = await homeWithPi(t);
	await addResources(home);
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["n", "n", ""] });
	await runPiImportOnboarding(io);
	assert.match(io.errors(), /^  Recursos      AGENTS\.md, skills$/m);
	assert.match(io.errors(), /^ {16}! Pueden traer código que se carga al arrancar\.$/m);
	assert.equal(io.prompts.at(-1), "¿Copiar recursos? [s/N] ");
	await assert.rejects(stat(join(agentDir(home), "skills")));
});

test("onboarding copia los recursos sin mutar Pi", async (t) => {
	const home = await homeWithPi(t);
	await addResources(home);
	const io = testIo({ homeDir: home, interactive: true, answers: ["n", "n", "s"] });
	assert.deepEqual((await runPiImportOnboarding(io)).files, ["AGENTS.md", "skills"]);
	assert.equal(await readFile(join(agentDir(home), "skills/de-pi/SKILL.md"), "utf8"), "de Pi");
	assert.equal(await readFile(join(piAgentDir(home), "skills/de-pi/SKILL.md"), "utf8"), "de Pi");
	assert.equal(await readFile(join(agentDir(home), "AGENTS.md"), "utf8"), "instrucciones de Pi");
});

test("omi import pi suma los recursos que faltan sin pisar los de omi", async (t) => {
	const home = await tempDir(t);
	await addResources(home);
	await writeFile(join(piAgentDir(home), "skills/de-pi/extra.md"), "nuevo de Pi");
	await mkdir(join(agentDir(home), "skills/de-pi"), { recursive: true });
	await writeFile(join(agentDir(home), "skills/de-pi/SKILL.md"), "editado en omi");
	await writeFile(join(agentDir(home), "AGENTS.md"), "instrucciones de omi");
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["s"] });
	assert.equal(await run(["import", "pi"], io), 0);
	assert.doesNotMatch(io.errors(), /AGENTS\.md/);
	assert.equal(await readFile(join(agentDir(home), "skills/de-pi/SKILL.md"), "utf8"), "editado en omi");
	assert.equal(await readFile(join(agentDir(home), "skills/de-pi/extra.md"), "utf8"), "nuevo de Pi");
	assert.equal(await readFile(join(agentDir(home), "AGENTS.md"), "utf8"), "instrucciones de omi");
});

test("onboarding no pregunta por recursos a quien ya lo respondió: actualizar omi no molesta", async (t) => {
	const home = await homeWithPi(t);
	await addResources(home);
	await mkdir(join(home, ".omi"), { recursive: true });
	await writeFile(join(home, ".omi/onboarding.json"), '{"credentialsImport":"declined","settingsImport":"declined","grillImport":"declined"}');
	const io = testIo({ homeDir: home, interactive: true });
	assert.equal((await runPiImportOnboarding(io)).status, "skipped");
	assert.deepEqual(io.prompts, []);
	const again = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["n", "n", "s"] });
	assert.equal(await run(["import", "pi"], again), 0);
	assert.equal(again.prompts.at(-1), "¿Copiar recursos? [s/N] ");
	assert.equal((await stat(join(agentDir(home), "skills/de-pi/SKILL.md"))).isFile(), true);
});

test("onboarding lleva mcp-auth.json con las credenciales", async (t) => {
	const home = await homeWithPi(t);
	await writeFile(join(piAgentDir(home), "mcp-auth.json"), '{"servidor":{"token":"secreto"}}', { mode: 0o600 });
	const io = testIo({ homeDir: home, interactive: true, env: PLAIN, answers: ["s", "n"] });
	assert.deepEqual((await runPiImportOnboarding(io)).files, ["auth.json", "models.json", "mcp-auth.json"]);
	assert.equal((await stat(join(agentDir(home), "mcp-auth.json"))).mode & 0o777, 0o600);
	assert.doesNotMatch(io.errors(), /secreto/);
});

test("onboarding no lleva historial, cachés ni decisiones de Pi", async (t) => {
	const home = await homeWithPi(t);
	for (const name of ["trust.json", "models-store.json", "crashes.json", "settings.json.bak-1", "pi-debug.log"]) await writeFile(join(piAgentDir(home), name), "{}");
	for (const name of ["sessions", "backups", "tmp"]) await mkdir(join(piAgentDir(home), name));
	const io = testIo({ homeDir: home, interactive: true, answers: ["n", "n"] });
	await runPiImportOnboarding(io);
	assert.equal(io.prompts.length, 2);
	assert.doesNotMatch(io.errors(), /Recursos/);
});
