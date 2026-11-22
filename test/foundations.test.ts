import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as foundations from "../src/harness/foundations.ts";
import type { FoundationsBlock } from "../src/harness/foundations.ts";

const { checkBlock, composePerillas, DEFAULT_POLICY, foundationsDiff, foundationsHash, parseFoundations, readFoundationsText, renderFoundationsBlock, STRICT_POLICY, visibleText } = foundations;
const REPO = "chichex/omi-code";
type Policy = { arranque: "ask" | "auto"; receta: "ask" | "auto"; push_pr: "ask" | "auto" };
type Block = { version: 2; repo: string; confirmar: string[]; politica: Policy };
const block = (overrides: Partial<Block> = {}): Block => ({ version: 2, repo: REPO, confirmar: ["git push *", "npm publish", "rm *"], politica: { arranque: "ask", receta: "ask", push_pr: "ask" }, ...overrides });
const legacy = (repo = REPO) => ({ version: 1, repo, comandos: ["npm ci", "npm test"], politica: { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } });
const fenced = (value: unknown, fence = "```") => `${fence}omi-foundations\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n${fence}`;
const doc = (...parts: string[]) => ["# Perillas de omi-code", "Otras perillas: tono formal.", ...parts, "## Cierre", "Texto humano final."].join("\n\n");
const meta = { product: "omi-code", kbUrl: "https://kb.example.test/mcp" };

// El contrato v2 se valida en runtime: el rojo inicial no depende de importar un módulo/export inexistente.
function validated(value: unknown = block()): FoundationsBlock {
	const checked = checkBlock(value);
	assert.ok("block" in checked, "reason" in checked ? checked.reason : "falta el valor validado");
	return checked.block;
}
function reason(value: unknown): string {
	const checked = checkBlock(value);
	assert.ok("reason" in checked && !("block" in checked), "se aceptó un bloque inválido");
	return checked.reason;
}
function assertVisibleEscape(text: string, codePoint: number): void {
	const hex = codePoint.toString(16);
	const escape = new RegExp(`\\\\u(?:${hex.padStart(4, "0")}|\\{0*${hex}\\})`, "i");
	const short = new Map([[0x09, "\\t"], [0x0a, "\\n"], [0x0d, "\\r"]]).get(codePoint);
	assert.ok(escape.test(text) || (short !== undefined && text.includes(short)), `falta escape visible de U+${hex}`);
	assert.ok(!text.includes(String.fromCodePoint(codePoint)), `no debe imprimir U+${hex} activo`);
}

test("foundations v2: checkBlock devuelve el mismo valor validado o el motivo, nunca los dos", () => {
	const value: unknown = JSON.parse(JSON.stringify(block()));
	const checked = checkBlock(value);
	assert.ok("block" in checked);
	assert.equal(checked.block, value, "el valor validado, no una copia ni un cast");
	for (const bad of [null, "texto", [], { ...block(), extra: 1 }, { ...block(), version: 3 }, { ...block(), version: "2" }, { ...block(), repo: "Chichex/Omi" }]) {
		assert.match(reason(bad), /esquema|versi[oó]n/i);
	}
	assert.deepEqual(readFoundationsText(JSON.stringify(block()), REPO), { block: block() });
	const other = readFoundationsText(JSON.stringify(block({ repo: "acme/otro" })), REPO);
	assert.ok("reason" in other);
	assert.match(other.reason, /declara acme\/otro/);
});

test("foundations v2: el esquema es cerrado y exige exactamente las tres políticas y confirmar", () => {
	const { confirmar, ...withoutRules } = block();
	const bad: unknown[] = [
		withoutRules,
		{ ...block(), confirmar: "git push *" },
		{ ...block(), confirmar: [null] },
		{ ...block(), confirmar: [4] },
		{ ...block(), comandos: ["npm test"] },
		{ ...block(), politica: { ...block().politica, fuera_de_catalogo: "auto" } },
		{ ...block(), politica: { ...block().politica, extra: "ask" } },
		{ ...block(), politica: { arranque: "ask", receta: "ask" } },
		{ ...block(), politica: { ...block().politica, push_pr: "siempre" } },
		{ ...block(), politica: null },
		{ ...block(), repo: "repo-sin-owner" },
	];
	assert.ok(confirmar.length > 0);
	for (const value of bad) assert.ok(reason(value).length > 0);
	assert.deepEqual(STRICT_POLICY, { arranque: "ask", receta: "ask", push_pr: "ask" });
});

test("foundations v2: lista vacía válida, cien reglas y límites inclusivos de longitud UTF-16", () => {
	for (const confirmar of [[], ["x"], ["x".repeat(2000)], ["😀".repeat(1000)], Array.from({ length: 100 }, (_, i) => `cmd${i} *`)]) {
		assert.deepEqual(validated(block({ confirmar })), block({ confirmar }));
	}
	for (const confirmar of [[""], ["x".repeat(2001)], ["😀".repeat(1000) + "x"], Array.from({ length: 101 }, (_, i) => `cmd${i} *`)]) {
		assert.ok(reason(block({ confirmar })).length > 0);
	}
	assert.match(reason(block({ confirmar: ["ok", ""] })), /regla\s*(?:#\s*)?2/i);
	assert.match(reason(block({ confirmar: ["ok", "x".repeat(2001)] })), /regla\s*(?:#\s*)?2/i);
});

test("foundations v2: duplicados exactos y espacios de borde no se normalizan", () => {
	const duplicate = reason(block({ confirmar: ["npm test", "npm test"] }));
	assert.match(duplicate, /repetid|duplicad/i);
	assert.match(duplicate, /regla\s*(?:#\s*)?2/i);
	for (const rule of [" npm test", "npm test ", "\u00a0npm test", "npm test\u2002"]) {
		assert.match(reason(block({ confirmar: ["ok", rule] })), /regla\s*(?:#\s*)?2/i);
		assert.match(reason(block({ confirmar: [rule] })), /espacios|borde/i);
	}
	assert.deepEqual(validated(block({ confirmar: ["git push *", "git  push *", "Git push *", "é", "e\u0301"] })), block({ confirmar: ["git push *", "git  push *", "Git push *", "é", "e\u0301"] }));
});

const hidden = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0xad, 0x200b, 0x202e, 0xfeff, 0xe0001, 0xe007f, 0x2028, 0x2029, 0xe0100, 0xe01ef];
for (const cp of hidden) test(`foundations v2: rechaza U+${cp.toString(16)} y muestra regla y escape visibles`, () => {
	const problem = reason(block({ confirmar: ["ok", `git${String.fromCodePoint(cp)}push *`] }));
	assert.match(problem, /regla\s*(?:#\s*)?2/i);
	assertVisibleEscape(problem, cp);
	assert.doesNotMatch(problem, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0100}-\u{E01EF}]/u);
});

test("foundations v2: no amplía el rechazo a todos los símbolos ni a selectores BMP", () => {
	const confirmar = ["echo ☕️", "echo 🧪", "echo café", "echo a\u0301", "echo a\u{E01F0}"];
	assert.deepEqual(validated(block({ confirmar })), block({ confirmar }));
});

test("foundations v2: escapes de patrones se validan también al cargar el bloque", () => {
	const confirmar = [String.raw`echo \*`, String.raw`echo \?`, String.raw`echo \\`, "echo *?"];
	assert.deepEqual(validated(block({ confirmar })), block({ confirmar }));
	for (const pattern of [String.raw`echo \x`, String.raw`echo \n`, String.raw`echo \ `, "echo \\"]) {
		assert.match(reason(block({ confirmar: ["ok", pattern] })), /regla\s*(?:#\s*)?2/i);
		assert.match(reason(block({ confirmar: [pattern] })), /escape|barra|backslash/i);
	}
});

test("foundations v2: un bloque válido trae el bloque, su hash y el span exacto", () => {
	const raw = fenced(block());
	const body = doc("## Foundations de omi · chichex/omi-code", raw);
	const parsed = parseFoundations(body, REPO);
	assert.equal(parsed.status, "valid");
	assert.ok(parsed.status === "valid");
	assert.deepEqual(parsed.block, block());
	assert.equal(parsed.hash, foundationsHash(validated()));
	assert.equal(body.slice(parsed.span[0], parsed.span[1]), raw);
});

test("foundations v2: el repo se compara en minúsculas y un bloque de otro repo no aplica", () => {
	assert.equal(parseFoundations(doc(fenced(block())), "ChicheX/Omi-Code").status, "valid");
	assert.deepEqual(parseFoundations(doc(fenced(block({ repo: "acme/omi-code" }))), REPO), { status: "missing" });
	assert.deepEqual(parseFoundations("Sin bloques.", REPO), { status: "missing" });
});

test("foundations v2: un bloque dentro de otra cerca no cuenta", () => {
	const body = `Ejemplo:\n\n\`\`\`\`md\n${fenced(block())}\n\`\`\`\`\n`;
	assert.deepEqual(parseFoundations(body, REPO), { status: "missing" });
	assert.deepEqual(parseFoundations(`~~~\n${fenced(block())}\n~~~\n`, REPO), { status: "missing" });
	assert.equal(parseFoundations(fenced(block(), "~~~~"), REPO).status, "valid");
});

const invalid: [string, string][] = [
	["JSON roto", doc(fenced('{ "version": 2, '))],
	["propiedad extra", doc(fenced({ ...block(), extra: true }))],
	["falta una política", doc(fenced({ ...block(), politica: { arranque: "ask", receta: "ask" } }))],
	["política desconocida", doc(fenced({ ...block(), politica: { ...block().politica, push_pr: "siempre" } }))],
	["versión distinta", doc(fenced({ ...block(), version: 3 }))],
	["regla repetida", doc(fenced(block({ confirmar: ["npm test", "npm test"] })))],
	["regla con salto de línea", doc(fenced(block({ confirmar: ["npm test\nrm -rf /"] })))],
	["regla con espacio al borde", doc(fenced(block({ confirmar: [" npm test"] })))],
	["regla con invisible", doc(fenced(block({ confirmar: ["npm\u200btest"] })))],
	["regla con control", doc(fenced(block({ confirmar: ["npm\u001b[2Jtest"] })))],
	["regla vacía", doc(fenced(block({ confirmar: [""] })))],
	["regla larga", doc(fenced(block({ confirmar: ["x".repeat(2001)] })))],
	["demasiadas reglas", doc(fenced(block({ confirmar: Array.from({ length: 101 }, (_, i) => `npm run c${i}`) })))],
	["repo en mayúsculas", doc(fenced(block({ repo: "Chichex/omi-code" })))],
	["cerca sin cerrar", doc(`\`\`\`omi-foundations\n${JSON.stringify(block())}`)],
	["dos bloques del mismo repo", doc(fenced(block()), fenced(block({ confirmar: ["git push *"] })))],
	["un bloque cuyo repo no se puede leer", doc(fenced(block()), fenced("no es json"))],
	["sin repo", doc(fenced(block()), fenced({ version: 2 }))],
];
for (const [name, body] of invalid) test(`foundations v2: inválido · ${name}`, () => {
	const parsed = parseFoundations(body, REPO);
	assert.equal(parsed.status, "invalid");
	assert.ok(parsed.status === "invalid");
	assert.ok(parsed.reason.length > 0);
});

test("foundations v2: v1 es obsoleto, nunca una revisión válida ni una lista vacía aceptada", () => {
	for (const value of [legacy(), { ...legacy(), comandos: [] }]) {
		assert.match(reason(value), /obsolet|configur.*nuevo|volver a configurar/i);
		const parsed = parseFoundations(doc(fenced(value)), REPO);
		assert.equal(parsed.status, "invalid");
		assert.ok(parsed.status === "invalid");
		assert.match(parsed.reason, /obsolet|configur.*nuevo|volver a configurar/i);
		const read = readFoundationsText(JSON.stringify(value), REPO);
		assert.ok("reason" in read && !("block" in read));
	}
	assert.deepEqual(parseFoundations(fenced(legacy("acme/otro")), REPO), { status: "missing" });
});

test("foundations v2: el lector de texto preservado valida JSON y cercas sin relajar el contrato", () => {
	assert.deepEqual(readFoundationsText(fenced(block()), REPO), { block: block() });
	assert.deepEqual(readFoundationsText(fenced(block(), "~~~"), REPO), { block: block() });
	for (const text of ["no es JSON", fenced("roto"), fenced(block({ repo: "acme/otro" })), JSON.stringify({ ...block(), extra: 1 })]) {
		const read = readFoundationsText(text, REPO);
		assert.ok("reason" in read && !("block" in read));
	}
});

test("foundations v2: hash canónico independiente del orden y formato, sensible a reglas, repo y políticas", () => {
	const base = foundationsHash(validated());
	const canonical = { version: 2, repo: REPO, confirmar: [...block().confirmar].sort(), politica: { arranque: "ask", receta: "ask", push_pr: "ask" } };
	assert.equal(base, createHash("sha256").update(JSON.stringify(canonical)).digest("hex"), "la identidad incluye versión, repo, reglas y políticas");
	const reordered = { politica: { push_pr: "ask", receta: "ask", arranque: "ask" }, confirmar: ["rm *", "npm publish", "git push *"], repo: REPO, version: 2 };
	assert.equal(foundationsHash(validated(reordered)), base);
	const compact = parseFoundations(`\`\`\`omi-foundations\n${JSON.stringify(reordered)}\n\`\`\``, REPO);
	assert.ok(compact.status === "valid");
	assert.equal(compact.hash, base);
	for (const next of [
		block({ confirmar: ["git push *", "npm publish", "rm *", "git tag *"] }),
		block({ confirmar: ["git  push *", "npm publish", "rm *"] }),
		block({ confirmar: ["Git push *", "npm publish", "rm *"] }),
		block({ repo: "acme/otro" }),
		...(["arranque", "receta", "push_pr"] as const).map((point) => block({ politica: { ...block().politica, [point]: "auto" } })),
	]) assert.notEqual(foundationsHash(validated(next)), base);
});

test("foundations v2: diferencia vertical de reglas que piden confirmación, no catálogo permitido", () => {
	const previous = validated(block({ confirmar: ["git tag *", "git push *"] }));
	const next = validated(block({ confirmar: ["git push *", "npm publish"], politica: { arranque: "auto", receta: "auto", push_pr: "auto" } }));
	const text = foundationsDiff(previous, next, { ...meta, docId: "1a2b3c4d-xyz", author: "ana@example.test", date: "2026-11-18" });
	assert.match(text, /Foundations · chichex\/omi-code · KB omi-code \(kb\.example\.test\)/);
	assert.match(text, /Perillas 1a2b3c4d · ana@example\.test · 2026-11-18/);
	assert.match(text, /^ {2}\+ npm publish$/m);
	assert.match(text, /^ {2}- git tag \*$/m);
	assert.match(text, /^ {4}git push \*$/m);
	assert.match(text, /reglas|patrones/i);
	assert.match(text, /confirmaci[oó]n|confirmar|preguntar/i);
	assert.doesNotMatch(text, /Comandos que corren sin preguntar|fuera del cat[aá]logo|git push \* \|/i);
	assert.match(text, /arranque: ask → auto .*crea el issue/);
	assert.match(text, /receta: ask → auto .*aprueba su propia receta/);
	assert.match(text, /push \+ PR draft: ask → auto .*sin preguntar/);
});

test("foundations v2: sin aceptación la diferencia parte del default (todo auto) y advierte la inversión", () => {
	const text = foundationsDiff(undefined, validated(), meta);
	assert.match(text, /Antes: sin Foundations \(por defecto: todo auto\)/);
	assert.doesNotMatch(text, /estricta|todo pregunta/);
	for (const pattern of block().confirmar) assert.ok(text.split("\n").includes(`  + ${pattern}`));
	assert.match(text, /^ {2}arranque: auto → ask$/m);
	assert.match(foundationsDiff(undefined, validated(block({ politica: { ...block().politica, receta: "auto" } })), meta), /^ {2}receta: auto {3}⚠ /m, "un auto igual al default no muestra flecha");
	assert.match(text, /simple/i);
	assert.match(text, /no coincid|no coincidan|no coinciden/i);
	assert.match(text, /sin (?:pedir )?confirmaci[oó]n|sin preguntar/i);
	assert.deepEqual(DEFAULT_POLICY, { arranque: "auto", receta: "auto", push_pr: "auto" });
	assert.deepEqual(STRICT_POLICY, { arranque: "ask", receta: "ask", push_pr: "ask" });
});

test("foundations v2: lista vacía advierte explícitamente que todos los comandos SIMPLES no requieren confirmar por esta política", () => {
	const next = validated(block({ confirmar: [] }));
	for (const previous of [undefined, validated()]) {
		const text = foundationsDiff(previous, next, meta);
		assert.match(text, /(?:todo|cualquier)[^\n]*simple/i);
		assert.match(text, /sin (?:pedir )?confirmaci[oó]n|sin preguntar/i);
		assert.match(text, /esta pol[ií]tica/i);
		assert.doesNotMatch(text, /Comandos que corren sin preguntar:\n  \(ninguno\)/);
	}
});

test("foundations v2: visibleText escapa todas las clases rechazadas, incluidos selectores astrales", () => {
	for (const cp of hidden) assertVisibleEscape(visibleText(`a${String.fromCodePoint(cp)}b`), cp);
	assert.equal(visibleText("café ☕️ 😀 a\u0301"), "café ☕️ 😀 a\u0301");
	const text = foundationsDiff(undefined, validated(), { ...meta, author: "ana\u001b[31m\u202e@x\u{E0100}", date: "hoy\u2028" });
	assert.doesNotMatch(text, /[\u001b\u202e\u2028\u{E0100}]/u);
	for (const cp of [0x1b, 0x202e, 0xe0100, 0x2028]) assertVisibleEscape(text, cp);
});

test("foundations v2: reemplazar un bloque válido conserva byte por byte lo que está fuera del span", () => {
	const body = doc("## Foundations de omi · chichex/omi-code", fenced(block()), "## Foundations de omi · acme/otro", fenced(block({ repo: "acme/otro" }))).replaceAll("\n", "\r\n");
	const parsed = parseFoundations(body, REPO);
	assert.ok(parsed.status === "valid");
	const next = validated(block({ confirmar: ["git push *"] }));
	const composed = composePerillas(body, "omi-code", REPO, next);
	assert.equal(composed, body.slice(0, parsed.span[0]) + renderFoundationsBlock(next) + body.slice(parsed.span[1]));
	const again = parseFoundations(composed, REPO);
	assert.ok(again.status === "valid");
	assert.equal(again.hash, foundationsHash(next));
	assert.equal(parseFoundations(composed, "acme/otro").status, "valid");
});

test("foundations v2: guardado explícito puede reemplazar solo el bloque v1 inequívoco sin migrar comandos", () => {
	const old = fenced(legacy(), "~~~~").replaceAll("\n", "\r\n");
	const prefix = "# Perillas\r\n\r\nNo cambiar este texto.\r\n\r\n";
	const suffix = `\r\n\r\n${fenced(legacy("acme/otro")).replaceAll("\n", "\r\n")}\r\nFin.\r\n`;
	const body = prefix + old + suffix;
	const next = validated(block({ confirmar: [] }));
	assert.equal(parseFoundations(body, REPO).status, "invalid", "leer no activa ni migra v1");
	const composed = composePerillas(body, "omi-code", REPO, next);
	assert.equal(composed, prefix + renderFoundationsBlock(next) + suffix);
	const parsed = parseFoundations(composed, REPO);
	assert.ok(parsed.status === "valid");
	assert.deepEqual(parsed.block, block({ confirmar: [] }));
	assert.ok(!renderFoundationsBlock(parsed.block).includes("npm test"), "no traslada autorizaciones v1");
	assert.equal(body, prefix + old + suffix, "el documento original no se modifica");
});

test("foundations v2: sin bloque se agrega una sección al final y sin documento se crea uno", () => {
	const next = validated();
	for (const body of [doc(), `${doc()}\n`, `${doc()}\n\n`, doc(fenced(legacy("acme/otro")))]) {
		const appended = composePerillas(body, "omi-code", REPO, next);
		assert.ok(appended.startsWith(body));
		assert.match(appended.slice(body.length), /(?:^|\n)## Foundations de omi · chichex\/omi-code\n\n```omi-foundations\n/);
		assert.equal(parseFoundations(appended, REPO).status, "valid");
	}
	const fresh = composePerillas(undefined, "omi-code", REPO, next);
	assert.ok(fresh.startsWith("# Perillas de omi-code\n\n## Foundations de omi · chichex/omi-code\n\n"));
	assert.equal(parseFoundations(fresh, REPO).status, "valid");
});

test("foundations v2: la cerca es más larga que cualquier racha de backticks de las reglas", () => {
	const next = validated(block({ confirmar: ["echo ```` x"] }));
	const rendered = renderFoundationsBlock(next);
	assert.ok(rendered.startsWith("`````omi-foundations\n"));
	assert.ok(rendered.endsWith("\n`````"));
	const parsed = parseFoundations(rendered, REPO);
	assert.ok(parsed.status === "valid");
	assert.deepEqual(parsed.block, block({ confirmar: ["echo ```` x"] }));
});

test("foundations v2: no compone sobre un documento ambiguo, malformado ni inválido no-v1", () => {
	const next = validated();
	const bodies = [
		...invalid.map(([, body]) => body),
		doc(fenced(legacy()), fenced(legacy())),
		doc(fenced(legacy()), fenced(block())),
		doc(fenced(legacy()), fenced("roto")),
		doc(fenced(legacy()), fenced({ version: 1 })),
		doc(fenced(legacy()), `\`\`\`omi-foundations\n${JSON.stringify(legacy("acme/otro"))}`),
		doc(fenced({ ...legacy(), repo: "Chichex/Omi-Code" })),
		doc(fenced('{ "version": 1, "repo": "chichex/omi-code",')),
		doc(`\`\`\`omi-foundations\n${JSON.stringify(legacy())}`),
		doc(fenced({ ...block(), version: 7 })),
		doc("```md\nuna cerca ajena sin cerrar"),
	];
	for (const body of bodies) assert.throws(() => composePerillas(body, "omi-code", REPO, next), /inv[aá]lid|correg|ambigu|no (?:admit|se puede)/i, body);
	const invalidRules = { ...next, confirmar: ["a\nb"] };
	const extraField = { ...next, extra: true };
	assert.throws(() => composePerillas(doc(), "omi-code", REPO, invalidRules), /inv[aá]lid|regla/i);
	assert.throws(() => composePerillas(doc(), "omi-code", REPO, extraField), /inv[aá]lid|esquema/i);
	assert.throws(() => composePerillas(doc(), "omi-code", REPO, validated(block({ repo: "acme/otro" }))), /declara|repo|inv[aá]lid/i);
});
