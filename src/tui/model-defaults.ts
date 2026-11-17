// Defaults del producto sobre el catálogo de Pi; las decisiones explícitas del usuario ganan.
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { reservePrivateFile } from "../core/files.ts";

// Verificados por ID en https://developers.openai.com/api/docs/models/<id> (fuentes en README).
// Sólo el proveedor openai: no inferir capacidades de otros GPT ni de Codex.
const LONG_CONTEXT_MODELS = [
	"gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	"gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra",
];

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
	let missing: string[];
	try {
		const config = object(parsed);
		const providers = object(config.providers);
		const openai = object(providers.openai);
		const overrides = object(openai.modelOverrides);
		if (openai.models !== undefined && !Array.isArray(openai.models)) return;
		const models = Array.isArray(openai.models) ? openai.models.map((model: unknown) => object(model)) : [];
		missing = LONG_CONTEXT_MODELS.filter((id) => {
			const override = object(overrides[id]);
			return !Object.hasOwn(override, "contextWindow")
				&& !models.some((model) => model.id === id && Object.hasOwn(model, "contextWindow"));
		});
	} catch { return; }
	if (!missing.length) return;
	for (const id of missing) {
		text = applyEdits(text, modify(text, ["providers", "openai", "modelOverrides", id, "contextWindow"], 1_050_000, {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		}));
	}
	const file = await reservePrivateFile(path);
	await file.commit(bom + text);
}
