// Precedentes de los lentes: las referencias de Explorar con las líneas de la base que lee el host, con tope.
// #98: el lente pidió robar locks por PID aunque src/harness/store.ts lo prohíbe; no veía esa decisión (2026-11-26).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandOptions, Runner } from "../src/core/exec.ts";
import { readBaseFiles } from "../src/harness/git.ts";
import { LENS_PRECEDENT_NOTE, lensPrecedents, PRECEDENT_BUDGET, withoutDetails, withoutPrecedents } from "../src/harness/lens-precedents.ts";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `línea ${i + 1}`);

test("lens precedents: nota rotulada y líneas de la base; sin archivo o con la línea fuera, excerpt null", () => {
 const body = `${numbered(10).join("\n")}\n`;
 const references = [
  { path: "src/harness/store.ts", line: 5, detail: "un lock abandonado jamás se roba" },
  { path: "src/nuevo.ts", line: 1, detail: "no existe en la base" },
  { path: "src/harness/store.ts", line: 11, detail: "pasa del largo" },
  { path: "src/harness/store.ts", line: 1, detail: "inicio" },
 ];
 const precedents = lensPrecedents(references, [body, null, body, body]);
 assert.deepEqual(precedents, { items: [
  { path: "src/harness/store.ts", line: 5, detail: "un lock abandonado jamás se roba", excerpt: { from: 2, lines: numbered(8).slice(1) } },
  { path: "src/nuevo.ts", line: 1, detail: "no existe en la base", excerpt: null },
  { path: "src/harness/store.ts", line: 11, detail: "pasa del largo", excerpt: null },
  { path: "src/harness/store.ts", line: 1, detail: "inicio", excerpt: { from: 1, lines: numbered(4) } },
 ], omitted: 0 });
 assert.deepEqual(lensPrecedents([{ path: "vacío.ts", line: 1, detail: "sin líneas" }], [""]).items[0]?.excerpt, null, "un archivo vacío no tiene línea 1");
 // Security juzga con lo que leyó el host: la nota del implementador no viaja.
 const bare = withoutDetails(precedents);
 assert.deepEqual(bare.items.map((item) => "detail" in item), [false, false, false, false]);
 assert.deepEqual(bare.items[0], { path: "src/harness/store.ts", line: 5, excerpt: { from: 2, lines: numbered(8).slice(1) } });
 assert.equal(bare.omitted, 0);
 assert.match(LENS_PRECEDENT_NOTE, /líneas de la base/);
 assert.match(LENS_PRECEDENT_NOTE, /detail \(su nota: la escribió el implementador, no es evidencia; el lente de security no la recibe\)/);
 assert.match(LENS_PRECEDENT_NOTE, /omitted cuenta las que no entraron en la llamada/);
});

test("lens precedents: respeta el tope: recorta sin partir pares sustitutos, la línea citada conserva hasta 2000 caracteres y cuenta las omitidas", () => {
 const body = ["🙂".repeat(1500), "a".repeat(5000), "b"].join("\n");
 const [item] = lensPrecedents([{ path: `${"p".repeat(400)}.ts`, line: 2, detail: "d".repeat(700) }], [body]).items;
 assert.ok(item?.excerpt);
 assert.equal(item.path.length, 300); assert.match(item.path, /…$/);
 assert.equal(item.detail?.length, 600);
 const [before, cited, after] = item.excerpt.lines;
 assert.equal(item.excerpt.from, 1);
 assert.equal(cited, `${"a".repeat(1999)}…`, "la línea citada conserva hasta 2000 caracteres");
 assert.ok(before!.length <= 240); assert.match(before!, /…$/);
 assert.doesNotMatch(before!, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u, "no parte un par sustituto");
 assert.equal(after, "b");
 const many = Array.from({ length: 40 }, (_, i) => ({ path: `src/f${i}.ts`, line: 1, detail: "d" }));
 const capped = lensPrecedents(many, many.map(() => `${"c".repeat(1999)}\n`));
 assert.ok(JSON.stringify(capped.items).length <= PRECEDENT_BUDGET, `${JSON.stringify(capped.items).length}`);
 assert.ok(capped.omitted > 0); assert.equal(capped.items.length + capped.omitted, 40, "nada se omite sin contarlo");
 assert.deepEqual(capped.items.map((i) => i.path), many.slice(0, capped.items.length).map((m) => m.path), "en el orden de Explorar");
 const empty = withoutPrecedents(capped);
 assert.deepEqual(empty.items, []); assert.equal(empty.omitted, 40); assert.match(empty.note ?? "", /no entraron en la llamada/);
});

test("readBaseFiles lee cada archivo de la base con git cat-file, una vez por path; un error, un NUL o un código distinto de 0 dan null", async () => {
 const base = "a".repeat(40); const calls: { args: string[]; options?: CommandOptions }[] = [];
 const runner: Runner = { async run(_command, args, options) {
  calls.push({ args, ...(options ? { options } : {}) }); const spec = args.at(-1) ?? "";
  if (spec.endsWith(":ok.ts")) return { code: 0, stdout: "uno\ndos\n", stderr: "" };
  if (spec.endsWith(":bin")) return { code: 0, stdout: "a\0b", stderr: "" };
  if (spec.endsWith(":boom")) throw new Error("output excede el límite de salida del comando");
  return { code: 128, stdout: "", stderr: "fatal: path does not exist" };
 } };
 const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: base };
 assert.deepEqual(await readBaseFiles(checkout, ["ok.ts", "missing.ts", "bin", "boom", "ok.ts"], runner), ["uno\ndos\n", null, null, null, "uno\ndos\n"]);
 assert.deepEqual(calls.map((c) => c.args), ["ok.ts", "missing.ts", "bin", "boom"].map((path) => ["-c", "core.fsmonitor=false", "-C", "/repo", "cat-file", "blob", `${base}:${path}`]));
 assert.ok(calls.every((c) => c.options?.maxOutputBytes === 1024 * 1024 && c.options.env?.GIT_OPTIONAL_LOCKS === "0"), "sólo lectura y con tope de 1 MiB");
 await assert.rejects(readBaseFiles(checkout, ["ok.ts"], runner, AbortSignal.abort()));
 const before = calls.length;
 assert.deepEqual(await readBaseFiles({ ...checkout, baseCommit: "base" }, ["ok.ts"], runner), [null]);
 assert.equal(calls.length, before, "sin una base válida no llama a Git");
});
