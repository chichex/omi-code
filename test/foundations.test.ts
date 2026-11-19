import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_WARNINGS, checkBlock, composePerillas, DEFAULT_POLICY, foundationsDiff, foundationsHash, parseFoundations, readFoundationsText, renderFoundationsBlock, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";

const REPO = "chichex/omi-code";
const block = (overrides: Partial<FoundationsBlock> = {}): FoundationsBlock => ({ version: 1, repo: REPO, comandos: ["npm ci", "npm run typecheck", "npm test"], politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" }, ...overrides });
const fenced = (value: unknown, fence = "```") => `${fence}omi-foundations\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n${fence}`;
const doc = (...parts: string[]) => ["# Perillas de omi-code", "Otras perillas: tono formal.", ...parts, "## Cierre", "Texto humano final."].join("\n\n");

// El validador devuelve el valor validado: quien lo usa no castea JSON, red ni disco.
test("foundations: checkBlock devuelve el mismo valor validado o el motivo, nunca los dos", () => {
	const value: unknown = JSON.parse(JSON.stringify(block()));
	const checked = checkBlock(value);
	assert.ok("block" in checked); assert.equal(checked.block, value, "el valor validado, no una copia ni un cast");
	for (const [bad, reason] of [[{ ...block(), extra: 1 }, /esquema/], [{ ...block(), version: 2 }, /esquema/], [{ ...block(), repo: "Chichex/Omi" }, /esquema/], [null, /esquema/], ["texto", /esquema/],
		[block({ comandos: ["npm test", "npm test"] }), /repetidos/], [block({ comandos: [" npm test"] }), /espacios al borde/], [block({ comandos: ["npm\u202etest"] }), /invisibles/]] as const) {
		const result = checkBlock(bad);
		assert.ok("reason" in result && !("block" in result), JSON.stringify(bad)); assert.match(result.reason, reason);
	}
	assert.deepEqual(readFoundationsText(JSON.stringify(block()), REPO), { block: block() });
	assert.match(String((readFoundationsText(JSON.stringify(block({ repo: "acme/otro" })), REPO) as { reason: string }).reason), /declara acme\/otro/);
});

test("foundations: un bloque válido trae el bloque, su hash y el span exacto", () => {
	const raw = fenced(block());
	const body = doc("## Foundations de omi · chichex/omi-code", raw);
	const parsed = parseFoundations(body, REPO);
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.deepEqual(parsed.block, block());
	assert.equal(parsed.hash, foundationsHash(block()));
	assert.equal(body.slice(parsed.span[0], parsed.span[1]), raw);
});

test("foundations: el repo se compara en minúsculas y un bloque de otro repo no aplica", () => {
	assert.equal(parseFoundations(doc(fenced(block())), "ChicheX/Omi-Code").status, "valid");
	assert.deepEqual(parseFoundations(doc(fenced(block({ repo: "acme/omi-code" }))), REPO), { status: "missing" });
	assert.deepEqual(parseFoundations("Sin bloques.", REPO), { status: "missing" });
});

test("foundations: un bloque dentro de otra cerca no cuenta", () => {
	const body = `Ejemplo:\n\n\`\`\`\`md\n${fenced(block())}\n\`\`\`\`\n`;
	assert.deepEqual(parseFoundations(body, REPO), { status: "missing" });
	const tildes = `~~~\n${fenced(block())}\n~~~\n`;
	assert.deepEqual(parseFoundations(tildes, REPO), { status: "missing" });
});

const invalid: [string, string][] = [
	["JSON roto", doc(fenced("{ \"version\": 1, "))],
	["propiedad extra", doc(fenced({ ...block(), extra: true }))],
	["falta una política", doc(fenced({ ...block(), politica: { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask" } }))],
	["política desconocida", doc(fenced({ ...block(), politica: { ...block().politica, push_pr: "siempre" } }))],
	["versión distinta", doc(fenced({ ...block(), version: 2 }))],
	["comando repetido", doc(fenced(block({ comandos: ["npm test", "npm test"] })))],
	["comando con salto de línea", doc(fenced(block({ comandos: ["npm test\nrm -rf /"] })))],
	["comando con espacio al borde", doc(fenced(block({ comandos: [" npm test"] })))],
	["comando con invisible", doc(fenced(block({ comandos: ["npm​test"] })))],
	["comando con control", doc(fenced(block({ comandos: ["npm\u001b[2Jtest"] })))],
	["comando vacío", doc(fenced(block({ comandos: [""] })))],
	["comando largo", doc(fenced(block({ comandos: ["x".repeat(2001)] })))],
	["demasiados comandos", doc(fenced(block({ comandos: Array.from({ length: 101 }, (_, i) => `npm run c${i}`) })))],
	["repo en mayúsculas", doc(fenced(block({ repo: "Chichex/omi-code" })))],
	["cerca sin cerrar", doc(`\`\`\`omi-foundations\n${JSON.stringify(block())}`)],
	["dos bloques del mismo repo", doc(fenced(block()), fenced(block({ comandos: ["npm test"] })))],
	["un bloque cuyo repo no se puede leer", doc(fenced(block()), fenced("no es json"))],
];
for (const [name, body] of invalid) test(`foundations: inválido · ${name}`, () => {
	const parsed = parseFoundations(body, REPO);
	assert.equal(parsed.status, "invalid");
	if (parsed.status === "invalid") assert.ok(parsed.reason.length > 0);
});

test("foundations: el hash no cambia al reordenar o reformatear, sí al cambiar un comando o una política", () => {
	const base = foundationsHash(block());
	const reordered = { politica: { push_pr: "ask", fuera_de_catalogo: "ask", receta: "ask", arranque: "ask" }, comandos: ["npm test", "npm ci", "npm run typecheck"], repo: REPO, version: 1 } as FoundationsBlock;
	assert.equal(foundationsHash(reordered), base);
	const compact = parseFoundations(`\`\`\`omi-foundations\n${JSON.stringify(reordered)}\n\`\`\``, REPO);
	assert.equal(compact.status === "valid" && compact.hash, base);
	assert.notEqual(foundationsHash(block({ comandos: ["npm ci", "npm run typecheck", "npm test", "npm run lint"] })), base);
	assert.notEqual(foundationsHash(block({ politica: { ...block().politica, receta: "auto" } })), base);
});

test("foundations: la diferencia muestra comandos agregados, quitados y avisos de cada auto", () => {
	const previous = block({ comandos: ["npm run lint", "npm test"] });
	const next = block({ comandos: ["npm test", "npm run test:packaging"], politica: { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" } });
	const text = foundationsDiff(previous, next, { product: "omi-code", kbUrl: "https://kb.example.test/mcp", docId: "1a2b3c4d-xyz", author: "ana@example.test", date: "2026-11-18" });
	assert.match(text, /Foundations · chichex\/omi-code · KB omi-code \(kb\.example\.test\)/);
	assert.match(text, /Perillas 1a2b3c4d · ana@example\.test · 2026-11-18/);
	assert.match(text, /^ {2}\+ npm run test:packaging$/m);
	assert.match(text, /^ {2}- npm run lint$/m);
	assert.match(text, /^ {4}npm test$/m);
	assert.match(text, /arranque: ask → auto .*crea el issue/);
	assert.match(text, /receta: ask → auto .*aprueba su propia receta/);
	assert.match(text, /fuera del catálogo: ask → auto .*corre cualquier comando sin preguntar/);
	assert.match(text, /push \+ PR draft: ask → auto .*sin preguntar/);
});

test("foundations: sin revisión aceptada la diferencia parte del default: todo auto", () => {
	const text = foundationsDiff(undefined, block(), { product: "omi-code", kbUrl: "https://kb.example.test/mcp" });
	assert.match(text, /Antes: sin Foundations \(por defecto: todo auto\)/);
	assert.doesNotMatch(text, /estricta|todo pregunta/);
	for (const command of block().comandos) assert.match(text, new RegExp(`^  \\+ ${command}$`, "m"));
	assert.match(text, /^ {2}arranque: auto → ask$/m);
	assert.match(foundationsDiff(undefined, block({ politica: { ...block().politica, receta: "auto" } }), { product: "omi-code", kbUrl: "https://kb.example.test/mcp" }), /^ {2}receta: auto {3}⚠ /m, "un auto igual al default no muestra flecha");
	assert.deepEqual(DEFAULT_POLICY, { arranque: "auto", receta: "auto", fuera_de_catalogo: "auto", push_pr: "auto" });
	assert.deepEqual(STRICT_POLICY, { arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" }, "lo que propone el creador de Foundations");
});

test("foundations: el aviso de receta auto dice que sus comandos corren sin preguntar", () => {
	assert.match(AUTO_WARNINGS.receta, /aprueba su propia receta/);
	assert.match(AUTO_WARNINGS.receta, /sus comandos corren sin preguntar/);
	assert.doesNotMatch(AUTO_WARNINGS.receta, /siguen la política de fuera del catálogo/);
});

test("foundations: la diferencia escapa controles de los datos de la KB", () => {
	const text = foundationsDiff(undefined, block(), { product: "omi-code", kbUrl: "https://kb.example.test/mcp", author: "ana\u001b[31m‮@x" });
	assert.doesNotMatch(text, /\u001b|‮/);
});

test("foundations: reemplazar el bloque conserva byte por byte lo que está fuera del span", () => {
	const raw = fenced(block());
	const body = doc("## Foundations de omi · chichex/omi-code", raw, "## Foundations de omi · acme/otro", fenced(block({ repo: "acme/otro" })));
	const parsed = parseFoundations(body, REPO);
	assert.equal(parsed.status, "valid"); if (parsed.status !== "valid") return;
	const next = block({ comandos: ["npm test"] });
	const composed = composePerillas(body, "omi-code", REPO, next);
	assert.equal(composed.slice(0, parsed.span[0]), body.slice(0, parsed.span[0]));
	const tail = body.slice(parsed.span[1]);
	assert.equal(composed.slice(composed.length - tail.length), tail);
	const again = parseFoundations(composed, REPO);
	assert.equal(again.status === "valid" && again.hash, foundationsHash(next));
	assert.equal(parseFoundations(composed, "acme/otro").status, "valid");
});

test("foundations: sin bloque se agrega una sección al final y sin documento se crea uno", () => {
	const body = doc();
	const appended = composePerillas(body, "omi-code", REPO, block());
	assert.ok(appended.startsWith(body));
	assert.match(appended.slice(body.length), /\n## Foundations de omi · chichex\/omi-code\n\n```omi-foundations\n/);
	assert.equal(parseFoundations(appended, REPO).status, "valid");
	const fresh = composePerillas(undefined, "omi-code", REPO, block());
	assert.ok(fresh.startsWith("# Perillas de omi-code\n\n## Foundations de omi · chichex/omi-code\n\n"));
	assert.equal(parseFoundations(fresh, REPO).status, "valid");
});

test("foundations: la cerca es más larga que cualquier racha de backticks de los comandos", () => {
	const rendered = renderFoundationsBlock(block({ comandos: ["echo ```` x"] }));
	assert.ok(rendered.startsWith("`````omi-foundations\n"));
	assert.ok(rendered.endsWith("\n`````"));
	const parsed = parseFoundations(rendered, REPO);
	assert.deepEqual(parsed.status === "valid" && parsed.block.comandos, ["echo ```` x"]);
});

test("foundations: no compone sobre un bloque inválido", () => {
	assert.throws(() => composePerillas(doc(fenced("roto")), "omi-code", REPO, block()), /inválido|corregí/i);
	assert.throws(() => composePerillas(doc(), "omi-code", REPO, { ...block(), comandos: ["a\nb"] }), /inválido|comando/i);
});
