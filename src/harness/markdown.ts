// Markdown seguro para GitHub, compartido por la sección del issue y el cuerpo del PR draft. Todo dato
// (modelo, receta, comandos, persona) pasa por text, code, cell o codeBlock: en GitHub nada queda activo.
import type { AcceptedRisk, Agreement, Evidence, Lens, Recipe, Workflow } from "./model.ts";
import { PHASE_LABELS } from "./phases.ts";
import { expectedFailure, isApproved } from "./state.ts";

export const TYPES = { add: "Nueva capacidad", fix: "Corrección", improve: "Mejora", chore: "Mantenimiento" };
export const ROUTES = { direct: "Directa", diagnostic: "Diagnóstico", spec: "Con spec" };
export const LENSES: Record<Lens, string> = { quality: "Calidad", reliability: "Confiabilidad", security: "Seguridad", compliance: "Cumplimiento", resilience: "Resiliencia", refuter: "Refutador" };
// Controles, bidi e invisibles se ven como escapes; nunca se publican crudos.
const visible = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (c) => c === "\n" || c === "\t" ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
// Texto del modelo, de un comando o de la persona: en GitHub nada queda activo. Una palabra que podría
// enlazar, avisar o referenciar (URL, www., correo, @mención, #123, GH-123) va entera como código; el
// resto escapa HTML y la sintaxis de links, imágenes y código. Los saltos no abren bloques nuevos.
const LINKABLE = /:\/\/|www\.|@|#\d|\bgh-\d/i;
const escaped = (value: string) => value.replace(/[\\`[\]]/g, "\\$&").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const text = (value: string) => visible(value).split(/(\s+)/).map((part, i) => i % 2 ? part.replace(/\n/g, "<br>") : LINKABLE.test(part) ? code(part) : escaped(part)).join("");
// Código en línea con una cerca más larga que cualquier racha de backticks del contenido.
export function code(value: string): string {
	const content = visible(value).replace(/\n/g, " ↵ ");
	const fence = "`".repeat(Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
	const pad = /^[` ]|[` ]$/.test(content) ? " " : "";
	return `${fence}${pad}${content}${pad}${fence}`;
}
// En una tabla de GFM el pipe separa celdas incluso dentro del código: se escapa siempre.
export const cell = (value: string) => value.replace(/\|/g, "\\|");
// Bloque cercado e indentado: ninguna línea empieza en la primera columna y la cerca es más larga que
// cualquier racha de backticks del contenido.
export function codeBlock(value: string): string[] {
	const content = visible(value).split("\n");
	const fence = "`".repeat(Math.max(3, ...content.flatMap((l) => [...l.matchAll(/`+/g)].map((m) => m[0].length + 1))));
	return [fence, ...content, fence].map((l) => `  ${l}`.trimEnd() || "  ");
}
export const list = (label: string, values: string[]) => values.length ? [`- **${label}:**`, ...values.map((v) => `  - ${text(v)}`)] : [];
// Un caso D de la receta; un comando multilínea va en un bloque con una cerca más larga.
export const caseLines = (d: Recipe["cases"][number]): string[] => d.command.includes("\n") ? [`- **${text(d.id)}** ${text(d.description)}`, ...codeBlock(d.command)] : [`- **${text(d.id)}** ${code(d.command)} · ${text(d.description)}`];
export const agreementLine = (a: Agreement): string => `- «${text(a.quote)}» → ${text(a.summary)} _(${PHASE_LABELS[a.phase]}${a.replan ? "; rehízo la receta" : ""})_`;
export const VERDICTS = { pass: "✅ pass", fail: "❌ fail", unknown: "⚠️ unknown", "not-run": "sin correr" };
/** Un lente que aprobó limpio el contenido de partida de una corrección liviana y no se repitió. */
export const CARRIED = " · revisado antes de la corrección liviana";
/** El veredicto visible: un unknown sin resultado (conexión, plazo, formato) no se confunde con uno que juzgó el lente. */
export const verdictLabel = (verdict: keyof typeof VERDICTS, noResult: boolean | undefined): string => `${VERDICTS[verdict]}${noResult ? " · sin resultado" : ""}`;
// Riesgos de seguridad que una persona aceptó desde la TUI: van aparte y cada lente lo marca.
export const ACCEPTED_RISKS_TITLE = "Riesgos aceptados por una persona";
export const ACCEPTED_RISKS_NOTE = "Hallazgos de seguridad que bloqueaban Verificar y una persona aceptó con `/omi-work accept-risk` desde la TUI de OMI. Valen sólo para ese contenido: si cambia, seguridad se vuelve a evaluar y la persona los acepta otra vez si siguen.";
export const ACCEPTED_MARK = " · riesgo aceptado por una persona";
export const acceptedRiskLine = (a: AcceptedRisk): string => `- **Contenido ${code(a.fingerprint.slice(0, 12))}** · ${text(a.at)} · **Motivo:** ${text(a.reason)}`;
export function evidenceResult(e: Evidence): string {
	if (e.outcome === "interrupted") return "⚠️ interrumpido";
	if (e.outcome === "passed") return `✅ exit ${e.exitCode}`;
	return e.kind === "red" && expectedFailure(e) ? `🔴 exit ${e.exitCode} · rojo esperado` : `❌ exit ${e.exitCode ?? "—"}`;
}
// Un acuerdo del chat que cambió el alcance con receta ya armada la deja en revisión hasta el nuevo sí.
export const revising = (w: Workflow) => !isApproved(w) && (w.agreements ?? []).some((a) => a.replan && !["explore", "decide"].includes(a.phase));
export function recipeApproval(w: Workflow): string {
	if (w.approval && isApproved(w)) return w.approval.by === "foundations" ? "aprobada por Foundations (receta: auto), sin revisión humana" : "aprobada por la persona en OMI";
	return revising(w) ? "en revisión: un acuerdo del chat cambió el alcance; la receta se rehace y se vuelve a aprobar" : "pendiente";
}
