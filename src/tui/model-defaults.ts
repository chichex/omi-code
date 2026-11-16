// Defaults del producto sobre el catálogo de Pi; las decisiones explícitas del usuario ganan.
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { reservePrivateFile } from "../core/files.ts";

function object(value: unknown = {}): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_models_config");
	return value as Record<string, unknown>;
}

/** No tocar el catálogo cacheado: Pi puede reemplazarlo al refrescar modelos. */
export async function ensureModelDefaults(dir: string): Promise<void> {
	let path = join(dir, "models.json");
	let text = "{}\n";
	try {
		// El rename atómico debe reemplazar el destino, nunca romper un enlace de dotfiles.
		const info = await lstat(path);
		if (info.isSymbolicLink()) {
			try { path = await realpath(path); } catch { return; }
		}
		text = await readFile(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return;
	}
	const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
	text = text.slice(bom.length);
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors);
	if (errors.length) return; // Pi muestra sus errores; no reescribir configuración inválida.
	try {
		const config = object(parsed);
		const providers = object(config.providers);
		const openai = object(providers.openai);
		const overrides = object(openai.modelOverrides);
		const sol = object(overrides["gpt-6.1-sol"]);
		if (Object.hasOwn(sol, "contextWindow")) return;
		if (Array.isArray(openai.models) && openai.models.some((model: unknown) => {
			const entry = object(model);
			return entry.id === "gpt-6.1-sol" && Object.hasOwn(entry, "contextWindow");
		})) return;
	} catch { return; }
	// https://developers.openai.com/api/docs/models/gpt-6.1-sol
	// Sólo esta versión y proveedor: no inferir capacidades de otros Sol ni de Codex.
	const edits = modify(text, ["providers", "openai", "modelOverrides", "gpt-6.1-sol", "contextWindow"], 1_050_000, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	const file = await reservePrivateFile(path);
	await file.commit(bom + applyEdits(text, edits));
}
