// Editar reglas reemplaza el antiguo permiso permanente: guardar nunca ejecuta ni concede grants.
import assert from "node:assert/strict";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commandAuthorization } from "../src/harness/authorization.ts";
import { STRICT_POLICY, parseFoundations, renderFoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, trustPath } from "../src/harness/foundations-trust.ts";
import { FoundationsGate, effectivePolicy } from "../src/tui/development-foundations.ts";
import { ASK_ALL } from "./helpers/foundations.ts";
import { COMMAND, HUMAN, KNOWN, REPO, accepted, authorizations, block, choose, commandFixture, key, noPermissionAdded, saves, type CommandFixture } from "./helpers/command-permissions.ts";
import { changeFirstRule, GUIDED_EDIT } from "./helpers/foundations-guide.ts";
import { KEYS } from "./helpers/questions.ts";

function edit(f: CommandFixture, text = "npm publish *"): void {
	choose(f, "edit"); f.uiControl.foundations = changeFirstRule(text);
}
async function savedDraft(f: CommandFixture, rules: string[]): Promise<void> {
	await assert.rejects(f.check(), /reintent|no se ejecut/i);
	assert.equal(saves(f).length, 1); await noPermissionAdded(f);
	const stored = f.kb.documents.at(-1)!; const parsed = parseFoundations(stored.cuerpo, REPO);
	assert.equal(parsed.status, "valid"); assert.ok(parsed.status === "valid");
	assert.deepEqual(parsed.block.confirmar, rules, "guarda exactamente el borrador, no agrega el comando pendiente");
	assert.equal((await accepted(f))?.accepted?.docId, stored.id);
	assert.deepEqual(f.session.foundations.current(f.context)?.block, parsed.block);
}

test("command_catalog: Editar reglas precarga v2 y cancelar no escribe ni ejecuta", async (t) => {
	const f = await commandFixture(t); choose(f, "edit"); const previous = await accepted(f);
	f.uiControl.foundations = (screen) => /· Reglas/.test(screen) ? [KEYS.esc] : GUIDED_EDIT;
	await assert.rejects(f.check(), /reintent|no se ejecut/i);
	assert.equal(f.foundationsScreens.length, 2); assert.match(f.foundationsScreens[1]?.[0] ?? "", /git push \*/);
	assert.match(f.foundationsScreens[0]?.[0] ?? "", /Arranque[\s\S]*Conservar \(ask\)/);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	choose(f, "no"); await assert.rejects(f.check(), /no autorizado/i);
	assert.equal(authorizations(f).length, 2, "cancelar la edición no ocultó un grant");
});

test("command_catalog: Guardar después del resumen persiste el draft exacto sin ejecutar ni grant; sólo reintentar reevalúa", async (t) => {
	const f = await commandFixture(t, { value: block([KNOWN]) }); edit(f, "npm publish *");
	await savedDraft(f, ["npm publish *"]);
	assert.ok(f.foundationsScreens.flat().some((screen) => /· Resumen/.test(screen)));
	choose(f, "no"); await f.check(KNOWN);
	assert.deepEqual(f.executed, [KNOWN]); assert.equal(authorizations(f).length, 1, "el simple dejó de coincidir sólo al reintentar");
	await assert.rejects(f.check(COMMAND), /no autorizado/i);
	assert.equal(authorizations(f).length, 2, "quitar reglas nunca autoautoriza sintaxis compleja");
	assert.deepEqual((await f.state()).grants ?? [], []); assert.equal(saves(f).length, 1);
});

// Pedido del dueño (2026-11-24): con la lista vacía nada pregunta. Guardarla igual exige revisión y no corre el pendiente.
test("command_catalog: lista vacía exige revisión explícita, no autoejecuta el pendiente y después nada pregunta", async (t) => {
	const f = await commandFixture(t); edit(f, ""); await savedDraft(f, []);
	assert.ok(f.foundationsScreens.flat().some((screen) => /Lista vacía: ningún comando del proyecto pide confirmación/.test(screen)));
	choose(f, "no"); await f.check(); await f.check("npm test");
	assert.deepEqual(f.executed, [COMMAND, "npm test"], "el pendiente corre sólo al reintentarlo"); assert.equal(authorizations(f).length, 1, "sólo la pregunta de antes de guardar");
});

test("command_catalog: volver de revisión conserva draft y cancelar no persiste", async (t) => {
	const f = await commandFixture(t); choose(f, "edit"); const previous = await accepted(f);
	let reviewed = false; const answer = changeFirstRule("npm publish *", ["2", KEYS.enter]);
	f.uiControl.foundations = (screen) => { if (reviewed) return [KEYS.esc]; if (/· Resumen/.test(screen)) reviewed = true; return answer(screen); };
	await assert.rejects(f.check(), /reintent|no se ejecut/i);
	assert.ok(f.foundationsScreens.flat().some((screen) => /· Resumen/.test(screen)));
	assert.match(f.foundationsScreens.at(-1)?.[0] ?? "", /Reglas[\s\S]*npm publish \*/);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: error de la UI de edición no ejecuta ni concede fallback", async (t) => {
	const f = await commandFixture(t); choose(f, "edit"); const previous = await accepted(f);
	f.uiControl.foundations = () => { throw new Error("guía fallida"); };
	await assert.rejects(f.check(), /guía fallida/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: otra sesión acepta reglas guardadas, no hereda un grant de ningún trabajo", async (t) => {
	const f = await commandFixture(t); edit(f); await savedDraft(f, ["npm publish *"]);
	const ctx = { ...f.context, sessionManager: SessionManager.create(f.checkout.root, join(f.home, "new-sessions")) };
	const gate = new FoundationsGate({ kb: f.kb, runner: f.runner, trustDir: foundationsDir(f.home), now: () => "2026-11-19T00:00:00Z" });
	const first = await f.state(); const otherWork = { ...first, id: "otro-trabajo", grants: [] };
	const policy = await gate.policy(ctx, otherWork);
	assert.equal(commandAuthorization(otherWork, "npm test", policy.command), "auto");
	assert.equal(commandAuthorization(otherWork, "npm publish package", policy.command), "ask");
	assert.equal(commandAuthorization(otherWork, COMMAND, policy.command), "ask");
	assert.equal(gate.current(ctx)?.docId, f.kb.documents.at(-1)!.id);
	assert.equal(authorizations(f).length, 1); assert.deepEqual((await f.state()).grants ?? [], []);
});

test("command_catalog: otro owner con el mismo producto no hereda reglas ni aceptación", async (t) => {
	const f = await commandFixture(t); edit(f); await savedDraft(f, ["npm publish *"]);
	const ctx = { ...f.context, sessionManager: SessionManager.create(f.checkout.root, join(f.home, "foreign-sessions")) };
	const runner = { run: async (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].join(" ") === "remote get-url origin" ? { code: 0, stdout: "https://github.com/acme/repo.git\n", stderr: "" } : f.runner.run(...args) };
	const gate = new FoundationsGate({ kb: f.kb, runner, trustDir: foundationsDir(f.home), now: () => "now" });
	const state = await f.state(); const foreign = { ...state, source: { ...state.source, url: "https://github.com/acme/repo/issues/42" }, grants: [] };
	const policy = await gate.policy(ctx, foreign);
	assert.deepEqual(policy.command, { block: null, accepted: false });
	assert.equal(commandAuthorization(foreign, COMMAND, policy.command), "auto", "sin v2 de acme/repo vale el default: nada pregunta");
	assert.equal(gate.current(ctx)?.origin, "default");
	assert.deepEqual(effectivePolicy(f.session.foundations.current(f.context), foreign).command, { block: null, accepted: false });
});

test("command_catalog: preserva bytes ajenos y políticas; nunca agrega el comando pendiente", async (t) => {
	const value = block(undefined, { politica: { ...STRICT_POLICY, arranque: "auto", receta: "auto", push_pr: "auto" } });
	const foreign = renderFoundationsBlock(block(["npm test"], { repo: "acme/repo" }));
	const body = `${HUMAN}\n${foreign}\n\nTexto anterior.\n${renderFoundationsBlock(value)}\n\n## Otra sección\nNo se toca.\n`;
	const f = await commandFixture(t, { body }); edit(f);
	const original = parseFoundations(body, REPO); assert.ok(original.status === "valid");
	f.kb.documents[0]!.titulo = "Perillas especiales del producto";
	await savedDraft(f, ["npm publish *"]);
	const stored = f.kb.documents.at(-1)!; const result = parseFoundations(stored.cuerpo, REPO); assert.ok(result.status === "valid");
	assert.equal(stored.titulo, "Perillas especiales del producto");
	assert.deepEqual(result.block, { ...value, confirmar: ["npm publish *"] });
	assert.equal(stored.cuerpo.slice(0, result.span[0]), body.slice(0, original.span[0]));
	assert.equal(stored.cuerpo.slice(result.span[1]), body.slice(original.span[1]));
});

test("command_catalog: edición externa ajena a Foundations se relee y conserva", async (t) => {
	const f = await commandFixture(t); edit(f);
	f.kb.perillas("repo", `${HUMAN}\nOtra persona cambió esta sección.\n\n${renderFoundationsBlock(block())}\n\nPie nuevo.\n`, "bea@example.test");
	await savedDraft(f, ["npm publish *"]);
	const stored = f.kb.documents.at(-1)!;
	assert.ok(stored.cuerpo.includes("Otra persona cambió esta sección.")); assert.ok(stored.cuerpo.endsWith("\n\nPie nuevo.\n"));
});

for (const change of ["missing", "rules", "policies"] as const) test(`command_catalog: cambio concurrente ${change} durante la guía no sobrescribe ni acepta`, async (t) => {
	const f = await commandFixture(t); choose(f, "edit"); const previous = await accepted(f);
	const replacement = change === "missing" ? HUMAN : `${HUMAN}\n${renderFoundationsBlock(block(["git fetch *"], change === "policies" ? { politica: { ...STRICT_POLICY, push_pr: "auto" } } : {}))}\n`;
	const answer = changeFirstRule("npm publish *");
	f.uiControl.foundations = (screen) => { if (/· Resumen/.test(screen)) f.kb.perillas("repo", replacement); return answer(screen); };
	await assert.rejects(f.check(), /cambi|revisi|Foundations|concurr/i);
	assert.equal(saves(f).length, 0); assert.equal(f.kb.documents.at(-1)!.cuerpo, replacement);
	await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: revisión posterior durante verificación no se acepta", async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f); let changed = false;
	f.kb.hook = (tool, args) => {
		if (tool === "leer" && !changed && f.kb.documents.some((doc) => doc.id === args.id && doc.clave)) {
			changed = true; f.kb.perillas("repo", `${HUMAN}\nCambio concurrente posterior al guardado.\n${renderFoundationsBlock(block(["git fetch *"]))}\n`);
		}
	};
	await assert.rejects(f.check(), /cambi|revisi|nueva|concurr|confirm/i);
	assert.equal(changed, true); assert.equal(saves(f).length, 1);
	assert.ok(f.kb.documents.at(-1)!.cuerpo.includes("Cambio concurrente posterior"));
	await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

for (const failure of ["offline", "missing-product", "without-kb"] as const) test(`command_catalog: ${failure} no inventa persistencia ni crea productos`, async (t) => {
	// Sin KB y sin aceptada no hay diálogo: el v2 aceptado localmente es el que lo abre.
	const f = await commandFixture(t, failure === "without-kb" ? { withoutKb: true, foundations: ASK_ALL } : {}); edit(f); const previous = await accepted(f);
	if (failure === "offline") f.kb.available = "sin conexión a la KB";
	if (failure === "missing-product") f.kb.access = ["otro"];
	await assert.rejects(f.check(), /KB|producto|acceso|disponible|conexión/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	assert.deepEqual(f.kb.access, failure === "missing-product" ? ["otro"] : ["repo"]);
});

test("command_catalog: origin distinto del issue no escribe en el pin previo", async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f);
	const original = f.runner.run.bind(f.runner);
	f.runner.run = async (...args) => args[0] === "git" && args[1].join(" ") === "remote get-url origin" ? { code: 0, stdout: "https://github.com/acme/repo.git\n", stderr: "" } : original(...args);
	await assert.rejects(f.check(), /repo|origin|identidad/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

for (const body of ["```omi-foundations\n{ roto\n```\n", `${renderFoundationsBlock(block())}\n${renderFoundationsBlock(block())}\n`]) test("command_catalog: bloque inválido/ambiguo no se sobrescribe", async (t) => {
	// Un bloque inválido no vale: sin una v2 aceptada no habría diálogo. Con la v2 aceptada localmente, sí.
	const f = await commandFixture(t, { body, foundations: ASK_ALL }); edit(f);
	await assert.rejects(f.check(), /inválid|Foundations|bloque/i);
	assert.equal(saves(f).length, 0); assert.equal(f.kb.documents.at(-1)!.cuerpo, body); await noPermissionAdded(f);
});

test("command_catalog: error de guardar no ejecuta ni concede ni anuncia éxito", async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f); const before = f.messages.length;
	f.kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(f.check(), /KB|guard|persist/i);
	assert.ok(saves(f).length > 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	assert.doesNotMatch(f.messages.slice(before).join("\n"), /Foundations guardado|guardado y aceptado/i);
});

for (const failure of ["error", "wrong-body", "wrong-product"] as const) test(`command_catalog: verificación ${failure} no acepta una persistencia no confirmada`, async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f);
	const read = f.kb.read.bind(f.kb);
	f.kb.read = async (id, signal) => {
		const doc = await read(id, signal);
		if (!f.kb.documents.some((stored) => stored.id === id && stored.clave)) return doc;
		if (failure === "error") throw new Error("falló la lectura de confirmación de la KB");
		return failure === "wrong-body" ? { ...doc, cuerpo: "otro contenido" } : { ...doc, producto: "otro" };
	};
	await assert.rejects(f.check(), /KB|contenido|confirm|guard/i);
	assert.equal(saves(f).length, 1); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: aceptación local fallida preserva el destino ajeno y el pin previo", async (t) => {
	const f = await commandFixture(t); edit(f); const previousPin = f.session.foundations.current(f.context);
	const path = trustPath(foundationsDir(f.home), key(f)); const target = join(f.home, "do-not-touch.json");
	await writeFile(target, "no modificar\n"); await unlink(path); await symlink(target, path);
	await assert.rejects(f.check(), /(?:KB|guard).*(?:local|acept|registro)|(?:local|acept|registro).*(?:KB|guard)/is);
	assert.equal(saves(f).length, 1); assert.equal(await readFile(target, "utf8"), "no modificar\n");
	assert.deepEqual(f.session.foundations.current(f.context), previousPin); await noPermissionAdded(f);
});

test("command_catalog: respuesta perdida usa misma clave y jamás ejecuta el pendiente", async (t) => {
	const f = await commandFixture(t); edit(f); let first = true;
	f.kb.hook = (tool) => { if (tool === "guardar" && first) { first = false; return "drop"; } };
	await assert.rejects(f.check(), /reintent|no se ejecut/i);
	const calls = saves(f); assert.equal(calls.length, 2);
	assert.equal(typeof calls[0]!.args.clave, "string"); assert.equal(calls[0]!.args.clave, calls[1]!.args.clave);
	const saved = f.kb.documents.filter((doc) => doc.clave); assert.equal(saved.length, 1);
	assert.equal((await accepted(f))?.accepted?.docId, saved[0]!.id); await noPermissionAdded(f);
});

test("command_catalog: pausa durante guardar permite documento remoto pero no aceptación/grant/ejecución", async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f);
	const save = f.kb.save.bind(f.kb);
	f.kb.save = async (input, signal) => { const result = await save(input, signal); await f.action({ action: "pause", reason: "Otra ventana pausó mientras guardaba" }); return result; };
	await assert.rejects(f.check(), /cambi|paus|vigente|retom|desactual/i);
	assert.equal(saves(f).length, 1); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: aborto después de envío KB no reintenta ni acepta", async (t) => {
	const f = await commandFixture(t); edit(f); const previous = await accepted(f); const controller = new AbortController();
	const save = f.kb.save.bind(f.kb);
	f.kb.save = async (input, signal) => { await save(input, signal); controller.abort(); throw new Error("respuesta perdida después del aborto"); };
	await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel|confirm|KB/i);
	assert.equal(saves(f).length, 1); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

// Los fallos parciales, claves estables y cancelaciones de commitFoundationsSave tienen además
// cobertura dedicada en development-foundations-save.test.ts; aquí se comprueba el diálogo integrado.
