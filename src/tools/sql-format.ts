// Texto de un resultado SQL: tabla legible para una terminal o un modelo. Los datos exactos van en `data`.

import type { Static } from "typebox";
import type { SqlResultSchema } from "../client/views.ts";

type SqlResult = Static<typeof SqlResultSchema>;

/** Ancho máximo de una celda en la tabla; el valor completo queda en --json. */
const MAX_CELL_WIDTH = 80;

// Todo lo que una terminal no dibuja como un carácter propio: controles, caracteres de formato (bidi,
// ancho cero, guion blando, tags), separadores de línea y de párrafo, espacios que no son el ASCII,
// uso privado, sin asignar y sustitutos sueltos. Por categoría Unicode, no por lista.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]|(?! )\p{Zs}/gu;

function escaped(character: string): string {
	const code = character.codePointAt(0) ?? 0;
	return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Deja a la vista lo que una terminal interpretaría o no mostraría: quien confirma tiene que ver el
 * SQL que va a correr, no algo que se vea igual a otro. Sólo conserva saltos de línea y tabs.
 */
export function visible(text: string): string {
	return text.replace(HIDDEN, (character) => (character === "\n" || character === "\t" ? character : escaped(character)));
}

/** NULL va sin comillas. Una cadena vacía, o una que dice NULL, va entre comillas para no confundirse con él. */
function cellText(value: unknown): string {
	if (value === null) return "NULL";
	if (value === "" || value === "NULL") return `'${value}'`;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const oneLine = text.replace(HIDDEN, escaped);
	return oneLine.length > MAX_CELL_WIDTH ? `${oneLine.slice(0, MAX_CELL_WIDTH - 1)}…` : oneLine;
}

function table(result: SqlResult): string[] {
	if (result.columns.length === 0) return [];
	const header = result.columns.map((column) => cellText(column.name));
	const rows = result.rows.map((row) => result.columns.map((_, index) => cellText(row[index] ?? null)));
	const widths = header.map((name, index) => Math.max(name.length, ...rows.map((row) => row[index]?.length ?? 0)));
	const line = (cells: string[]): string => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ");
	return [line(header), widths.map((width) => "-".repeat(width)).join("-+-"), ...rows.map(line)];
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function truncation(result: SqlResult): string {
	if (!result.truncated) return "truncado: no";
	const cap = result.truncated_by === "bytes" ? `${result.limits.max_response_bytes} bytes` : plural(result.limits.max_rows, "fila", "filas");
	return `truncado: sí, por el tope de ${cap}: hay más`;
}

export function queryText(title: string, result: SqlResult): string {
	return [title, ...table(result), `${plural(result.row_count, "fila", "filas")} · ${truncation(result)} · ${result.duration_ms} ms`].join("\n");
}

export function execText(title: string, result: SqlResult): string {
	const affected = plural(result.rows_affected ?? 0, "fila afectada", "filas afectadas");
	const returned = result.columns.length === 0 ? [] : [...table(result), `${plural(result.row_count, "fila devuelta", "filas devueltas")} · ${truncation(result)}`];
	return [title, ...returned, `${result.command ?? "ok"} · ${affected} · ${result.duration_ms} ms`].join("\n");
}
