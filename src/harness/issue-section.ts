// Sección administrada del harness al final del cuerpo del issue. El pedido humano queda arriba,
// intacto byte a byte; la sección se reescribe entera y nunca se toca texto fuera de sus marcadores.
import type { Evidence, Lens, Workflow } from "./model.ts";
import { PHASE_LABELS } from "./phases.ts";
import { expectedFailure, isApproved } from "./state.ts";
import { lensStatuses } from "./lenses.ts";
import { fences } from "./fences.ts";
import { STACK_STATUS, stackRows } from "./stack.ts";
export const SECTION_START = "<!-- omi:harness:start -->";
export const SECTION_END = "<!-- omi:harness:end -->";
// Lo que OMI agrega entre el pedido y la sección; se descuenta al leer el pedido.
const SEPARATOR = "\n\n";
// Sólo cuenta un marcador solo en su línea, desde la primera columna y fuera de un bloque de código: una
// mención en el pedido (en línea, entre backticks, indentada o dentro de una cerca ``` o ~~~) es texto humano.
// Una cerca sin cerrar no esconde marcadores: la sección que OMI agrega después de ella se sigue encontrando.
const MARKER_LINE = /^<!--\s*omi:harness:[^\n]*$/gm;
function markerLines(body: string): RegExpExecArray[] {
	const code = fences(body).filter((fence) => fence.closed);
	return [...body.matchAll(MARKER_LINE)].filter((match) => !code.some((fence) => match.index >= fence.contentStart && match.index < fence.contentEnd));
}

export interface IssueBody {
	/** El pedido: todo lo que no es la sección ni el separador que agregó OMI. */
	human: string;
	/** Texto antes del marcador de inicio (con el separador) y después del de cierre. */
	before: string; after: string;
	/** Contenido entre los marcadores, o null si el cuerpo todavía no tiene sección. */
	section: string | null;
}
export class IssueSectionError extends Error {
	constructor() { super("Los marcadores de la sección del harness en el issue están repetidos o rotos. No se adivina cuál es el pedido: dejá un solo par <!-- omi:harness:start --> / <!-- omi:harness:end --> (o borrá la sección entera) y reintentá."); this.name = "IssueSectionError"; }
}
export function parseIssueBody(body: string): IssueBody {
	const markers = markerLines(body);
	if (!markers.length) return { human: body, before: body, after: "", section: null };
	const line = (match: RegExpMatchArray) => match[0].replace(/\r$/, "");
	const [start, end] = markers;
	if (markers.length !== 2 || !start || !end || line(start) !== SECTION_START || line(end) !== SECTION_END) throw new IssueSectionError();
	const before = body.slice(0, start.index); const after = body.slice(end.index! + end[0].length);
	return { human: (before.endsWith(SEPARATOR) ? before.slice(0, -SEPARATOR.length) : before) + after, before, after, section: body.slice(start.index! + start[0].length, end.index) };
}
// Sin sección, se agrega al final; con sección, se reemplaza sólo lo que está entre los marcadores.
export function withIssueSection(body: string, parts: IssueBody, content: string): string {
	const block = `${SECTION_START}\n${content}\n${SECTION_END}`;
	return parts.section === null ? `${body}${SEPARATOR}${block}` : `${parts.before}${block}${parts.after}`;
}

// --- Presentación. Todo dato (modelo, receta, persona) pasa por text/code/cell: ninguna línea
// de contenido empieza en la primera columna, así que nunca puede imitar un marcador.
const TYPES = { add: "Nueva capacidad", fix: "Corrección", improve: "Mejora", chore: "Mantenimiento" };
const ROUTES = { direct: "Directa", diagnostic: "Diagnóstico", spec: "Con spec" };
const LENSES: Record<Lens, string> = { quality: "Calidad", reliability: "Confiabilidad", security: "Seguridad", compliance: "Cumplimiento", resilience: "Resiliencia", refuter: "Refutador" };
const MAX_ROWS = 40;
// Límite de GitHub para el cuerpo de un issue. La longitud UTF-16 nunca cuenta menos caracteres que GitHub.
export const ISSUE_BODY_LIMIT = 65536;
type Detail = "full" | "summary";
// Controles, bidi e invisibles se ven como escapes; nunca se publican crudos.
const visible = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (c) => c === "\n" || c === "\t" ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
// Texto del modelo, de un comando o de la persona: en GitHub nada queda activo. Una palabra que podría
// enlazar, avisar o referenciar (URL, www., correo, @mención, #123, GH-123) va entera como código; el
// resto escapa HTML y la sintaxis de links, imágenes y código. Los saltos no abren bloques nuevos.
const LINKABLE = /:\/\/|www\.|@|#\d|\bgh-\d/i;
const escaped = (value: string) => value.replace(/[\\`[\]]/g, "\\$&").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (value: string) => visible(value).split(/(\s+)/).map((part, i) => i % 2 ? part.replace(/\n/g, "<br>") : LINKABLE.test(part) ? code(part) : escaped(part)).join("");
// Código en línea con una cerca más larga que cualquier racha de backticks del contenido.
function code(value: string): string {
	const content = visible(value).replace(/\n/g, " ↵ ");
	const fence = "`".repeat(Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
	const pad = /^[` ]|[` ]$/.test(content) ? " " : "";
	return `${fence}${pad}${content}${pad}${fence}`;
}
// En una tabla de GFM el pipe separa celdas incluso dentro del código: se escapa siempre.
const cell = (value: string) => value.replace(/\|/g, "\\|");
function codeBlock(value: string): string[] {
	const content = visible(value).split("\n");
	const fence = "`".repeat(Math.max(3, ...content.flatMap((l) => [...l.matchAll(/`+/g)].map((m) => m[0].length + 1))));
	return [fence, ...content, fence].map((l) => `  ${l}`.trimEnd() || "  ");
}
const list = (label: string, values: string[]) => values.length ? [`- **${label}:**`, ...values.map((v) => `  - ${text(v)}`)] : [];
function stage(w: Workflow): string {
	const step = w.steps.find((s) => s.status === "active") ?? w.steps.find((s) => s.status === "pending");
	const detail = w.phase === "implement" && step ? ` (${step.id} de ${w.steps.length})` : "";
	const status = w.status === "paused" ? " · **Pausado**" : w.status === "waiting" ? ` · **En espera:** ${text(w.blockedReason || "intervención humana")}` : "";
	return `**Ruta:** ${w.recipe ? ROUTES[w.recipe.route] : "pendiente"} · **Etapa:** ${PHASE_LABELS[w.phase]}${detail}${status}`;
}
// Un acuerdo del chat que cambió el alcance con receta ya armada la deja en revisión hasta el nuevo sí.
const revising = (w: Workflow) => !isApproved(w) && (w.agreements ?? []).some((a) => a.replan && !["explore", "decide"].includes(a.phase));
function approval(w: Workflow): string {
	if (w.approval && isApproved(w)) return w.approval.by === "foundations" ? "aprobada por Foundations (receta: auto), sin revisión humana" : "aprobada por la persona en OMI";
	return revising(w) ? "en revisión: un acuerdo del chat cambió el alcance; la receta se rehace y se vuelve a aprobar" : "pendiente";
}
function recipe(w: Workflow): string[] {
	const r = w.recipe; if (!r) return [];
	const c = r.classification;
	return ["", `### Receta${revising(w) ? " (en revisión)" : ""}`, `- **Objetivo:** ${text(r.objective)}`, `- **Enfoque:** ${text(r.approach)}`,
		`- **Tipo:** ${TYPES[c.type]} · **Tamaño:** ${c.size === "small" ? "chico" : "grande"} · **Riesgo:** ${c.risk === "high" ? "alto" : "bajo"}`,
		...(c.riskAreas.length ? [`- **Áreas de riesgo:** ${c.riskAreas.map(text).join("; ")}`] : []),
		...(w.diagnosis ? [`- **Causa:** ${text(w.diagnosis.cause)}`] : []), ...(w.spec ? [`- **Por qué:** ${text(w.spec.why)}`] : []),
		...list("Alcance", r.scope), ...list("Fuera de alcance", r.outOfScope),
		...r.cases.flatMap((d) => d.command.includes("\n") ? [`- **${text(d.id)}** ${text(d.description)}`, ...codeBlock(d.command)] : [`- **${text(d.id)}** ${code(d.command)} · ${text(d.description)}`]),
		...(r.lenses.length ? [`- **Lentes:** ${r.lenses.map((l) => LENSES[l]).join(", ")}`] : []),
		`- **Aprobación:** ${approval(w)}`];
}
function steps(w: Workflow): string[] {
	if (!w.steps.length) return [];
	const mark = { done: "✅", active: "▶️", pending: "⬜" };
	return ["", "### Pasos", ...w.steps.map((s) => `- ${mark[s.status]} **${text(s.id)}** ${text(s.title)}${s.commit ? ` · ${code(s.commit.slice(0, 7))}` : ""}`),
		...(w.spec?.playbook.length ? ["", "**Playbook humano**", ...w.spec.playbook.map((p, i) => `${i + 1}. ${text(p)}`)] : [])];
}
// Cada PR del stack con su número (link sólo si es un PR del repo del issue), base, pasos y estado.
function stack(w: Workflow): string[] {
	const rows = stackRows(w); if (!rows.length) return [];
	const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+$/.exec(w.source.url)?.[1];
	const pr = (url: string | null, number: number | null) => url === null || number === null ? STACK_STATUS.planned : repo && url === `https://github.com/${repo}/pull/${number}` ? url : code(url);
	const below = (base: string) => { const r = rows.find((row) => row.branch === base); return !r ? "" : r.number === null ? ` (PR ${r.index + 1})` : ` (#${r.number})`; };
	return ["", "### Stack de PRs", ...rows.map((r) => [`- **PR ${r.index + 1} de ${r.total}**`, pr(r.url, r.number), `base ${code(r.base)}${below(r.base)}`, `pasos ${r.steps.map(text).join(", ")}`, ...(r.number === null ? [] : [STACK_STATUS[r.status]]), text(r.title)].join(" · "))];
}
function decisions(w: Workflow): string[] {
	const resolution = { pending: "pendiente", assumed: "asumida", answered: "respondida" };
	return w.inferences.length ? ["", "### Decisiones", ...w.inferences.map((i) => `- **${text(i.id)}** ${text(i.question)} → ${i.answer === null ? "_sin respuesta_" : text(i.answer)} _(${resolution[i.resolution]})_`)] : [];
}
function agreements(w: Workflow): string[] {
	const all = w.agreements ?? [];
	return all.length ? ["", "### Acuerdos del chat", ...all.map((a) => `- «${text(a.quote)}» → ${text(a.summary)} _(${PHASE_LABELS[a.phase]}${a.replan ? "; rehízo la receta" : ""})_`)] : [];
}
function result(e: Evidence): string {
	if (e.outcome === "interrupted") return "⚠️ interrumpido";
	if (e.outcome === "passed") return `✅ exit ${e.exitCode}`;
	return e.kind === "red" && expectedFailure(e) ? `🔴 exit ${e.exitCode} · rojo esperado` : `❌ exit ${e.exitCode ?? "—"}`;
}
function evidence(w: Workflow, detail: Detail): string[] {
	// Último resultado por prueba: un intento viejo no se muestra como el estado actual. Resumida, sólo
	// la última de cada caso D (y de cada gate): sin el historial rojo/verde de los pasos.
	const latest = w.evidence.filter((e, i) => !w.evidence.slice(i + 1).some((n) => n.kind === e.kind && n.stepId === e.stepId && n.caseId === e.caseId && n.command === e.command))
		.filter((e) => detail === "full" || e.kind === "verification" || e.kind === "gate");
	if (!latest.length) return ["", "### Evidencia", "Sin pruebas ejecutadas todavía."];
	const label = (e: Evidence) => e.kind === "verification" ? text(e.caseId ?? "Verificación") : e.kind === "gate" ? `Gate ${code(e.command)}` : e.kind === "reproduction" ? "Reproducción" : `${text(e.stepId ?? "—")} · ${e.kind === "red" ? "rojo" : "verde"}`;
	const rows = latest.slice(-MAX_ROWS).map((e) => `| ${cell(label(e))} | ${result(e)} | ${cell(text(e.head.slice(0, 7)))} |`);
	return ["", "### Evidencia", "| Caso | Resultado | HEAD |", "|---|---|---|", ...rows, ...(latest.length > MAX_ROWS ? ["", `_${latest.length - MAX_ROWS} pruebas anteriores en el estado local._`] : [])];
}
// Los mismos avisos que el progreso y el PR draft. Resumidos, cada lente lleva su primer hallazgo y cuántos faltan.
function lenses(w: Workflow, detail: Detail | "verdicts"): string[] {
	const statuses = lensStatuses(w);
	if (!statuses.length || (!w.reviews.length && !["verify", "pr", "done"].includes(w.phase))) return [];
	const verdict = { pass: "✅ pass", fail: "❌ fail", unknown: "⚠️ unknown", "not-run": "sin correr" };
	const findings = (all: string[]) => detail === "verdicts" ? [] : detail === "full" || all.length <= 1 ? all.map((f) => `  - ${text(f)}`)
		: [`  - ${text(all[0]!)}`, `  - _y ${all.length - 1} hallazgos más en OMI_`];
	return ["", "### Avisos de los lentes", "Los lentes asesoran: unknown y fail quedan como aviso y no bloquean Verificar ni el PR draft. Sólo un fail de seguridad bloquea.",
		...statuses.flatMap((st) => [`- **${LENSES[st.lens]}:** ${verdict[st.verdict]}${st.blocking ? " · bloquea" : ""}`, ...findings(st.findings)])];
}
const FOOTER = "<sub>Sección administrada por OMI: se reescribe entera y lo que se edite acá se pierde. El pedido es el texto de arriba.</sub>";
const DETAIL = "El detalle completo está en OMI (`/omi-progress`) y en el PR draft.";
const header = (w: Workflow) => [`## Harness · #${w.source.number}`, stage(w)];
// El PR que validó el harness (mismo repo que el issue) queda como link; cualquier otro valor, como código.
function link(w: Workflow): string[] {
	if (w.publication.status !== "opened") return [];
	const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+$/.exec(w.source.url)?.[1];
	const url = w.publication.url;
	return ["", `**PR draft:** ${repo && url === `https://github.com/${repo}/pull/${w.publication.number}` ? url : code(url)}`];
}
function render(w: Workflow, detail: Detail): string {
	const note = detail === "summary" ? ["", `> **Resumida** para entrar en el límite de 65.536 caracteres de GitHub: la evidencia muestra sólo la última prueba de cada caso y cada lente su primer hallazgo. ${DETAIL}`] : [];
	return [...header(w), ...note, ...recipe(w), ...steps(w), ...stack(w), ...decisions(w), ...agreements(w), ...evidence(w, detail), ...lenses(w, detail), ...link(w), "", FOOTER].join("\n");
}
export function renderIssueSection(w: Workflow): string { return render(w, "full"); }
// De la más completa a la mínima. Cada una que resume lo dice; nada se corta en silencio.
export function issueSectionVariants(w: Workflow): string[] {
	const minimal = [...header(w), "", `La sección completa no entra en el cuerpo del issue (límite de 65.536 caracteres de GitHub): se omiten receta, pasos, decisiones, acuerdos, evidencia y hallazgos de los lentes. ${DETAIL}`, ...stack(w), ...lenses(w, "verdicts"), ...link(w), "", FOOTER].join("\n");
	return [render(w, "full"), render(w, "summary"), minimal];
}
