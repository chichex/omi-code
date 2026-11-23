// Lee los inputs de workflow_dispatch de un workflow sin parser YAML: sólo mapas en bloque con sangría de espacios.
// Ante una forma que no entiende devuelve vacío: no proponer fijar un input es seguro; uno que el workflow rechaza, no.
type Range = { from: number; to: number };
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const meaningful = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");
const depth = (line: string) => line.length - line.trimStart().length;
/** Un escalar simple: sin comentario al final ni comillas. */
const scalar = (raw: string) => raw.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
/** La clave `key` entre los hijos directos de `range`: su valor en la línea y las líneas de su bloque. */
function entry(lines: string[], range: Range, key: string): { value: string; body: Range } | null {
 const levels = lines.slice(range.from, range.to).filter(meaningful).map(depth);
 const level = levels.length ? Math.min(...levels) : -1, pattern = new RegExp(`^["']?${literal(key)}["']?[ \\t]*:(?:[ \\t]+(.*))?$`);
 for (let index = range.from; index < range.to; index++) {
  const line = lines[index]!;
  if (!meaningful(line) || depth(line) !== level) continue;
  const match = pattern.exec(line.trim()); if (!match) continue;
  // Una lista puede ir a la misma altura que su clave («options:» y debajo «- valor»).
  let end = index + 1;
  while (end < range.to && (!meaningful(lines[end]!) || depth(lines[end]!) > level || depth(lines[end]!) === level && lines[end]!.trimStart().startsWith("- "))) end++;
  return { value: scalar(match[1] ?? ""), body: { from: index + 1, to: end } };
 }
 return null;
}
/** Las opciones de un choice, en bloque o en flujo; null si no se pueden leer. */
function options(lines: string[], found: { value: string; body: Range }): string[] | null {
 if (found.value) { const flow = /^\[(.*)\]$/.exec(found.value)?.[1]; return flow === undefined ? null : flow.split(",").map(scalar).filter(Boolean); }
 const items = lines.slice(found.body.from, found.body.to).filter(meaningful).map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]);
 return items.length && items.every((item) => item !== undefined) ? items.map((item) => scalar(item!)) : null;
}
/** El input `name` bajo `on.workflow_dispatch.inputs`; null si no está ahí (un comentario o la clave de un step no cuentan). */
function dispatchInput(lines: string[], name: string): { value: string; body: Range } | null {
 const on = entry(lines, { from: 0, to: lines.length }, "on"), dispatch = on && entry(lines, on.body, "workflow_dispatch");
 const inputs = dispatch && entry(lines, dispatch.body, "inputs");
 return inputs && entry(lines, inputs.body, name);
}
/** El workflow se puede disparar con `gh workflow run` y declara el input `name`. */
export const declaresDispatchInput = (text: string, name: string): boolean => dispatchInput(text.split(/\r?\n/), name) !== null;
/** De `allowed`, los valores que el input `name` de workflow_dispatch acepta. Sin el input, ninguno; un string, todos. */
export function dispatchInputValues<T extends string>(text: string, name: string, allowed: readonly T[]): T[] {
 const lines = text.split(/\r?\n/), input = dispatchInput(lines, name);
 if (!input || input.value) return [];
 const type = entry(lines, input.body, "type")?.value ?? "string";
 if (type === "string") return [...allowed];
 const choice = type === "choice" ? entry(lines, input.body, "options") : null, values = choice && options(lines, choice);
 return values ? allowed.filter((value) => values.includes(value)) : [];
}
