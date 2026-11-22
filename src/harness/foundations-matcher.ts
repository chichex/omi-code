// Globs textuales de Foundations. Sin regex de usuario, shell, normalización ni expansión de archivos.
export const MAX_RULES = 100;
export const MAX_RULE_LENGTH = 2000;
const HIDDEN_SOURCE = "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u{E0100}-\\u{E01EF}]";
const HIDDEN = new RegExp(HIDDEN_SOURCE, "u");

/** Datos externos visibles: nunca controles activos, bidi ni selectores astrales invisibles. */
export function visibleText(value: string): string {
	return value.replace(new RegExp(HIDDEN_SOURCE, "gu"), (character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
	});
}

type Token = { kind: "literal"; value: string } | { kind: "star" | "one" };
function tokens(pattern: string): Token[] | undefined {
	const points = [...pattern]; const result: Token[] = [];
	for (let index = 0; index < points.length; index++) {
		const point = points[index]!;
		if (point === "\\") {
			const literal = points[++index];
			if (literal !== "*" && literal !== "?" && literal !== "\\") return undefined;
			result.push({ kind: "literal", value: literal });
		} else if (point === "*") {
			if (result.at(-1)?.kind !== "star") result.push({ kind: "star" });
		} else if (point === "?") result.push({ kind: "one" });
		else result.push({ kind: "literal", value: point });
	}
	return result;
}

/** Mismo criterio para JSON y editor; string.length mide unidades UTF-16, no puntos de código. */
export function ruleProblem(rule: string): string | undefined {
	if (!rule || rule.length > MAX_RULE_LENGTH) return `una regla tiene que tener entre 1 y ${MAX_RULE_LENGTH} unidades UTF-16`;
	const hidden = HIDDEN.exec(rule)?.[0];
	if (hidden) return `carácter de control o invisible no admitido: ${visibleText(hidden)}`;
	if (!tokens(rule)) return "escape inválido: backslash sólo permite escapar *, ? o backslash; no puede quedar al final";
	if (/^\s|\s$/u.test(rule)) return "una regla tiene espacios al borde";
	return undefined;
}

/**
 * Línea completa, sensible a mayúsculas y por puntos de código Unicode.
 * Sólo se retrocede al último *: O(patrón × comando), memoria O(patrón + comando).
 * No hay recursión, regex arbitraria ni búsqueda exponencial con múltiples estrellas.
 */
export function matchCommandPattern(pattern: string, command: string): boolean {
	if (ruleProblem(pattern)) return false;
	const patternTokens = tokens(pattern);
	if (!patternTokens) return false;
	const points = [...command];
	let tokenIndex = 0; let pointIndex = 0; let star = -1; let starEnd = 0;
	while (pointIndex < points.length) {
		const token = patternTokens[tokenIndex];
		if (token?.kind === "one" || token?.kind === "literal" && token.value === points[pointIndex]) {
			tokenIndex++; pointIndex++;
		} else if (token?.kind === "star") {
			star = tokenIndex++; starEnd = pointIndex;
		} else if (star >= 0) {
			tokenIndex = star + 1; pointIndex = ++starEnd;
		} else return false;
	}
	while (patternTokens[tokenIndex]?.kind === "star") tokenIndex++;
	return tokenIndex === patternTokens.length;
}
