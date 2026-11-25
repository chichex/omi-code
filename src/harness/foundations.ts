// Foundations v2: patrones que requieren confirmación, no una allowlist. Sin I/O ni migraciones.
// Un bloque inválido, ausente, v1 o de otro repo no vale: sin una v2 aceptada rige el default (nada pregunta).
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fences, type Fence } from "./fences.ts";
import { MAX_RULES, ruleProblem, visibleText } from "./foundations-matcher.ts";
export { MAX_RULES, MAX_RULE_LENGTH, ruleProblem, visibleText, matchCommandPattern } from "./foundations-matcher.ts";

const Mode = Type.Union([Type.Literal("ask"), Type.Literal("auto")]);
const PolicySchema = Type.Object({ arranque: Mode, receta: Mode, push_pr: Mode }, { additionalProperties: false });
const BlockSchema = Type.Object({
	version: Type.Literal(2),
	repo: Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 200 }),
	// Los límites de reglas se verifican abajo para identificar la regla, también en JSON persistido.
	confirmar: Type.Array(Type.String()), politica: PolicySchema,
}, { additionalProperties: false });
export type PolicyMode = Static<typeof Mode>;
export type FoundationsPolicy = Static<typeof PolicySchema>;
export type FoundationsBlock = Static<typeof BlockSchema>;
export type PolicyPoint = keyof FoundationsPolicy;
export type ParsedFoundations =
	| { status: "valid"; block: FoundationsBlock; hash: string; span: [number, number] }
	| { status: "missing" }
	| { status: "invalid"; reason: string; legacy?: true };
export const FOUNDATIONS_INFO = "omi-foundations";
/** Sin Foundations v2 aceptada: nada pregunta. Cada punto se pone en ask desde Foundations. */
export const DEFAULT_POLICY: FoundationsPolicy = Object.freeze({ arranque: "auto", receta: "auto", push_pr: "auto" });
/** Todo pregunta. */
export const STRICT_POLICY: FoundationsPolicy = Object.freeze({ arranque: "ask", receta: "ask", push_pr: "ask" });
export const POLICY_LABELS: Record<PolicyPoint, string> = { arranque: "arranque", receta: "receta", push_pr: "push + PR draft" };
/** Qué hace cada punto en ask: lo muestran el panel y la pantalla OMI. */
export const ASK_HELP: Record<PolicyPoint, string> = {
	arranque: "te pide el sí antes de crear el issue, el worktree y la sesión",
	receta: "te muestra la receta para que la apruebes antes de implementar",
	push_pr: "te pide el sí antes del push de la rama y del PR draft",
};
export const AUTO_WARNINGS: Record<PolicyPoint, string> = {
	arranque: "crea el issue, el worktree y la sesión sin preguntar, con el texto del agente",
	receta: "el agente aprueba su propia receta; nunca dispensa la confirmación de comandos por patrones o sintaxis",
	push_pr: "hace push de la rama y abre el PR draft sin preguntar; nunca mergea ni fuerza",
};
const POINTS: PolicyPoint[] = ["arranque", "receta", "push_pr"];
export const EMPTY_RULES_WARNING = "Lista vacía: ningún comando del proyecto pide confirmación por esta política, tampoco uno compuesto. Las restricciones del proyecto y confirmaciones sensibles de OMI siguen vigentes.";

const obsolete = (value: unknown): boolean => !!value && typeof value === "object" && "version" in value && value.version === 1;
/** Devuelve el valor validado; jamás convierte comandos antiguos en patrones ni agrega defaults. */
export function checkBlock(value: unknown): { block: FoundationsBlock } | { reason: string } {
	if (!Value.Check(BlockSchema, value)) return { reason: "no cumple el esquema (version 2, repo owner/name en minúsculas, confirmar y tres políticas ask|auto, sin otros campos)" };
	if (value.confirmar.length > MAX_RULES) return { reason: `se admiten hasta ${MAX_RULES} reglas` };
	const seen = new Set<string>();
	for (const [index, rule] of value.confirmar.entries()) {
		const problem = ruleProblem(rule) ?? (seen.has(rule) ? "hay reglas repetidas exactas" : undefined);
		if (problem) return { reason: `Regla ${index + 1}: ${problem}` };
		seen.add(rule);
	}
	return { block: value };
}

type Located = { status: "found"; fence: Fence; value: unknown; declared: string } | { status: "missing" } | { status: "invalid"; reason: string };
/** Localizar no acepta una política: permite identificar un bloque obsoleto sólo para guardado explícito. */
function locate(body: string, repo: string): Located {
	const target = repo.toLowerCase(); let found: Extract<Located, { status: "found" }> | undefined;
	for (const fence of fences(body).filter((entry) => entry.info === FOUNDATIONS_INFO)) {
		if (!fence.closed) return { status: "invalid", reason: "un bloque omi-foundations no cierra su cerca" };
		let value: unknown;
		try { value = JSON.parse(body.slice(fence.contentStart, fence.contentEnd)); }
		catch { return { status: "invalid", reason: "un bloque omi-foundations no es JSON válido: no se sabe a qué repo aplica" }; }
		const declared = value && typeof value === "object" && "repo" in value && typeof value.repo === "string" ? value.repo : undefined;
		if (declared === undefined) return { status: "invalid", reason: "un bloque omi-foundations no declara su repo" };
		if (declared.toLowerCase() !== target) continue;
		if (found) return { status: "invalid", reason: `hay dos bloques omi-foundations para ${target}` };
		found = { status: "found", fence, value, declared };
	}
	return found ?? { status: "missing" };
}
export function parseFoundations(body: string, repo: string): ParsedFoundations {
	const located = locate(body, repo);
	if (located.status !== "found") return located;
	// Un bloque del formato anterior no vale ni se migra. Sigue siendo inválido para las guardas del guardado,
	// marcado para que la UI lo muestre como sin configurar: Guardar lo reemplaza.
	if (obsolete(located.value)) return { status: "invalid", reason: "bloque con un formato anterior; Guardar lo reemplaza sin heredar permisos", legacy: true };
	const checked = checkBlock(located.value);
	if ("reason" in checked) return { status: "invalid", reason: checked.reason };
	return { status: "valid", block: checked.block, hash: foundationsHash(checked.block), span: [located.fence.start, located.fence.end] };
}

/** Lectura estricta de un bloque; no se usa como interfaz de edición de Foundations. */
export function readFoundationsText(text: string, repo: string): { block: FoundationsBlock } | { reason: string } {
	if (text.includes(`\`\`\`${FOUNDATIONS_INFO}`) || text.includes(`~~~${FOUNDATIONS_INFO}`)) {
		const parsed = parseFoundations(text, repo);
		return parsed.status === "valid" ? { block: parsed.block } : { reason: parsed.status === "missing" ? `falta un bloque para ${repo}` : parsed.reason };
	}
	let value: unknown;
	try { value = JSON.parse(text); } catch { return { reason: "no es JSON válido" }; }
	const checked = checkBlock(value);
	if ("reason" in checked) return checked;
	return checked.block.repo === repo.toLowerCase() ? checked : { reason: `el bloque declara ${checked.block.repo}, no ${repo.toLowerCase()}` };
}
const canonical = (block: FoundationsBlock, sort: boolean): FoundationsBlock => ({
	version: block.version, repo: block.repo, confirmar: sort ? [...block.confirmar].sort() : [...block.confirmar],
	politica: { arranque: block.politica.arranque, receta: block.politica.receta, push_pr: block.politica.push_pr },
});
export function foundationsHash(block: FoundationsBlock): string {
	return createHash("sha256").update(JSON.stringify(canonical(block, true))).digest("hex");
}
export function renderFoundationsBlock(block: FoundationsBlock): string {
	const json = JSON.stringify(canonical(block, false), null, 2);
	const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${FOUNDATIONS_INFO}\n${json}\n${fence}`;
}

/** Sólo el guardado explícito reemplaza un bloque v1 inequívoco. Lo ajeno conserva exactamente sus bytes. */
export function composePerillas(current: string | undefined, product: string, repo: string, block: FoundationsBlock): string {
	const checked = checkBlock(block);
	const problem = "reason" in checked ? checked.reason : block.repo !== repo.toLowerCase() ? `el bloque declara ${block.repo}, no ${repo.toLowerCase()}` : "";
	if (problem) throw new Error(`Bloque omi-foundations inválido: ${problem}`);
	const rendered = renderFoundationsBlock(block);
	const section = `## Foundations de omi · ${block.repo}\n\n${rendered}\n`;
	let result: string;
	if (current === undefined) result = `# Perillas de ${product}\n\n${section}`;
	else {
		if (fences(current).some((entry) => !entry.closed)) throw new Error("Las perillas tienen una cerca inválida sin cerrar; corregilas antes de guardar.");
		const located = locate(current, repo);
		if (located.status === "invalid") throw new Error(`Las perillas tienen un bloque inválido (${located.reason}); corregilo antes de guardar.`);
		if (located.status === "found") {
			const previous = checkBlock(located.value);
			// La identidad canónica del repo debe ser inequívoca; no interpretar ni trasladar comandos/políticas v1.
			if (located.declared !== repo.toLowerCase() || "reason" in previous && !obsolete(located.value)) throw new Error("Las perillas tienen un bloque inválido; corregilo antes de guardar.");
			result = current.slice(0, located.fence.start) + rendered + current.slice(located.fence.end);
		} else result = `${current}${current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"}${section}`;
	}
	const check = parseFoundations(result, repo);
	if (check.status !== "valid" || check.hash !== foundationsHash(block)) throw new Error("Las perillas no admiten agregar el bloque sin cambiar su sentido; corregilas en la KB.");
	return result;
}
export interface FoundationsMeta { product: string; kbUrl: string; docId?: string; author?: string; date?: string }
function host(url: string): string { try { return new URL(url).host; } catch { return url; } }

/** Diferencia en texto plano contra la última revisión aceptada, o contra el default (todo auto). */
export function foundationsDiff(previous: FoundationsBlock | undefined, next: FoundationsBlock, meta: FoundationsMeta): string {
	const before = new Set(previous?.confirmar ?? []); const after = new Set(next.confirmar);
	const rules = [...next.confirmar.map((rule) => `  ${before.has(rule) ? "  " : "+ "}${rule}`), ...[...before].filter((rule) => !after.has(rule)).map((rule) => `  - ${rule}`)];
	const policies = POINTS.map((point) => {
		const was = previous?.politica[point] ?? DEFAULT_POLICY[point]; const now = next.politica[point];
		return `  ${POLICY_LABELS[point]}: ${was === now ? now : `${was} → ${now}`}${now === "auto" ? `   ⚠ ${AUTO_WARNINGS[point]}` : ""}`;
	});
	return [
		visibleText(`Foundations · ${next.repo} · KB ${meta.product} (${host(meta.kbUrl)})`),
		...(meta.docId || meta.author || meta.date ? [visibleText(`Perillas ${meta.docId?.slice(0, 8) ?? "sin id"} · ${meta.author ?? "autor desconocido"} · ${meta.date ?? "sin fecha"}`)] : []),
		previous ? `Antes: última revisión aceptada ${foundationsHash(previous).slice(0, 8)}` : "Antes: sin Foundations (por defecto: todo auto)",
		"Patrones que requieren confirmación:", ...(rules.length ? rules.map(visibleText) : ["  (ninguna regla)"]),
		next.confirmar.length ? "Sólo comandos simples no coincidentes corren sin preguntar por esta política." : EMPTY_RULES_WARNING,
		"Políticas:", ...policies,
	].join("\n");
}
