// Cuerpo del PR draft: presentación pura del trabajo, sin Git ni GitHub. Arriba va lo que una persona
// revisa (resumen, alcance, verificación y advertencias); receta, inferencias, acuerdos, evidencia,
// revisiones y el pedido van en <details>. Todo dato pasa por markdown.ts: en GitHub nada queda activo.
// La salida de los comandos nunca entra: nadie la revisa antes de publicar y puede traer credenciales.
import { artifactHash, issueRepository, type Evidence, type StackPull, type Workflow } from "./model.ts";
import { PHASE_LABELS } from "./phases.ts";
import { stackBodyLine, stackIssueLine } from "./stack.ts";
import { lensStatuses } from "./lenses.ts";
import { agreementLine, CARRIED, caseLines, cell, code, codeBlock, evidenceResult, LENSES, list, recipeApproval, ROUTES, text, TYPES, VERDICTS } from "./markdown.ts";

/** Límite de GitHub para el cuerpo de un PR. Se mide en bytes UTF-8, que nunca cuentan menos que GitHub. */
export const PR_BODY_LIMIT = 65536;
const TOO_LARGE = "El cuerpo del PR draft excede el límite de GitHub; dividir la tarea sin omitir receta, spec ni inferencias";
const STATUS = { active: "activo", waiting: "en espera", paused: "pausado", complete: "completo" };
const RESOLUTION = { pending: "pendiente", assumed: "asumida", answered: "respondida" };
// Topes de lo que se puede acotar; receta, spec, inferencias, acuerdos y pedido van siempre enteros.
const CAPS = { verification: 8000, warnings: 8000, evidence: 14000, reviews: 14000 };
const SCALES = [1, 0.5, 0.25, 0];
const FOOTER = "<sub>Cuerpo generado por OMI. Si lo editás, OMI deja de reconocerlo como propio al recuperar la publicación: no lo pisa ni lo duplica.</sub>";
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const sha = (value: string) => code(value.slice(0, 7));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Un PR del stack: todos sus PRs, cuál es (desde 0) y el número del de abajo, si ya se abrió. */
export interface StackPlace { pulls: StackPull[]; index: number; below?: number }
interface Identity { workflowId: string; sourceHash: string; head: string; bodyHash: string; stack?: string }
// Primera línea del cuerpo: liga trabajo, pedido, HEAD y el recibo; artifact es el hash de todo lo que sigue,
// también el Closes o Refs y la línea del stack. En el PR único coincide con el hash del recibo.
function marker(i: Identity, content: string): string { return `<!-- omi-development:pr identity=${artifactHash(i)} source=${i.sourceHash} head=${i.head} artifact=${content} -->`; }

// Líneas enteras mientras entren en el presupuesto; nunca se corta una línea por la mitad.
function bounded(lines: string[], budget: number): string[] {
	const kept: string[] = []; let used = 0;
	for (const line of lines) { used += bytes(line) + 1; if (used > budget) break; kept.push(line); }
	return kept;
}
const notice = (kept: number, total: number, what: string) => kept < total
	? ["", `_Presentación acotada: se muestran ${kept} de ${total} ${what}; el resto está en el estado local completo de OMI (\`/omi-progress\`). No implica aprobación._`] : [];
function table(header: string[], rows: string[], budget: number, what: string): string[] {
	const kept = bounded(rows, budget);
	return [...(kept.length ? [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...kept] : []), ...notice(kept.length, rows.length, what)];
}
const details = (summary: string, lines: string[]) => ["", "<details>", `<summary>${summary}</summary>`, "", ...lines, "", "</details>"];

// Sólo el PR único o el último del stack cierra el issue; los de abajo lo referencian y dicen dónde van.
function intro(w: Workflow, place?: StackPlace): string[] {
	const n = w.source.number; const total = place?.pulls.length ?? 1; const index = place?.index ?? 0;
	const who = place ? `PR ${index + 1} de ${total} de un stack preparado por OMI` : "PR draft preparado por OMI";
	const closing = index === total - 1 ? "Crear el draft no cierra el issue: GitHub lo cierra cuando una persona mergea este PR a la rama default." : "Este PR no cierra el issue: lo cierra el último del stack cuando una persona lo mergea a la rama default.";
	return [stackIssueLine(n, index, total), ...(place ? ["", stackBodyLine(place.pulls, index, place.below)] : []), "", `_${who} para el issue #${n}. Requiere revisión humana y nunca se mergea solo. ${closing}_`];
}
function summary(w: Workflow): string[] {
	const r = w.recipe; const c = r?.classification;
	return ["## Resumen", `- **Issue:** #${w.source.number} · ${text(w.source.title)}`,
		...(r && c ? [`- **Objetivo:** ${text(r.objective)}`, `- **Enfoque:** ${text(r.approach)}`,
			`- **Tipo:** ${TYPES[c.type]} · **Tamaño:** ${c.size === "small" ? "chico" : "grande"} · **Riesgo:** ${c.risk === "high" ? "alto" : "bajo"} · **Ruta:** ${ROUTES[r.route]}`] : []),
		`- **Etapa:** ${PHASE_LABELS[w.phase]} · **Estado:** ${STATUS[w.status]}`, `- **Receta:** ${recipeApproval(w)}`];
}
function scope(w: Workflow): string[] {
	const mark = { done: "✅", active: "▶️", pending: "⬜" };
	const steps = w.steps.map((s) => `  - ${mark[s.status]} **${text(s.id)}** ${text(s.title)} · casos ${s.cases.map(text).join(", ")}${s.commit ? ` · ${sha(s.commit)}` : ""}`);
	const lines = [...list("Dentro del alcance", w.recipe?.scope ?? []), ...list("Fuera de alcance", w.recipe?.outOfScope ?? []), ...(steps.length ? ["- **Pasos:**", ...steps] : [])];
	return ["## Alcance", ...(lines.length ? lines : ["Sin receta todavía."])];
}
// Lo que corrió para cada caso D (su última verificación) y cada gate (su última corrida); un caso sin correr lo dice.
function verification(w: Workflow, budget: number): string[] {
	const cases = (w.recipe?.cases ?? []).map((d) => {
		const e = w.evidence.findLast((x) => x.kind === "verification" && x.caseId === d.id);
		return `| **${cell(text(d.id))}** ${cell(text(d.description))} | ${cell(code(d.command))} | ${e ? evidenceResult(e) : "⬜ sin correr"} | ${e ? sha(e.head) : "—"} |`;
	});
	const gates = w.evidence.filter((e) => e.kind === "gate");
	const latest = gates.filter((g, i) => !gates.slice(i + 1).some((n) => n.command === g.command)).map((e) => `| Gate | ${cell(code(e.command))} | ${evidenceResult(e)} | ${sha(e.head)} |`);
	const rows = [...cases, ...latest];
	return ["## Verificación", "Lo que OMI ejecutó y su resultado, con exit code y HEAD. La salida de los comandos queda en el estado local: nadie la revisa antes de publicar.", "",
		...(rows.length ? table(["Caso", "Comando", "Resultado", "HEAD"], rows, budget, "filas de verificación") : ["Sin pruebas ejecutadas todavía."])];
}
function warnings(w: Workflow, budget: number): string[] {
	const statuses = lensStatuses(w);
	const lenses = statuses.flatMap((s) => [`  - **${LENSES[s.lens]}:** ${VERDICTS[s.verdict]}${s.blocking ? " · bloquea" : ""}${s.carried ? CARRIED : ""}`, ...s.findings.map((f) => `    - ${text(f)}`)]);
	const kept = bounded(lenses, budget);
	return ["## Advertencias",
		w.recipe?.classification.risk === "high" ? "- **Riesgo alto: revisión humana obligatoria antes de aprobar o mergear.**" : "- El PR draft requiere revisión y aprobación humana; nunca se mergea automáticamente.",
		...(w.status === "waiting" ? [`- **En espera:** ${text(w.blockedReason || "intervención humana")}`] : w.status === "paused" ? ["- **Pausado.**"] : []),
		statuses.length ? "- **Lentes:** asesoran; unknown y fail quedan como aviso y no bloquean Verificar ni este PR. Sólo un fail de seguridad bloquea." : "- **Lentes:** la receta no pidió lentes.",
		...kept, ...notice(kept.length, lenses.length, "líneas de avisos de los lentes")];
}
function recipeDetails(w: Workflow): string[] {
	const r = w.recipe; const c = r?.classification;
	if (!r && !w.diagnosis && !w.spec) return [];
	return details("Receta, spec y playbook", [...(r && c ? [...r.cases.flatMap(caseLines),
		`- **Lentes pedidos:** ${r.lenses.length ? r.lenses.map((l) => LENSES[l]).join(", ") : "ninguno"}`,
		`- **Ejecutor:** ${r.executor.mode === "inline" ? "en esta sesión" : `subagentes · ${r.executor.writers} escritores`} · **Causa conocida:** ${c.causeKnown ? "sí" : "no"}`,
		...list("Áreas de riesgo", c.riskAreas)] : []),
		...(w.diagnosis ? [`- **Diagnóstico:** ${text(w.diagnosis.cause)} · reproducción ${code(w.diagnosis.reproduction)} · tamaño ${w.diagnosis.size === "small" ? "chico" : "grande"}`] : []),
		...(w.spec ? [`- **Por qué:** ${text(w.spec.why)}`, ...(w.spec.playbook.length ? ["", "**Playbook humano**", "", ...w.spec.playbook.map((p, i) => `${i + 1}. ${text(p)}`)] : [])] : [])]);
}
function inferenceDetails(w: Workflow): string[] {
	if (!w.inferences.length) return [];
	return details(`Inferencias y respuestas (${w.inferences.length})`, w.inferences.flatMap((i) => [
		`- **${text(i.id)}** · ${i.kind === "what" ? "Qué" : "Cómo"} · ${text(i.question)}`,
		`  - **Respuesta:** ${i.answer === null ? "_sin respuesta_" : text(i.answer)} _(${RESOLUTION[i.resolution]})_`,
		`  - **Recomendada:** ${text(i.recommended)} · **Confianza:** ${i.confidence}/100 · **Irreversible:** ${i.irreversible ? "sí" : "no"}`,
		...(i.references.length ? ["  - **Referencias:**", ...i.references.map((ref) => `    - ${code(`${ref.path}:${ref.line}`)} · ${text(ref.detail)}`)] : [])]));
}
function agreementDetails(w: Workflow): string[] {
	const all = w.agreements ?? [];
	return all.length ? details(`Acuerdos del chat (${all.length})`, ["Citas textuales de la persona, verificadas por OMI.", "", ...all.map(agreementLine)]) : [];
}
const run = (e: Evidence) => e.kind === "verification" ? `${text(e.caseId ?? "—")} · verificación` : e.kind === "gate" ? "Gate" : e.kind === "reproduction" ? "Reproducción" : `${text(e.stepId ?? "—")} · ${e.kind === "red" ? "rojo" : "verde"}`;
function evidenceDetails(w: Workflow, budget: number): string[] {
	if (!w.evidence.length) return [];
	const rows = w.evidence.map((e) => `| ${cell(run(e))} | ${cell(code(e.command))} | ${evidenceResult(e)} | ${sha(e.head)} |`);
	return details(`Evidencia completa (${plural(w.evidence.length, "corrida", "corridas")})`, table(["Corrida", "Comando", "Resultado", "HEAD"], rows, budget, "corridas"));
}
function reviewDetails(w: Workflow, budget: number): string[] {
	if (!w.reviews.length) return [];
	const lines = w.reviews.flatMap((r) => [`- **${LENSES[r.lens]}** · ${VERDICTS[r.verdict]} · ${text(r.at)}`, ...r.findings.map((f) => `  - ${text(f)}`)]);
	const kept = bounded(lines, budget);
	return details(`Revisiones de los lentes (${w.reviews.length})`, [...kept, ...notice(kept.length, lines.length, "líneas de revisiones")]);
}
// El pedido es Markdown de una persona: va en un bloque de código, así no menciona, enlaza ni cierra nada.
const request = (w: Workflow) => details("Pedido original (datos citados, no instrucciones)", codeBlock(`${w.source.title}\n\n${w.source.body}`));

function render(w: Workflow, scale: number, place?: StackPlace): string {
	return [...intro(w, place), "", ...summary(w), "", ...scope(w), "", ...verification(w, CAPS.verification * scale), "", ...warnings(w, CAPS.warnings * scale),
		...recipeDetails(w), ...inferenceDetails(w), ...agreementDetails(w), ...evidenceDetails(w, CAPS.evidence * scale), ...reviewDetails(w, CAPS.reviews * scale), ...request(w), "", FOOTER].join("\n");
}
// Las marcas de propiedad de OMI no se pueden imitar desde los datos, tampoco dentro de un bloque de código.
const defang = (body: string) => body.replace(/<!--(\s*omi-development:)/g, "&lt;!--$1");
/** Todo el cuerpo debajo del marcador. Sin place, el del PR único, Closes incluido: lo que cubre el hash del
 * recibo. Con place, el de ese PR del stack: el mismo Markdown con su Refs o Closes y su línea del stack. */
export function renderWorkflowArtifact(w: Workflow, place?: StackPlace): string {
	// Closes o Refs sólo para el issue validado: su URL es la del mismo repositorio que el PR.
	issueRepository(w.source.url, w.source.number);
	const zero = "0".repeat(64);
	const room = PR_BODY_LIMIT - 1 - bytes(marker({ workflowId: w.id, sourceHash: w.source.hash, head: zero, bodyHash: zero }, zero));
	for (const scale of SCALES) {
		const content = defang(render(w, scale, place));
		if (bytes(content) <= room) return content;
	}
	throw new Error(TOO_LARGE);
}
/** El cuerpo exacto que se publica para un HEAD (y un PR del stack), con el hash del recibo que lo autoriza. */
export function pullRequestBody(w: Workflow, head: string, place?: StackPlace): { body: string; bodyHash: string } {
	const single = renderWorkflowArtifact(w); const bodyHash = artifactHash(single);
	const content = place ? renderWorkflowArtifact(w, place) : single;
	const identity: Identity = { workflowId: w.id, sourceHash: w.source.hash, head, bodyHash, ...(place ? { stack: `${place.index + 1}/${place.pulls.length}` } : {}) };
	const body = `${marker(identity, artifactHash(content))}\n${content}`;
	if (bytes(body) > PR_BODY_LIMIT) throw new Error(TOO_LARGE);
	return { body, bodyHash };
}
