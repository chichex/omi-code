// Persistencia del permiso en el catálogo existente, sin KB real ni una segunda lista de comandos.
import assert from "node:assert/strict";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commandAuthorization } from "../src/harness/authorization.ts";
import { MAX_COMMANDS, STRICT_POLICY, parseFoundations, renderFoundationsBlock } from "../src/harness/foundations.ts";
import { foundationsDir, trustPath, writeTrust, type TrustRecord } from "../src/harness/foundations-trust.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import { FoundationsGate, decideFoundations, effectivePolicy, readFoundations } from "../src/tui/development-foundations.ts";
import { COMMAND, HUMAN, KNOWN, REPO, accepted, authorizations, block, choose, commandFixture, key, noPermissionAdded, saves } from "./helpers/command-permissions.ts";

const OTHER = 'node -e "process.exitCode = 0"';

for (const reason of [undefined, new DOMException("Se agotó el tiempo de guardado", "TimeoutError")]) test(`command_catalog: ${reason ? "timeout" : "aborto"} durante la aceptación completada informa el permiso durable`, async (t) => {
	const f = await commandFixture(t); const controller = new AbortController(); let writes = 0;
	const next = block([KNOWN, COMMAND]);
	const prepared = await prepareFoundationsSave(f.kb, key(f), next, controller.signal);
	const deps = { trustDir: foundationsDir(f.home), now: () => "2026-11-19T00:00:00Z", signal: controller.signal, requireLatest: true,
		writeAcceptance: async (dir: string, record: TrustRecord) => {
			await writeTrust(dir, record); writes++; controller.abort(reason);
		} };
	await assert.rejects(commitFoundationsSave(f.kb, key(f), next, prepared, deps), /guardado.*KB.*aceptado.*no se ejecut/is);
	assert.equal(writes, 1, "la cancelación está coordinada con la escritura, sin timers ni sleeps");
	assert.equal((await accepted(f))?.accepted?.docId, f.kb.documents.at(-1)!.id);
	assert.ok((await accepted(f))?.accepted?.block.comandos.includes(COMMAND));
	assert.deepEqual(f.executed, []); assert.deepEqual((await f.state()).grants ?? [], []);
});

for (const missing of [false, true]) test(`command_catalog: la revisión usada para componer también debe coincidir con el pin (${missing ? "ausencia" : "bloque"})`, async (t) => {
	const f = await commandFixture(t, missing ? { body: null } : {}); choose(f, "always");
	const previous = await accepted(f); const current = f.kb.currentPerillas.bind(f.kb); let reads = 0;
	f.kb.currentPerillas = async (product, signal) => {
		if (++reads === 2) f.kb.perillas("repo", `${HUMAN}\n${renderFoundationsBlock(block([KNOWN, OTHER]))}\n`);
		return current(product, signal);
	};
	await assert.rejects(f.check(), /cambi|revisi|Foundations|concurr/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	const remote = parseFoundations(f.kb.documents.at(-1)!.cuerpo, REPO);
	assert.equal(remote.status, "valid"); assert.ok(remote.status === "valid");
	assert.ok(remote.block.comandos.includes(OTHER), "el comando concurrente exacto sigue en el bloque remoto");
});

test("command_catalog: la desaparición de un bloque aceptado no habilita reconstruirlo desde el pin viejo", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const previous = await accepted(f);
	f.kb.perillas("repo", HUMAN);
	await assert.rejects(f.check(), /cambi|revisi|Foundations|bloque/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: una sesión nueva sin cache y otro trabajo del mismo repo usan el permiso sin preguntar", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); await f.check();
	const confirmations: string[] = [];
	const ctx = { ...f.context, sessionManager: SessionManager.create(f.checkout.root, join(f.home, "new-sessions")) };
	assert.notEqual(ctx.sessionManager.getSessionFile(), f.manager.getSessionFile(), "no reutiliza el pin cacheado por archivo de sesión");
	const gate = new FoundationsGate({ kb: f.kb, runner: f.runner, trustDir: foundationsDir(f.home), now: () => "2026-11-19T00:00:00Z", confirm: async (_ctx, title) => { confirmations.push(title); return false; } });
	const first = await f.state();
	const otherWork = { ...first, id: "otro-trabajo", source: { ...first.source, number: 43, url: "https://github.com/test/repo/issues/43" }, grants: [] };
	const policy = await gate.policy(ctx, otherWork);
	assert.equal(commandAuthorization(otherWork, COMMAND, policy.command), "catalog");
	assert.deepEqual(confirmations, [], "la aceptación durable evita otro diálogo en otra sesión/trabajo");
	assert.equal(gate.current(ctx)?.docId, f.kb.documents.at(-1)!.id);
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 1);
	// La lectura y decisión sin Gate simulan además un proceso sin ningún cache en memoria.
	const reading = await readFoundations(f.kb, ctx.cwd, f.runner, AbortSignal.timeout(5000));
	const pin = await decideFoundations(reading, ctx, { trustDir: foundationsDir(f.home), now: () => "2026-11-19T00:00:01Z", confirm: async () => { assert.fail("la revisión aceptada no vuelve a preguntar sin cache"); } });
	assert.ok(pin.block?.comandos.includes(COMMAND)); assert.deepEqual(confirmations, []);
});

test("command_catalog: otro owner/repo con el mismo producto no hereda catálogo ni aceptación local", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); await f.check();
	const ctx = { ...f.context, sessionManager: SessionManager.create(f.checkout.root, join(f.home, "foreign-sessions")) };
	const runner = { run: async (...args: Parameters<typeof f.runner.run>) => args[0] === "git" && args[1].join(" ") === "remote get-url origin" ? { code: 0, stdout: "https://github.com/acme/repo.git\n", stderr: "" } : f.runner.run(...args) };
	const gate = new FoundationsGate({ kb: f.kb, runner, trustDir: foundationsDir(f.home), now: () => "2026-11-19T00:00:00Z", confirm: async () => { assert.fail("no hay revisión de acme/repo para aceptar"); } });
	const state = await f.state(); const foreign = { ...state, source: { ...state.source, url: "https://github.com/acme/repo/issues/42" }, grants: [] };
	const policy = await gate.policy(ctx, foreign);
	assert.deepEqual(policy.command, { catalog: [], outside: "ask" });
	assert.equal(commandAuthorization(foreign, COMMAND, policy.command), "ask");
	assert.equal(gate.current(ctx)?.origin, "strict");
	assert.deepEqual(effectivePolicy(f.session.foundations.current(f.context), foreign).command.catalog, [], "tampoco alcanza arrastrar el pin del otro repo");
});

test("command_catalog: conserva byte a byte lo ajeno al bloque, sus comandos y sus políticas", async (t) => {
	const value = block([KNOWN, OTHER], { politica: { ...STRICT_POLICY, arranque: "auto", receta: "auto", push_pr: "auto" } });
	const foreign = renderFoundationsBlock(block(["npm test"], { repo: "acme/repo" }));
	const body = `${HUMAN}\n${foreign}\n\nTexto anterior.\n${renderFoundationsBlock(value)}\n\n## Otra sección\nNo se toca.\n`;
	const f = await commandFixture(t, { body }); choose(f, "always");
	const original = parseFoundations(body, REPO); assert.equal(original.status, "valid");
	f.kb.documents[0]!.titulo = "Perillas especiales del producto";
	await f.check();
	const stored = f.kb.documents.at(-1)!; const result = parseFoundations(stored.cuerpo, REPO);
	assert.equal(result.status, "valid"); assert.equal(stored.titulo, "Perillas especiales del producto");
	assert.ok(result.status === "valid" && original.status === "valid");
	assert.deepEqual(result.block, { ...value, comandos: [...value.comandos, COMMAND] });
	assert.equal(stored.cuerpo.slice(0, result.span[0]), body.slice(0, original.span[0]));
	assert.equal(stored.cuerpo.slice(result.span[1]), body.slice(original.span[1]));
	assert.equal(saves(f).length, 1); assert.deepEqual((await f.state()).grants ?? [], []);
});

test("command_catalog: una edición ajena fuera de Foundations se relee y se conserva al guardar", async (t) => {
	const f = await commandFixture(t); choose(f, "always");
	const updated = `${HUMAN}\nOtra persona cambió esta sección.\n\n${renderFoundationsBlock(block())}\n\nPie nuevo.\n`;
	f.kb.perillas("repo", updated, "bea@example.test");
	await f.check();
	const stored = f.kb.documents.at(-1)!;
	assert.ok(stored.cuerpo.includes("Otra persona cambió esta sección.")); assert.ok(stored.cuerpo.endsWith("\n\nPie nuevo.\n"));
	assert.equal(saves(f).length, 1); assert.deepEqual(f.executed, [COMMAND]);
});

for (const body of [null, `${HUMAN}\n${renderFoundationsBlock(block(["npm test"], { repo: "acme/repo" }))}\n`]) test(`command_catalog: sin bloque del repo crea sólo su comando y política estricta (${body === null ? "sin perillas" : "otro bloque"})`, async (t) => {
	const f = await commandFixture(t, { body }); choose(f, "always"); await f.check();
	const stored = f.kb.documents.at(-1)!; const result = parseFoundations(stored.cuerpo, REPO);
	assert.equal(result.status, "valid"); assert.ok(result.status === "valid");
	assert.deepEqual(result.block, block([COMMAND]));
	if (body !== null) assert.ok(stored.cuerpo.startsWith(body), "no toca el otro bloque");
	else assert.ok(stored.cuerpo.startsWith("# Perillas de repo\n\n"));
	assert.equal((await accepted(f))?.accepted?.docId, stored.id); assert.deepEqual(f.executed, [COMMAND]);
});

test("command_catalog: un bloque distinto del pin no acepta silenciosamente nuevos comandos ni políticas", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const previous = await accepted(f);
	f.kb.perillas("repo", `${HUMAN}\n${renderFoundationsBlock(block([KNOWN, OTHER], { politica: { ...STRICT_POLICY, fuera_de_catalogo: "auto", push_pr: "auto" } }))}\n`);
	await assert.rejects(f.check(), /cambi|revisi|Foundations|concurr/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	assert.deepEqual(f.session.foundations.current(f.context)?.block, block(), "ningún comando/política nuevos fueron aceptados por elegir sólo COMMAND");
});

test("command_catalog: detecta una revisión posterior durante la verificación, no la acepta ni ejecuta", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const previous = await accepted(f); let changed = false;
	f.kb.hook = (tool, args) => {
		if (tool === "leer" && !changed && f.kb.documents.some((doc) => doc.id === args.id && doc.clave)) {
			changed = true; f.kb.perillas("repo", `${HUMAN}\nCambio concurrente posterior al guardado.\n\n${renderFoundationsBlock(block([KNOWN, OTHER]))}\n`);
		}
	};
	await assert.rejects(f.check(), /cambi|revisi|nueva|concurr|confirm/i);
	assert.equal(changed, true, "el conflicto ocurre después del guardado, no antes de decidir");
	assert.equal(saves(f).length, 1, "el documento que pudo guardarse no se borra ni se oculta");
	assert.ok(f.kb.documents.at(-1)!.cuerpo.includes("Cambio concurrente posterior"));
	await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

for (const failure of ["offline", "missing-product", "without-kb"] as const) test(`command_catalog: ${failure} no crea permisos ni productos de modo implícito`, async (t) => {
	const f = await commandFixture(t, failure === "without-kb" ? { withoutKb: true } : {}); choose(f, "always");
	if (failure === "offline") f.kb.available = "sin conexión a la KB";
	if (failure === "missing-product") f.kb.access = ["otro"];
	await assert.rejects(f.check(), /KB|producto|acceso|disponible|conexión/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	assert.deepEqual(f.kb.access, failure === "missing-product" ? ["otro"] : ["repo"]);
});

test("command_catalog: un origin distinto del repo del issue no permite guardar en el pin previo", async (t) => {
	const f = await commandFixture(t); choose(f, "always");
	const original = f.runner.run.bind(f.runner);
	f.runner.run = async (...args) => args[0] === "git" && args[1].join(" ") === "remote get-url origin" ? { code: 0, stdout: "https://github.com/acme/repo.git\n", stderr: "" } : original(...args);
	await assert.rejects(f.check(), /repo|origin|identidad/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

for (const body of ["```omi-foundations\n{ roto\n```\n", `${renderFoundationsBlock(block())}\n${renderFoundationsBlock(block())}\n`]) test("command_catalog: un bloque inválido o ambiguo no se sobrescribe para conceder el permiso", async (t) => {
	const f = await commandFixture(t, { body }); choose(f, "always");
	await assert.rejects(f.check(), /inválid|Foundations|bloque/i);
	assert.equal(saves(f).length, 0); assert.equal(f.kb.documents.at(-1)!.cuerpo, body); await noPermissionAdded(f);
});

for (const command of [" node test.cjs", "node test.cjs ", "node test.cjs\nnode other-test.cjs", "node\u200b test.cjs", "x".repeat(2001)]) test(`command_catalog: valida el comando exacto antes de persistir (${JSON.stringify(command).slice(0, 45)})`, async (t) => {
	const f = await commandFixture(t); choose(f, "always");
	await assert.rejects(f.check(command), /comando|inválid|caracter|espacio|2000/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f, command);
});

test("command_catalog: el límite de 100 comandos falla cerrado sin truncar el catálogo previo", async (t) => {
	const commands = Array.from({ length: MAX_COMMANDS }, (_, n) => `node -e \"process.exitCode = ${n}\"`);
	const f = await commandFixture(t, { value: block(commands) }); choose(f, "always"); const previous = await accepted(f);
	await assert.rejects(f.check(), /100|límite|catálogo|esquema|comandos/i);
	assert.equal(saves(f).length, 0); assert.deepEqual(await accepted(f), previous); await noPermissionAdded(f);
});

test("command_catalog: un error de guardar no ejecuta, no concede grant ni anuncia éxito", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const previous = await accepted(f); const before = f.messages.length;
	f.kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(f.check(), /KB|guard|persist/i);
	assert.ok(saves(f).length > 0, "intentó el guardado solicitado");
	await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
	assert.doesNotMatch(f.messages.slice(before).join("\n"), /Foundations guardado|permitido permanentemente|guardado y aceptado/i);
});

for (const failure of ["error", "wrong-body", "wrong-product"] as const) test(`command_catalog: verificación ${failure} tras guardar no acepta ni ejecuta una persistencia no confirmada`, async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const previous = await accepted(f);
	const read = f.kb.read.bind(f.kb);
	f.kb.read = async (id, signal) => {
		const doc = await read(id, signal);
		if (!f.kb.documents.some((stored) => stored.id === id && stored.clave)) return doc;
		if (failure === "error") throw new Error("falló la lectura de confirmación de la KB");
		return failure === "wrong-body" ? { ...doc, cuerpo: "otro contenido" } : { ...doc, producto: "otro" };
	};
	await assert.rejects(f.check(), /KB|contenido|confirm|guard/i);
	assert.equal(saves(f).length, 1, "el documento pudo guardarse, no se reejecuta el comando como fallback");
	await noPermissionAdded(f); assert.deepEqual(await accepted(f), previous);
});

test("command_catalog: si falla la aceptación local informa el resultado parcial sin ejecutar ni cambiar el pin", async (t) => {
	const f = await commandFixture(t); choose(f, "always");
	const path = trustPath(foundationsDir(f.home), key(f)); const target = join(f.home, "do-not-touch.json");
	await writeFile(target, "no modificar\n"); await unlink(path); await symlink(target, path);
	await assert.rejects(f.check(), /(?:KB|guard).*(?:local|acept|registro)|(?:local|acept|registro).*(?:KB|guard)/is, "explica que la KB pudo guardar pero no confirmó la aceptación local");
	assert.equal(saves(f).length, 1); assert.equal(await readFile(target, "utf8"), "no modificar\n");
	await noPermissionAdded(f);
});

test("command_catalog: una respuesta perdida se recupera con la misma clave, sin duplicar permiso ni ejecutar dos veces", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); let first = true;
	f.kb.hook = (tool) => { if (tool === "guardar" && first) { first = false; return "drop"; } };
	await f.check();
	const calls = saves(f); assert.equal(calls.length, 2);
	assert.equal(typeof calls[0]!.args.clave, "string"); assert.equal(calls[0]!.args.clave, calls[1]!.args.clave);
	const saved = f.kb.documents.filter((doc) => { const parsed = parseFoundations(doc.cuerpo, REPO); return parsed.status === "valid" && parsed.block.comandos.includes(COMMAND); });
	assert.equal(saved.length, 1); assert.equal((await accepted(f))?.accepted?.docId, saved[0]!.id);
	assert.deepEqual(f.executed, [COMMAND]); assert.deepEqual((await f.state()).grants ?? [], []);
	choose(f, "no"); await f.check();
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 2); assert.deepEqual(f.executed, [COMMAND, COMMAND]);
});
