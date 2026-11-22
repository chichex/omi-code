// Retira los defaults de contexto largo que OMI escribía en models.json (#33, #34). Pi declara
// 272.000 tokens para estos GPT y cobra el tramo caro arriba de eso: con 1.050.000, la sesión
// compactaba recién cerca del millón y cada vuelta reenviaba cientos de miles de tokens al doble.
// Corre una sola vez: después, un contextWindow que ponga la persona se respeta, sea cual sea.
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify, parse, type JSONPath, type ParseError } from "jsonc-parser";
import { reservePrivateFile } from "../core/files.ts";

// Los diez IDs del proveedor openai a los que OMI les agregaba el valor (ningún otro proveedor).
const LEGACY_IDS = [
	"gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	"gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra",
];
const LEGACY_WINDOW = 1_050_000;
const MIGRATIONS_FILE = "omi-migrations.json";
const MIGRATION = "context-window-defaults";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Las migraciones aplicadas, o undefined si el registro no se puede leer: entonces no se toca nada. */
async function applied(path: string): Promise<string[] | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return isObject(value) && Array.isArray(value.applied) && value.applied.every((item) => typeof item === "string") ? value.applied : undefined;
	} catch (error) { return isMissing(error) ? [] : undefined; }
}

/** Las ediciones que sacan los valores de OMI, o undefined si el archivo no es válido para Pi. */
function legacyEdits(parsed: unknown): JSONPath[] | undefined {
	if (!isObject(parsed)) return undefined;
	if (parsed.providers === undefined) return [];
	if (!isObject(parsed.providers)) return undefined;
	const openai = parsed.providers.openai;
	if (openai === undefined) return [];
	if (!isObject(openai) || (openai.models !== undefined && !Array.isArray(openai.models))) return undefined;
	const overrides = openai.modelOverrides;
	if (overrides === undefined) return [];
	if (!isObject(overrides)) return undefined;
	const base = ["providers", "openai", "modelOverrides"];
	const edits: JSONPath[] = []; let kept = Object.keys(overrides).length;
	for (const id of LEGACY_IDS) {
		const override = overrides[id];
		if (override === undefined) continue;
		if (!isObject(override)) return undefined;
		if (override.contextWindow !== LEGACY_WINDOW) continue;
		if (Object.keys(override).length > 1) { edits.push([...base, id, "contextWindow"]); continue; }
		edits.push([...base, id]); kept--;
	}
	// Sólo se borran los contenedores que quedan vacíos por esta limpieza. "providers" queda, aunque
	// vacío: borrar la última clave del archivo se lleva los comentarios de arriba.
	if (edits.length && kept === 0) {
		edits.push(base);
		if (Object.keys(openai).length === 1) edits.push(["providers", "openai"]);
	}
	return edits;
}

/** true si models.json quedó sin los valores de OMI (o no existe); false para reintentar al próximo arranque. */
async function removeLegacyWindows(dir: string): Promise<boolean> {
	let path = join(dir, "models.json");
	let text: string;
	try {
		// El rename atómico debe reemplazar el destino, nunca romper un enlace de dotfiles.
		if ((await lstat(path)).isSymbolicLink()) path = await realpath(path);
		text = await readFile(path, "utf8");
	} catch (error) { return isMissing(error); }
	const bom = text.startsWith("﻿") ? "﻿" : "";
	text = text.slice(bom.length);
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors);
	if (errors.length) return false; // Pi muestra sus errores; no reescribir configuración inválida.
	const edits = legacyEdits(parsed);
	if (!edits) return false;
	if (!edits.length) return true;
	for (const target of edits) text = applyEdits(text, modify(text, target, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
	const file = await reservePrivateFile(path);
	await file.commit(bom + text);
	return true;
}

/** Al arrancar, antes de Pi. No toca el catálogo cacheado: Pi puede reemplazarlo al refrescar modelos. */
export async function ensureModelDefaults(dir: string): Promise<void> {
	const registry = join(dir, MIGRATIONS_FILE);
	const done = await applied(registry);
	if (!done || done.includes(MIGRATION)) return;
	if (!(await removeLegacyWindows(dir))) return;
	const file = await reservePrivateFile(registry);
	await file.commit(`${JSON.stringify({ applied: [...done, MIGRATION] }, null, 2)}\n`);
}
