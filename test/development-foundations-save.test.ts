// Persistencia de Foundations v2 aislada de la TUI: KB en memoria y aceptación en un directorio temporal.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { FoundationsBlock } from "../src/harness/foundations.ts";
import type { TrustRecord } from "../src/harness/foundations-trust.ts";
import type { FoundationsPin } from "../src/tui/development-foundations.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "../src/tui/development-foundations-save.ts";
import type { KbDoc } from "../src/tui/kb-client.ts";
import { tempDir } from "./helpers/io.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";

const REPO = "test/repo";
const NOW = "2026-11-19T04:00:00Z";
const HUMAN = "# Perillas de repo\r\n\r\nTono: formal.\r\n\r\n```json\r\n{ \"otra\": \"perilla\" }\r\n```\r\n";
const block = (confirmar = ["git push *"]): FoundationsBlock => ({ version: 2, repo: REPO, confirmar, politica: { arranque: "ask", receta: "ask", push_pr: "ask" } });
const render = (value: unknown) => `\`\`\`omi-foundations\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const hash = (value: FoundationsBlock) => createHash("sha256").update(JSON.stringify({ version: value.version, repo: value.repo, confirmar: [...value.confirmar].sort(), politica: { arranque: value.politica.arranque, receta: value.politica.receta, push_pr: value.politica.push_pr } })).digest("hex");
const key = (kb: MemoryKb) => ({ kbUrl: kb.url, product: "repo", repo: REPO });
const saves = (kb: MemoryKb) => kb.calls.filter((call) => call.tool === "guardar");
const legacy = (repo = REPO) => ({ version: 1, repo, comandos: ["npm test"], politica: { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } });
const UNCONFIRMED = "No se pudo confirmar el guardado de Foundations en la KB; pudo haberse guardado.";
const NOT_ACCEPTED = "Foundations se guardó en la KB, pero no se completó su verificación o aceptación local.";
const ACCEPTED = "Foundations quedó guardado en la KB y aceptado localmente para futuras sesiones, pero no se ejecutó el comando.";

async function fixture(t: TestContext, body: string | null = HUMAN) {
	const kb = memoryKb({ products: ["repo"] });
	const previous = body === null ? null : kb.perillas("repo", body);
	const controller = new AbortController(); const trustDir = await tempDir(t);
	const deps = { trustDir, now: () => NOW, signal: controller.signal };
	return { kb, previous, controller, deps, trustDir, key: key(kb), block: block() };
}
async function acceptance(dir: string): Promise<unknown> {
	const names = await readdir(dir); assert.equal(names.length, 1, "un solo registro, sin temporales");
	const name = names[0]; assert.ok(name); assert.match(name, /^[a-f0-9]{32}\.json$/);
	const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8")); return value;
}
function expectedAcceptance(f: Awaited<ReturnType<typeof fixture>>, pin: FoundationsPin, value = f.block): TrustRecord {
	return { version: 2, ...f.key, offerDeclined: false, accepted: { docId: pin.docId ?? "", blockHash: hash(value), block: value, author: pin.author ?? "", date: pin.date ?? "", acceptedAt: NOW } };
}

for (const initial of [null, HUMAN]) {
	test(`foundations_save: guardar explícitamente v2 ${initial === null ? "crea perillas" : "preserva las perillas existentes"} y acepta sólo esa revisión`, async (t) => {
		const f = await fixture(t, initial);
		const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal, null);
		assert.deepEqual(prepared.previous, f.previous);
		assert.ok(prepared.body.startsWith(initial ?? "# Perillas de repo\n\n"));
		assert.ok(prepared.body.includes(render(f.block)));
		assert.equal(saves(f.kb).length, 0, "preparar no guarda ni acepta");
		assert.deepEqual(await readdir(f.trustDir), []);
		const pins: FoundationsPin[] = [];
		const pin = await commitFoundationsSave(f.kb, f.key, f.block, prepared, { ...f.deps, onAccepted: (accepted) => pins.push(accepted) });
		assert.equal(saves(f.kb).length, 1);
		const saved = f.kb.documents.at(-1); assert.ok(saved);
		assert.equal(saved.cuerpo, prepared.body); assert.equal(saved.titulo, f.previous?.titulo ?? "Perillas de repo");
		assert.equal(pin.origin, "kb"); assert.equal(pin.docId, saved.id); assert.equal(pin.hash, hash(f.block));
		assert.deepEqual(pin.block, f.block); assert.equal(pin.notice, ""); assert.deepEqual(pins, [pin]);
		assert.deepEqual(await acceptance(f.trustDir), expectedAcceptance(f, pin));
	});
}

test("foundations_save: preparar/reabrir sólo lee, no modifica KB ni aceptación y conserva una clave determinista", async (t) => {
	const f = await fixture(t, `${HUMAN}\n${render(block())}\n`);
	const before = JSON.stringify(f.kb.documents);
	const first = await prepareFoundationsSave(f.kb, f.key, block(["git push *", "npm run deploy"]), f.deps.signal, hash(f.block));
	const again = await prepareFoundationsSave(f.kb, f.key, block(["git push *", "npm run deploy"]), f.deps.signal, hash(f.block));
	assert.deepEqual(again, first);
	assert.equal(JSON.stringify(f.kb.documents), before, "la lectura no toca los documentos, tampoco v2 vigente");
	assert.deepEqual(await readdir(f.trustDir), []);
	assert.ok(f.kb.calls.every((call) => ["buscar", "leer"].includes(call.tool)), "no hay persistencia al abrir/preparar");
});

test("foundations_save: reemplazar v1 es un guardado explícito, acotado al bloque único y sin trasladar autorizaciones", async (t) => {
	const prefix = `${HUMAN}\n${render(legacy("other/repo"))}\n\n<!-- conservar  dos espacios -->\r\n`;
	const suffix = "\r\n\r\n## Otra política\r\nTexto sin normalizar.  \r\n";
	const f = await fixture(t, `${prefix}${render(legacy())}${suffix}`);
	const before = JSON.stringify(f.kb.documents); const empty = block([]);
	const prepared = await prepareFoundationsSave(f.kb, f.key, empty, f.deps.signal);
	assert.equal(prepared.body, `${prefix}${render(empty)}${suffix}`, "todo byte fuera de ese bloque queda intacto");
	assert.equal(JSON.stringify(f.kb.documents), before, "preparar v1 no lo migra en la KB");
	assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
	const pin = await commitFoundationsSave(f.kb, f.key, empty, prepared, f.deps);
	assert.equal(saves(f.kb).length, 1); assert.equal(f.kb.documents.at(-1)?.cuerpo, prepared.body);
	assert.deepEqual(pin.block, empty, "ni comandos ni políticas auto v1 se heredan");
	assert.deepEqual(await acceptance(f.trustDir), expectedAcceptance(f, pin, empty));
});

test("foundations_save: expectedHash protege v2 y ausencia explícita; v1 no se interpreta como una ausencia aceptada", async (t) => {
	for (const [body, expectation] of [
		[`${HUMAN}\n${render(block())}`, null],
		[HUMAN, hash(block())],
		[`${HUMAN}\n${render(block())}`, "0".repeat(64)],
		[`${HUMAN}\n${render(legacy())}`, null],
	] satisfies [string, string | null][]) {
		const f = await fixture(t, body);
		await assert.rejects(prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal, expectation), /cambió|obsoleto|inválido/i);
		assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
	}
});

test("foundations_save: no reemplaza a ciegas un bloque ambiguo, ajeno o mal formado", async (t) => {
	for (const body of [
		`${HUMAN}\n${render(legacy())}\n${render(legacy())}`,
		`${HUMAN}\n\`\`\`omi-foundations\n{ roto\n\`\`\``,
		`${HUMAN}\n${render({ version: 1, comandos: [] })}`,
		`${HUMAN}\n${render(legacy("Test/Repo"))}`,
		`${HUMAN}\n\`\`\`omi-foundations\n${JSON.stringify(legacy())}`,
	]) {
		const f = await fixture(t, body); const before = JSON.stringify(f.kb.documents);
		await assert.rejects(prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal), /inválid|bloque|cerca/i);
		assert.equal(JSON.stringify(f.kb.documents), before);
		assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
	}
});

test("foundations_save: entradas runtime con bloque inválido no llegan al guardado", async (t) => {
	const f = await fixture(t);
	const values: unknown[] = [{ ...f.block, confirmar: [""] }, { ...f.block, confirmar: ["echo\u200b"] }, { ...f.block, repo: "another/repo" }, legacy()];
	for (const value of values) {
		await assert.rejects(() => Reflect.apply(prepareFoundationsSave, undefined, [f.kb, f.key, value, f.deps.signal]), /inválid|regla|bloque|obsoleto/i);
	}
	assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
});

test("foundations_save: control optimista antes del envío detecta otra revisión y cambios de bytes con el mismo id", async (t) => {
	for (const mode of ["otra-revision", "mismo-id"] as const) {
		const f = await fixture(t); assert.ok(f.previous);
		const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal, null);
		if (mode === "otra-revision") f.kb.perillas("repo", "Otra persona guardó.");
		else f.previous.cuerpo += "Otra persona editó el mismo id.";
		await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, f.deps), /cambiaron.*antes de guardar/i);
		assert.equal(saves(f.kb).length, 0, mode); assert.deepEqual(await readdir(f.trustDir), []);
	}
});

test("foundations_save: respuesta perdida recupera el mismo artefacto con la misma clave, sin duplicar", async (t) => {
	const f = await fixture(t); let lost = false;
	const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	f.kb.hook = (tool) => { if (tool === "guardar" && !lost) { lost = true; return "drop"; } };
	const pin = await commitFoundationsSave(f.kb, f.key, f.block, prepared, f.deps);
	const calls = saves(f.kb); assert.equal(calls.length, 2);
	assert.deepEqual(calls[0]?.args, calls[1]?.args, "mismo contenido y clave, no otra propuesta");
	assert.equal(calls[0]?.args.clave, prepared.clave);
	assert.equal(f.kb.documents.length, 2, "documento anterior y una sola revisión nueva");
	assert.deepEqual(await acceptance(f.trustDir), expectedAcceptance(f, pin));
});

test("foundations_save: sin KB no se inventa un guardado ni se acepta localmente", async (t) => {
	const f = await fixture(t); f.kb.available = "sin login";
	await assert.rejects(prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal), /sin login/);
	assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
});

test("foundations_save: error de envío conserva estado incierto y nunca crea una aceptación", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	f.kb.hook = (tool) => tool === "guardar" ? "error" : undefined;
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, f.deps), (error: unknown) => {
		assert.ok(error instanceof Error); assert.ok(error.message.startsWith(UNCONFIRMED)); return true;
	});
	assert.equal(saves(f.kb).length, 2); assert.equal(f.kb.documents.length, 1); assert.deepEqual(await readdir(f.trustDir), []);
});

for (const [name, patch] of [
	["cuerpo", { cuerpo: "otro contenido" }],
	["producto", { producto: "otro" }],
	["id", { id: "otro-id" }],
	["tipo", { tipo: "contexto" }],
] satisfies [string, Partial<KbDoc>][]) {
	test(`foundations_save: verificar lectura con ${name} incorrecto no acepta ni informa éxito`, async (t) => {
		const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
		const read = f.kb.read; const pins: FoundationsPin[] = [];
		f.kb.read = async (id, signal) => { const doc = await read(id, signal); return id === f.previous?.id ? doc : { ...doc, ...patch }; };
		await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, { ...f.deps, onAccepted: (pin) => pins.push(pin) }), (error: unknown) => {
			assert.ok(error instanceof Error); assert.ok(error.message.startsWith(UNCONFIRMED)); assert.match(error.message, /otro contenido|documento/); return true;
		});
		assert.equal(saves(f.kb).length, 1); assert.equal(f.kb.documents.length, 2, "la revisión enviada puede existir");
		assert.deepEqual(await readdir(f.trustDir), []); assert.deepEqual(pins, []);
	});
}

test("foundations_save: fallo al releer la revisión enviada informa estado incierto sin aceptación", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	f.kb.hook = (tool, args) => tool === "leer" && args.id !== f.previous?.id ? "error" : undefined;
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, f.deps), (error: unknown) => {
		assert.ok(error instanceof Error); assert.ok(error.message.startsWith(UNCONFIRMED)); assert.match(error.message, /leer respondió un error/); return true;
	});
	assert.equal(saves(f.kb).length, 1); assert.deepEqual(await readdir(f.trustDir), []);
});

test("foundations_save: exige revisión vigente; si cambió antes de aceptar no se acepta una revisión vieja", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	let changed = false; const pins: FoundationsPin[] = [];
	f.kb.hook = (tool) => {
		if (tool === "buscar" && saves(f.kb).length && !changed) { changed = true; f.kb.perillas("repo", "Una revisión todavía más nueva."); }
	};
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, { ...f.deps, onAccepted: (pin) => pins.push(pin) }), (error: unknown) => {
		assert.ok(error instanceof Error); assert.ok(error.message.startsWith(NOT_ACCEPTED)); assert.match(error.message, /más nueva|cambiaron/); return true;
	});
	assert.equal(saves(f.kb).length, 1); assert.equal(f.kb.documents.length, 3);
	assert.deepEqual(await readdir(f.trustDir), []); assert.deepEqual(pins, []);
});

test("foundations_save: fallo de aceptación local distingue KB guardada de aceptación no completada", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal); const pins: FoundationsPin[] = [];
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, {
		...f.deps, writeAcceptance: async () => { throw new Error("disco sin espacio"); }, onAccepted: (pin) => pins.push(pin),
	}), { message: `${NOT_ACCEPTED} disco sin espacio` });
	assert.equal(saves(f.kb).length, 1); assert.equal(f.kb.documents.length, 2);
	assert.deepEqual(await readdir(f.trustDir), []); assert.deepEqual(pins, []);
});

test("foundations_save: abortar antes de preparar o de enviar no guarda, reintenta ni acepta", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	f.controller.abort(new Error("cancelado antes de guardar"));
	await assert.rejects(prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal), /cancelado antes de guardar/);
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, f.deps), /cancelado antes de guardar/);
	assert.equal(saves(f.kb).length, 0); assert.deepEqual(await readdir(f.trustDir), []);
});

for (const lostResponse of [false, true]) {
	test(`foundations_save: abortar después del envío ${lostResponse ? "con respuesta perdida" : "con respuesta recibida"} no reintenta ni acepta`, async (t) => {
		const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal); const pins: FoundationsPin[] = [];
		f.kb.hook = (tool) => {
			if (tool === "guardar") { f.controller.abort(new Error("cancelado tras enviar")); if (lostResponse) return "drop"; }
		};
		await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, { ...f.deps, onAccepted: (pin) => pins.push(pin) }), { message: `${UNCONFIRMED} cancelado tras enviar` });
		assert.equal(saves(f.kb).length, 1, "un aborto jamás dispara el retry idempotente");
		assert.equal(f.kb.documents.length, 2, "no se promete deshacer el documento ya enviado");
		assert.deepEqual(await readdir(f.trustDir), []); assert.deepEqual(pins, []);
	});
}

test("foundations_save: aborto entre verificación KB y aceptación local no escribe ni llama onAccepted", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal); const pins: FoundationsPin[] = [];
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, {
		...f.deps, beforeAccept: async () => { f.controller.abort(new Error("cancelado antes de aceptar")); }, onAccepted: (pin) => pins.push(pin),
	}), { message: `${NOT_ACCEPTED} cancelado antes de aceptar` });
	assert.equal(saves(f.kb).length, 1); assert.deepEqual(await readdir(f.trustDir), []); assert.deepEqual(pins, []);
});

test("foundations_save: onAccepted observa aceptación durable; abortar ahí conserva el pin y comunica el estado parcial preciso", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal); const pins: FoundationsPin[] = [];
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, {
		...f.deps, onAccepted: (pin) => {
			const names = readdirSync(f.trustDir); assert.equal(names.length, 1); const name = names[0]; assert.ok(name);
			const durable: unknown = JSON.parse(readFileSync(join(f.trustDir, name), "utf8"));
			assert.deepEqual(durable, expectedAcceptance(f, pin), "el callback no precede a la escritura durable");
			pins.push(pin); f.controller.abort(new Error("cancelado después de aceptar"));
		},
	}), { message: `${ACCEPTED} cancelado después de aceptar` });
	assert.equal(pins.length, 1); const pin = pins[0]; assert.ok(pin);
	assert.equal(saves(f.kb).length, 1); assert.deepEqual(await acceptance(f.trustDir), expectedAcceptance(f, pin));
});

test("foundations_save: un error del callback posterior no oculta una aceptación ya durable", async (t) => {
	const f = await fixture(t); const prepared = await prepareFoundationsSave(f.kb, f.key, f.block, f.deps.signal);
	let callbackPin: FoundationsPin | undefined;
	await assert.rejects(commitFoundationsSave(f.kb, f.key, f.block, prepared, {
		...f.deps, onAccepted: (pin) => { callbackPin = pin; throw new Error("falló actualización de la vista"); },
	}), { message: `${ACCEPTED} falló actualización de la vista` });
	assert.ok(callbackPin); assert.deepEqual(await acceptance(f.trustDir), expectedAcceptance(f, callbackPin));
	assert.equal(saves(f.kb).length, 1);
});
