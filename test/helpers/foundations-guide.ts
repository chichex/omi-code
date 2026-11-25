// Teclas para la guía real; si aparece una tanda inesperada, cancelarla no simula que se guardó.
import { KEYS, typed } from "./questions.ts";

export const GUIDED_KEEP = ["1", "1", "1", "1", KEYS.enter];
export const GUIDED_EDIT = ["1", "1", "1", "2", KEYS.enter];
export const GUIDED_SAVE = ["1", KEYS.enter];

export function keepAndSave(screen: string): readonly string[] {
	return /Guía Foundations · Resumen/.test(screen) ? GUIDED_SAVE : GUIDED_KEEP;
}

/** Reemplaza la primera regla, o la quita si no se indicó un reemplazo. */
export function changeFirstRule(rule: string, afterSummary: readonly string[] = GUIDED_SAVE): (screen: string) => readonly string[] {
	let changed = false;
	return (screen) => {
		if (/Guía Foundations · Resumen/.test(screen)) return afterSummary;
		if (/Guía Foundations · Regla individual/.test(screen)) {
			changed = true;
			return rule ? ["3", ...typed(rule), KEYS.enter] : ["2"];
		}
		if (/Guía Foundations · Nueva regla/.test(screen)) { changed = true; return ["2", ...typed(rule), KEYS.enter]; }
		if (/Guía Foundations · Reglas/.test(screen)) return changed ? ["1"] : /\(0\/\d+\)/.test(screen) ? rule ? ["2"] : ["1"] : ["3"];
		return GUIDED_EDIT;
	};
}
