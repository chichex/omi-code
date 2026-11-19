// Editar Foundations desde la pantalla OMI (/omi-foundations): parte de la KB, un sí con la diferencia,
// guarda, acepta y aplica en la sesión sin reiniciar. Nunca la KB real: una KB en memoria.
import assert from "node:assert/strict";
import { renameSync, rmSync, symlinkSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { foundationsHash, parseFoundations, renderFoundationsBlock, type FoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, readTrust, writeTrust } from "../src/harness/foundations-trust.ts";
import { effectivePolicy, foundationsLines, sessionFoundationsPin } from "../src/tui/development-foundations.ts";
import { commitFoundationsSave, FoundationsSaveError, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { developmentFixture } from "./helpers/development.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";
import { KEYS, typed } from "./helpers/questions.ts";

const REPO = "test/repo";
const HUMAN = "# Perillas de repo\n\nTono: formal.\n\n```json\n{ \"otra\": \"perilla\" }\n```\n";
const ASK = { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" } as const;
const block = (comandos = ["node test.cjs"], politica: Partial<FoundationsBlock["politica"]> = {}): FoundationsBlock => ({ version: 1, repo: REPO, comandos, politica: { ...ASK, ...politica } });
const body = (value: FoundationsBlock) => `${HUMAN}\n${renderFoundationsBlock(value)}\n`;
const saves = (kb: MemoryKb) => kb.calls.filter((c) => c.tool === "guardar").length;
const key = (kb: MemoryKb) => ({ kbUrl: kb.url, product: "repo", repo: REPO });
const short = (value: FoundationsBlock) => foundationsHash(value).slice(0, 8);

/** La KB con `initial` ya aceptado en este equipo: la sesión arranca con esa revisión, sin diálogo con cualquier default. */
async function fixture(t: TestContext, initial: FoundationsBlock | string | null = block()) {
	const kb = memoryKb({ products: ["repo"] });
	const doc = kb.perillas("repo", initial === null ? HUMAN : typeof initial === "string" ? `${HUMAN}\n${initial}\n` : body(initial));
	const f = await developmentFixture(t, { kb });
	const trustDir = foundationsDir(f.home);
	if (initial && typeof initial !== "string") await writeTrust(trustDir, { version: 1, ...key(kb), accepted: { docId: doc.id, blockHash: foundationsHash(initial), block: initial, author: doc.autor, date: doc.fecha, acceptedAt: "2026-11-18T00:00:00Z" }, offerDeclined: false });
	const latest = () => { const parsed = parseFoundations(kb.documents.at(-1)!.cuerpo, REPO); return parsed.status === "valid" ? parsed.block : undefined; };
	const accepted = async () => (await readTrust(trustDir, key(kb)))?.accepted?.blockHash;
	const pin = () => sessionFoundationsPin(f.manager.getSessionFile()!);
	return Object.assign(f, { kb, trustDir, latest, accepted, pin, edit: () => f.run("omi-foundations") });
}
// Cada tanda: las teclas al verla, o una función que además simula algo externo en ese momento.
type Step = readonly string[] | ((screen: string) => readonly string[]);
const steps = (...list: Step[]) => (screen: string) => { const next = list.shift(); return typeof next === "function" ? next(screen) : next; };
const BACKSPACE = "\x7f";
// Sin comandos detectados, la única fila es el texto libre: Espacio lo abre con los comandos vigentes, uno por línea.
const ADD = (command: string) => [KEYS.space, KEYS.newLine, ...typed(command), KEYS.enter, KEYS.enter];
const REPLACE = (from: string, to: string) => [KEYS.space, ...Array<string>(from.length).fill(BACKSPACE), ...typed(to), KEYS.enter, KEYS.enter];
const KEEP_COMMANDS = [KEYS.enter];
const KEEP_POLICIES = [KEYS.enter, KEYS.enter];
// La cuarta pestaña es push + PR draft: «2» elige auto y va a Enviar.
const PUSH_AUTO = [KEYS.tab, KEYS.tab, KEYS.tab, "2", KEYS.enter];
// En el resumen un número sólo mueve el cursor: guardar pide Enter. En 80x24 se lee de a 4 líneas: PgDn hasta el final.
const SAVE = [...Array<string>(5).fill(KEYS.pageDown), "1", KEYS.enter];
const LEAVE = ["2", KEYS.enter];
const RETRY = ["1", KEYS.enter];

test("foundations_edit: edita catálogo y políticas, pide un sí con la diferencia, conserva el resto y aplica en la sesión", async (t) => {
	const f = await fixture(t); await f.start();
	assert.equal(f.pin()?.hash, foundationsHash(block()), "la sesión arranca con la revisión aceptada");
	f.uiControl.questions = steps(ADD("node other-test.cjs"), PUSH_AUTO, SAVE);
	await f.edit();
	const next = block(["node test.cjs", "node other-test.cjs"], { push_pr: "auto" });
	assert.equal(saves(f.kb), 1, "una sola revisión nueva en la KB");
	assert.ok(f.kb.documents.at(-1)!.cuerpo.startsWith(HUMAN), "el resto de las perillas queda byte por byte");
	assert.deepEqual(f.latest(), next);
	assert.match(f.asked[0]![0]!, /Foundations: KB · revisión/, "la primera tanda muestra lo vigente y su procedencia");
	// Sin los cortes de línea del ancho de la terminal.
	const summary = f.asked[2]!.join("\n").replace(/\s+/g, " ");
	assert.match(summary, /¿Guardar Foundations en la KB\?/);
	assert.match(summary, new RegExp(`Antes: última revisión aceptada ${short(block())}`));
	assert.match(summary, /\+ node other-test\.cjs/); assert.match(summary, /push \+ PR draft: ask → auto/);
	assert.match(summary, /vale desde ya en esta sesión/); assert.match(summary, /Nunca habilita merge, tags, workflows, deploys ni secretos/);
	assert.equal(await f.accepted(), foundationsHash(next), "la confianza local queda con la revisión nueva");
	assert.equal(f.pin()?.hash, foundationsHash(next), "vale ya en esta sesión");
	assert.match(f.messages.join("\n"), /Foundations guardado en la KB/);
	await f.command("status");
	assert.match(f.messages.at(-1)!, new RegExp(`revisión ${short(next)}`)); assert.match(f.messages.at(-1)!, /push \+ PR draft auto/);
	await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node other-test.cjs" });
	assert.equal(f.prompts.filter((p) => p === "Autorizar comando del proyecto").length, 0, "el comando nuevo del catálogo corre sin preguntar");
});

test("foundations_edit: quitar y cambiar un comando muestra lo que sale y lo que entra", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = steps(REPLACE("node test.cjs", "node other-test.cjs"), KEEP_POLICIES, SAVE);
	await f.edit();
	assert.deepEqual(f.latest()?.comandos, ["node other-test.cjs"]);
	const summary = f.asked[2]!.join("\n");
	assert.match(summary, /\+ node other-test\.cjs/); assert.match(summary, /- node test\.cjs/);
});

test("foundations_edit: cancelar en cualquier paso no guarda, no acepta ni cambia la sesión", async (t) => {
	for (const keys of [[[KEYS.esc]], [ADD("npm test"), [KEYS.esc]], [ADD("npm test"), PUSH_AUTO, ["3", KEYS.enter]], [ADD("npm test"), PUSH_AUTO, [KEYS.esc]]]) {
		const f = await fixture(t); f.uiControl.questions = steps(...keys);
		await f.edit();
		assert.equal(f.asked.length, keys.length, JSON.stringify(keys));
		assert.equal(saves(f.kb), 0, JSON.stringify(keys));
		assert.equal(await f.accepted(), foundationsHash(block()));
		assert.equal(f.pin()?.hash, foundationsHash(block()));
	}
});

test("foundations_edit: «Cambiar respuestas» vuelve con lo elegido; sin cambios no pide el sí ni guarda", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = steps(ADD("npm test"), KEEP_POLICIES, ["2", KEYS.enter], KEEP_COMMANDS, PUSH_AUTO, SAVE);
	await f.edit();
	assert.match(f.asked[3]![0]!, /npm test/, "vuelve con el comando agregado");
	assert.deepEqual(f.latest(), block(["node test.cjs", "npm test"], { push_pr: "auto" }));
	const same = await fixture(t); same.uiControl.questions = steps(KEEP_COMMANDS, KEEP_POLICIES);
	await same.edit();
	assert.equal(same.asked.length, 2, "sin resumen"); assert.equal(saves(same.kb), 0);
	assert.match(same.messages.at(-1)!, /Sin cambios/);
});

test("foundations_edit: si la KB cambia antes de guardar, no la pisa: recarga la más reciente y pide confirmar de nuevo", async (t) => {
	const f = await fixture(t); const external = block(["node external.cjs"], { receta: "auto" });
	f.uiControl.questions = steps(ADD("npm test"), KEEP_POLICIES, () => { f.kb.perillas("repo", body(external), "otra@example.test"); return SAVE; }, KEEP_COMMANDS, KEEP_POLICIES, SAVE);
	await f.edit();
	assert.equal(saves(f.kb), 0, "no se pisó la revisión ajena");
	assert.deepEqual(f.latest(), external);
	const reloaded = f.asked[3]!.join("\n");
	assert.match(reloaded, /cambiaron en la KB/); assert.match(reloaded, /node external\.cjs/, "parte de la revisión más reciente");
	const summary = f.asked[5]!.join("\n");
	assert.match(summary, /- node test\.cjs/); assert.match(summary, /receta: ask → auto/);
	assert.match(summary, /La KB ya tiene esta revisión/);
	assert.equal(await f.accepted(), foundationsHash(external), "con el sí nuevo queda aceptada la revisión revisada");
	assert.equal(f.pin()?.hash, foundationsHash(external));
});

test("foundations_edit: si la KB tiene otra revisión que la vigente, editar parte de la KB y el resumen avisa qué reemplaza", async (t) => {
	const f = await fixture(t); f.uiControl.questions = steps([KEYS.esc]);
	await f.edit();
	const external = block(["node external.cjs"]); f.kb.perillas("repo", body(external), "otra@example.test");
	f.uiControl.questions = steps(REPLACE("node external.cjs", "node test.cjs"), KEEP_POLICIES, SAVE);
	await f.edit();
	assert.match(f.asked[1]![0]!.replace(/\s+/g, " "), new RegExp(`Editás la revisión ${short(external)} de la KB, distinta de la vigente`));
	const summary = f.asked[3]!.join("\n").replace(/\s+/g, " ");
	// El detalle se lee de a páginas: la frase puede quedar partida entre dos.
	assert.match(summary, new RegExp(`Reemplaza la revisión ${short(external)} de la KB, que`)); assert.match(summary, /no es la vigente en esta sesión/);
	assert.equal(saves(f.kb), 1); assert.deepEqual(f.latest(), block(), "la persona eligió volver a la vigente");
	assert.equal(f.pin()?.hash, foundationsHash(block()));
});

// Un symlink en lugar del directorio del registro: writeTrust se niega y el guardado queda a medias.
function breakTrust(dir: string): () => void {
	renameSync(dir, `${dir}.real`); symlinkSync(`${dir}.real`, dir);
	return () => { rmSync(dir); renameSync(`${dir}.real`, dir); };
}

test("foundations_edit: guardado parcial: informa el estado real, sigue la política anterior y reintentar acepta sin volver a guardar", async (t) => {
	for (const retry of [false, true]) {
		const f = await fixture(t); const next = block(["node test.cjs", "npm test"]);
		let repair = () => {};
		f.kb.hook = (tool) => { if (tool === "guardar") repair = breakTrust(f.trustDir); };
		f.uiControl.questions = steps(ADD("npm test"), KEEP_POLICIES, SAVE, (screen) => {
			assert.match(screen.replace(/\s+/g, " "), /se guardó en la KB, pero no se completó su verificación o aceptación local/);
			assert.match(screen.replace(/\s+/g, " "), /Sigue valiendo la política anterior/);
			assert.equal(f.pin()?.hash, foundationsHash(block()), "mientras tanto vale la anterior");
			repair(); return retry ? RETRY : LEAVE;
		});
		await f.edit();
		assert.equal(saves(f.kb), 1, "la KB no se revierte ni se vuelve a guardar");
		assert.deepEqual(f.latest(), next);
		const expected = retry ? next : block();
		assert.equal(await f.accepted(), foundationsHash(expected), `retry=${retry}`);
		assert.equal(f.pin()?.hash, foundationsHash(expected), `retry=${retry}`);
	}
});

test("foundations_edit: si al reintentar la KB volvió a cambiar, muestra la más reciente y pide un sí nuevo", async (t) => {
	const f = await fixture(t); const external = block(["node external.cjs"]);
	let repair = () => {};
	f.kb.hook = (tool) => { if (tool === "guardar") repair = breakTrust(f.trustDir); };
	f.uiControl.questions = steps(ADD("npm test"), KEEP_POLICIES, SAVE, () => { repair(); f.kb.perillas("repo", body(external), "otra@example.test"); return RETRY; }, [KEYS.esc]);
	await f.edit();
	const reloaded = f.asked[4]!.join("\n");
	assert.match(reloaded, /volvió a cambiar/); assert.match(reloaded, /node external\.cjs/);
	assert.equal(saves(f.kb), 1); assert.deepEqual(f.latest(), external);
	assert.equal(await f.accepted(), foundationsHash(block()), "no se activó en silencio una revisión desactualizada");
	assert.equal(f.pin()?.hash, foundationsHash(block()));
});

test("foundations_edit: sin Foundations en la KB parte de la política vigente y agrega el bloque al documento", async (t) => {
	const f = await fixture(t, null);
	f.uiControl.questions = steps([KEYS.space, ...typed("node test.cjs"), KEYS.enter, KEYS.enter], KEEP_POLICIES, SAVE);
	await f.edit();
	assert.equal(saves(f.kb), 1);
	assert.ok(f.kb.documents.at(-1)!.cuerpo.startsWith(HUMAN));
	assert.deepEqual(f.latest(), { version: 1, repo: REPO, comandos: ["node test.cjs"], politica: effectivePolicy(undefined).politica }, "las políticas parten del default, sea cual sea");
	assert.equal(f.pin()?.origin, "kb");
});

test("foundations_edit: sin KB o con un bloque inválido no abre el editor y dice por qué", async (t) => {
	const offline = await fixture(t); offline.kb.available = "sin login en /mcp";
	await offline.edit();
	assert.equal(offline.asked.length, 0); assert.match(offline.messages.at(-1)!, /sin login en \/mcp/);
	const invalid = await fixture(t, "```omi-foundations\n{ roto\n```");
	await invalid.edit();
	assert.equal(invalid.asked.length, 0); assert.match(invalid.messages.at(-1)!, /inválido/); assert.match(invalid.messages.at(-1)!, /corregilo en la KB/);
	assert.equal(saves(offline.kb) + saves(invalid.kb), 0);
});

test("foundations_edit: si la KB se cae entre el sí y el guardado, dice que no se guardó nada y sigue la anterior", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = steps(ADD("npm test"), KEEP_POLICIES, () => { f.kb.available = "se cortó la red"; return SAVE; });
	await f.edit();
	assert.match(f.messages.at(-1)!, /No se guardó nada en la KB: .*se cortó la red/);
	assert.equal(saves(f.kb), 0); assert.equal(f.pin()?.hash, foundationsHash(block()));
});

test("foundations_edit: la pantalla OMI lee el pin de la sesión con su procedencia", async (t) => {
	const f = await fixture(t);
	assert.equal(f.pin(), undefined, "antes del primer punto del harness no hay pin");
	f.uiControl.questions = steps([KEYS.esc]);
	await f.edit();
	assert.match(foundationsLines(f.pin()).join("\n"), new RegExp(`Foundations: KB · revisión ${short(block())}`));
});

test("foundations_edit: los fallos del guardado dicen en qué quedó la KB", async (t) => {
	const kb = memoryKb({ products: ["repo"] }); kb.perillas("repo", body(block()));
	const k = key(kb); const trustDir = foundationsDir(await tempDir(t)); const now = () => "2026-11-19T00:00:00Z";
	const next = block(["node test.cjs", "npm test"]); const signal = AbortSignal.timeout(5000);
	const stage = (expected: string) => (error: unknown) => error instanceof FoundationsSaveError && error.stage === expected;
	await assert.rejects(prepareFoundationsSave(kb, k, next, signal, "0".repeat(64)), stage("conflict"));
	const prepared = await prepareFoundationsSave(kb, k, next, signal, foundationsHash(block()));
	kb.perillas("repo", body(block(["otro"])));
	await assert.rejects(commitFoundationsSave(kb, k, next, prepared, { trustDir, now, signal }), stage("conflict"));
	const fresh = await prepareFoundationsSave(kb, k, next, signal);
	kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(commitFoundationsSave(kb, k, next, fresh, { trustDir, now, signal }), stage("unconfirmed"));
	kb.hook = () => {};
	await assert.rejects(commitFoundationsSave(kb, k, next, fresh, { trustDir, now, signal, writeAcceptance: async () => { throw new Error("disco lleno"); } }), stage("saved"));
});
