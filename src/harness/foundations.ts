// Foundations: el bloque `omi-foundations` de las perillas de un producto en la KB. Sin I/O.
// Un bloque inválido, ausente o de otro repo no autoriza nada: decide quien lo usa con qué revisión quedarse.
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fences, type Fence } from "./fences.ts";

export const MAX_COMMANDS = 100;
const MAX_COMMAND_LENGTH = 2000;
const Mode = Type.Union([Type.Literal("ask"), Type.Literal("auto")]);
const PolicySchema = Type.Object({ arranque: Mode, receta: Mode, fuera_de_catalogo: Mode, push_pr: Mode }, { additionalProperties: false });
const BlockSchema = Type.Object({
	version: Type.Literal(1),
	repo: Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 200 }),
	comandos: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }), { maxItems: MAX_COMMANDS }),
	politica: PolicySchema,
}, { additionalProperties: false });
export type PolicyMode = Static<typeof Mode>;
export type FoundationsPolicy = Static<typeof PolicySchema>;
export type FoundationsBlock = Static<typeof BlockSchema>;
export type PolicyPoint = keyof FoundationsPolicy;
export type ParsedFoundations =
	| { status: "valid"; block: FoundationsBlock; hash: string; span: [number, number] }
	| { status: "missing" }
	| { status: "invalid"; reason: string };

export const FOUNDATIONS_INFO = "omi-foundations";
/** La política de hoy: nada corre ni avanza sin preguntar. */
export const STRICT_POLICY: FoundationsPolicy = Object.freeze({ arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" });
export const POLICY_LABELS: Record<PolicyPoint, string> = { arranque: "arranque", receta: "receta", fuera_de_catalogo: "fuera del catálogo", push_pr: "push + PR draft" };
export const AUTO_WARNINGS: Record<PolicyPoint, string> = {
	arranque: "crea el issue, el worktree y la sesión sin preguntar, con el texto del agente",
	receta: "el agente aprueba su propia receta; sus comandos fuera del catálogo siguen la política de fuera del catálogo",
	fuera_de_catalogo: "corre cualquier comando sin preguntar: equivale a shell sin permiso",
	push_pr: "hace push de la rama y abre el PR draft sin preguntar; nunca mergea ni fuerza",
};
const POINTS: PolicyPoint[] = ["arranque", "receta", "fuera_de_catalogo", "push_pr"];
// Lo que se ve distinto de lo que corre: controles, saltos y formato invisible (bidi, ancho cero, tags).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0100}-\u{E01EF}]/u;

/** El motivo por el que un comando no puede ir al catálogo, o `undefined`. El mismo criterio que el bloque. */
export function commandProblem(command: string): string | undefined {
	if (!command || command.length > MAX_COMMAND_LENGTH) return `un comando tiene que tener entre 1 y ${MAX_COMMAND_LENGTH} caracteres`;
	return HIDDEN.test(command) || /^\s|\s$/.test(command) ? "un comando tiene espacios al borde, saltos de línea o caracteres de control o invisibles" : undefined;
}

/** El mismo valor, ya validado como bloque, o el motivo por el que no lo es. */
export function checkBlock(value: unknown): { block: FoundationsBlock } | { reason: string } {
	if (!Value.Check(BlockSchema, value)) return { reason: "no cumple el esquema (version 1, repo owner/name en minúsculas, comandos y las cuatro políticas ask|auto, sin otros campos)" };
	if (new Set(value.comandos).size !== value.comandos.length) return { reason: "hay comandos repetidos" };
	const bad = value.comandos.map(commandProblem).find((problem) => problem !== undefined);
	return bad === undefined ? { block: value } : { reason: bad };
}

/** El bloque de `repo` en el cuerpo de las perillas. Cualquier ambigüedad es inválida. */
export function parseFoundations(body: string, repo: string): ParsedFoundations {
	const target = repo.toLowerCase();
	let found: { fence: Fence; value: unknown } | undefined;
	for (const fence of fences(body).filter((f) => f.info === FOUNDATIONS_INFO)) {
		if (!fence.closed) return { status: "invalid", reason: "un bloque omi-foundations no cierra su cerca" };
		let value: unknown;
		try { value = JSON.parse(body.slice(fence.contentStart, fence.contentEnd)); }
		catch { return { status: "invalid", reason: "un bloque omi-foundations no es JSON válido: no se sabe a qué repo aplica" }; }
		const declared = value && typeof value === "object" && "repo" in value && typeof value.repo === "string" ? value.repo : undefined;
		if (declared === undefined) return { status: "invalid", reason: "un bloque omi-foundations no declara su repo" };
		if (declared.toLowerCase() !== target) continue;
		if (found) return { status: "invalid", reason: `hay dos bloques omi-foundations para ${target}` };
		found = { fence, value };
	}
	if (!found) return { status: "missing" };
	const checked = checkBlock(found.value);
	if ("reason" in checked) return { status: "invalid", reason: checked.reason };
	return { status: "valid", block: checked.block, hash: foundationsHash(checked.block), span: [found.fence.start, found.fence.end] };
}

/** Lo que escribe una persona en el editor: el JSON del bloque, con o sin cerca. */
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
	version: block.version, repo: block.repo, comandos: sort ? [...block.comandos].sort() : [...block.comandos],
	politica: { arranque: block.politica.arranque, receta: block.politica.receta, fuera_de_catalogo: block.politica.fuera_de_catalogo, push_pr: block.politica.push_pr },
});
/** Identidad de una revisión: reordenar o reformatear no la cambia; un comando o una política sí. */
export function foundationsHash(block: FoundationsBlock): string {
	return createHash("sha256").update(JSON.stringify(canonical(block, true))).digest("hex");
}

export function renderFoundationsBlock(block: FoundationsBlock): string {
	const json = JSON.stringify(canonical(block, false), null, 2);
	const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${FOUNDATIONS_INFO}\n${json}\n${fence}`;
}

/** Cuerpo nuevo de las perillas: sólo cambia el bloque de este repo; el resto se conserva tal cual. */
export function composePerillas(current: string | undefined, product: string, repo: string, block: FoundationsBlock): string {
	const checked = checkBlock(block);
	const problem = "reason" in checked ? checked.reason : block.repo !== repo.toLowerCase() ? `el bloque declara ${block.repo}, no ${repo.toLowerCase()}` : "";
	if (problem) throw new Error(`Bloque omi-foundations inválido: ${problem}`);
	const rendered = renderFoundationsBlock(block);
	const section = `## Foundations de omi · ${block.repo}\n\n${rendered}\n`;
	let result: string;
	if (current === undefined) result = `# Perillas de ${product}\n\n${section}`;
	else {
		const parsed = parseFoundations(current, repo);
		if (parsed.status === "invalid") throw new Error(`Las perillas tienen un bloque omi-foundations inválido (${parsed.reason}); corregilo en la KB antes de guardar uno nuevo.`);
		if (parsed.status === "valid") result = current.slice(0, parsed.span[0]) + rendered + current.slice(parsed.span[1]);
		else result = `${current}${current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"}${section}`;
	}
	// Por ejemplo, una cerca ajena sin cerrar al final se tragaría la sección nueva.
	const check = parseFoundations(result, repo);
	if (check.status !== "valid" || check.hash !== foundationsHash(block)) throw new Error("Las perillas no admiten agregar el bloque sin cambiar su sentido; corregilas en la KB.");
	return result;
}

/** Escapes visibles para datos de la KB: nunca secuencias del terminal ni texto con otra dirección. */
export function visibleText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
export interface FoundationsMeta { product: string; kbUrl: string; docId?: string; author?: string; date?: string }
function host(url: string): string { try { return new URL(url).host; } catch { return url; } }

/** Diferencia en texto plano contra la última revisión aceptada, o contra la política estricta. */
export function foundationsDiff(previous: FoundationsBlock | undefined, next: FoundationsBlock, meta: FoundationsMeta): string {
	const before = new Set(previous?.comandos ?? []); const after = new Set(next.comandos);
	const commands = [...next.comandos.map((c) => `  ${before.has(c) ? "  " : "+ "}${c}`), ...[...before].filter((c) => !after.has(c)).map((c) => `  - ${c}`)];
	const policies = POINTS.map((point) => {
		const was = previous?.politica[point] ?? STRICT_POLICY[point]; const now = next.politica[point];
		return `  ${POLICY_LABELS[point]}: ${was === now ? now : `${was} → ${now}`}${now === "auto" ? `   ⚠ ${AUTO_WARNINGS[point]}` : ""}`;
	});
	return [
		visibleText(`Foundations · ${next.repo} · KB ${meta.product} (${host(meta.kbUrl)})`),
		...(meta.docId ? [visibleText(`Perillas ${meta.docId.slice(0, 8)} · ${meta.author ?? "autor desconocido"} · ${meta.date ?? "sin fecha"}`)] : []),
		previous ? `Antes: última revisión aceptada ${foundationsHash(previous).slice(0, 8)}` : "Antes: política estricta (nada aceptado: todo pregunta)",
		"Comandos que corren sin preguntar:", ...(commands.length ? commands.map(visibleText) : ["  (ninguno)"]),
		"Políticas:", ...policies,
	].join("\n");
}
