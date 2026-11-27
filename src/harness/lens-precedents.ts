// Precedentes de los lentes: las referencias que citó Explorar, con las líneas de la base que leyó el host
// (readBaseFiles en git.ts). Puro y con tope: lo que no entra se cuenta, una línea se recorta sin partir un
// par sustituto y la citada conserva más que las de alrededor. detail es la nota del implementador, no evidencia.
import type { Exploration } from "./model.ts";

const AROUND = 3; const LINE_CHARS = 240; const CITED_CHARS = 2000; const DETAIL_CHARS = 600; const PATH_CHARS = 300;
export const PRECEDENT_BUDGET = 20_000;
export interface LensPrecedent { path: string; line: number; detail?: string; excerpt: { from: number; lines: string[] } | null }
export interface LensPrecedents { items: LensPrecedent[]; omitted: number; note?: string }
type Reference = Exploration["references"][number];

export const LENS_PRECEDENT_NOTE = "precedents son las referencias que el implementador citó en Explorar, leídas por el harness: path y line, excerpt (las líneas de la base, antes del cambio; from es el número de la primera; null si el archivo o la línea no existen en la base) y detail (su nota: la escribió el implementador, no es evidencia; el lente de security no la recibe). omitted cuenta las que no entraron en la llamada; si viene note, dice por qué. Usalos como vara: no exijas más de lo que el repo ya hace en el código equivalente y no pidas un cambio que contradiga una decisión documentada (un comentario que fija una regla, AGENTS.md o docs/). Un hallazgo que pide más que el repo sin un precedente visible que lo respalde es aviso, no un bloqueo; exponer un secreto o mandar código o datos a un destino que nadie autorizó sigue siendo blocker.";
const OMITTED_NOTE = "Los precedentes no entraron en la llamada junto con la evidencia y el diff: van vacíos.";

const clip = (value: string, max: number): string => {
 if (value.length <= max) return value;
 const size = /[\ud800-\udbff]/.test(value[max - 2] ?? "") ? max - 2 : max - 1;
 return `${value.slice(0, size)}…`;
};
function excerpt(body: string | null, line: number): LensPrecedent["excerpt"] {
 if (body === null) return null;
 const lines = body ? body.split("\n") : [];
 if (body.endsWith("\n")) lines.pop();
 if (line > lines.length) return null;
 const from = Math.max(1, line - AROUND); const to = Math.min(lines.length, line + AROUND);
 return { from, lines: lines.slice(from - 1, to).map((text, i) => clip(text, from + i === line ? CITED_CHARS : LINE_CHARS)) };
}
/** `bodies[i]` es el archivo de `references[i]` en la base, o null si no está. */
export function lensPrecedents(references: readonly Reference[], bodies: readonly (string | null)[], budget = PRECEDENT_BUDGET): LensPrecedents {
 const items: LensPrecedent[] = []; let used = 2; let omitted = 0;
 references.forEach((reference, i) => {
  const item = { path: clip(reference.path, PATH_CHARS), line: reference.line, detail: clip(reference.detail, DETAIL_CHARS), excerpt: excerpt(bodies[i] ?? null, reference.line) };
  const cost = JSON.stringify(item).length + 1;
  if (used + cost > budget) { omitted++; return; }
  items.push(item); used += cost;
 });
 return { items, omitted };
}
export const withoutPrecedents = (p: LensPrecedents): LensPrecedents => ({ items: [], omitted: p.omitted + p.items.length, note: OMITTED_NOTE });
export const withoutDetails = (p: LensPrecedents): LensPrecedents => ({ ...p, items: p.items.map(({ detail: _detail, ...item }) => item) });
