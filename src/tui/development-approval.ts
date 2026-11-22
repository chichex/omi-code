// Documento de consentimiento: datos íntegros, sin ANSI ni efectos de navegación.
import type { Lens, Workflow } from "../harness/model.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWorkflowArtifact } from "../harness/pr-body.ts";
import { stackLines } from "../harness/stack.ts";

// legend: texto propio de OMI ya escrito como se ve; nunca datos de la receta.
export interface ApprovalLine { kind: "heading" | "text" | "command" | "legend"; text: string }
export interface ApprovalSection { id: string; title: string; lines: ApprovalLine[] }
export interface ApprovalDocument { title: string; sections: ApprovalSection[] }
const TYPES = { add: "Nueva capacidad", fix: "Corrección", improve: "Mejora", chore: "Mantenimiento" };
const ROUTES = { direct: "Directa", diagnostic: "Diagnóstico", spec: "Con spec" };
const LENSES: Record<Lens, string> = { quality: "Calidad", reliability: "Confiabilidad", security: "Seguridad", compliance: "Cumplimiento", resilience: "Resiliencia", refuter: "Refutador" };
const line = (text: string): ApprovalLine => ({ kind: "text", text });
const heading = (text: string): ApprovalLine => ({ kind: "heading", text });
const bullets = (values: string[]): ApprovalLine[] => values.length ? values.map((v) => line(`• ${v}`)) : [line("Ninguno declarado.")];
export const APPROVAL_AUTHORIZATION = "Autoriza implementar estos pasos y sus commits locales. La aprobación general de receta NO concede grants ni dispensa la confirmación explícita de comandos por patrones o sintaxis, incluidos los casos D y setup. Sin Foundations v2 aceptada, nada pregunta. Con v2, sólo las líneas simples que no coinciden con un patrón corren sin preguntar; patrones y sintaxis no soportada piden sí, salvo un grant humano exacto del trabajo/pedido. Un grant: un sí humano al comando exacto queda guardado para este trabajo/pedido. La receta queda en la sección del harness al final del cuerpo del issue; el pedido de arriba no se toca. No autoriza push, merge, workflows ni deploy. Las prohibiciones del proyecto y confirmaciones sensibles de OMI prevalecen.";

// Escapes visibles y reversibles: jamás interpretar controles/ANSI/bidi de datos externos.
// Los saltos lógicos se conservan. El backslash se duplica para distinguirlo de un escape.
export function approvalDisplayText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (c) => {
		if (c === "\n") return c;
		if (c === "\t") return "\\t";
		if (c === "\r") return "\\r";
		const code = c.codePointAt(0)!;
		return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
	});
}
// La leyenda muestra cada escape tal como aparece en los comandos, sin escaparla otra vez.
export const COMMAND_LEGEND = `│ inicia línea; ↳ continúa visualmente; ↵ es un salto real. Se muestran escapes literales: ${approvalDisplayText("\\")} = backslash, ${approvalDisplayText("\t")} = tab, ${approvalDisplayText("\r")} = retorno, \\uXXXX = control/invisible.`;
export function approvalLineText(l: ApprovalLine): string { return l.kind === "legend" ? l.text : approvalDisplayText(l.text); }
// Sin trim ni word-wrap: espacios finales y saltos siguen inspeccionables. Sin ancho (RPC), una fila por línea lógica.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function commandDisplayLines(value: string, width = Number.POSITIVE_INFINITY): string[] {
	const logical = approvalDisplayText(value).split("\n"); const result: string[] = [];
	for (const [index, original] of logical.entries()) {
		let current = "│ "; let columns = 2;
		const value = original + (index < logical.length - 1 ? "↵" : "");
		for (const { segment } of graphemes.segment(value)) {
			const size = visibleWidth(segment);
			if (columns + size > width) { result.push(current); current = "↳ "; columns = 2; }
			current += segment; columns += size;
		}
		// Un salto final no agrega una línea lógica vacía con un prefijo espurio.
		if (original || index < logical.length - 1 || !index) result.push(current);
	}
	return result;
}
export function approvalDocument(state: Workflow): ApprovalDocument {
	const recipe = state.recipe;
	if (!recipe) throw new Error("Falta receta para revisar");
	// Sin tope propio: la revisión navega por secciones. Sólo se comprueba que el cuerpo del PR draft entre en GitHub.
	renderWorkflowArtifact(state);
	const { classification: c, executor } = recipe; const stack = stackLines(state);
	const sections: ApprovalSection[] = [
		{ id: "summary", title: "Resumen", lines: [line(`Issue #${state.source.number} · ${state.source.title}`),
			line(`Tipo: ${TYPES[c.type]} · Ruta: ${ROUTES[recipe.route]} · Tamaño: ${c.size === "small" ? "Chico" : "Grande"}`),
			line(`Riesgo: ${c.risk === "high" ? "alto · requiere revisión humana" : "bajo"} · Ejecutor: ${executor.mode === "inline" ? "En esta sesión" : `Subagentes · ${executor.writers} escritores`}`),
			line(`Objetivo: ${recipe.objective}`), line(`Qué cambia: ${recipe.scope[0] ?? "Ver enfoque"}`),
			line(`Alcance: ${recipe.scope.length} puntos; ${recipe.outOfScope.length} exclusiones. Ver Alcance.`),
			line(`Riesgos: ${c.riskAreas.join("; ") || "Sin áreas adicionales declaradas"}`),
			line("El sí autoriza implementación, commits locales y la sección del harness en el issue; no reemplaza el sí explícito al comando cuando haga falta. Revisá Autorización y Pruebas."),
			line("Secciones: Resumen · Enfoque · Alcance · Pasos · Pruebas · Inferencias · Spec · Autorización · Fuente.")] },
		{ id: "approach", title: "Enfoque y riesgos", lines: [heading("Enfoque"), line(recipe.approach), heading("Riesgos"), ...bullets(c.riskAreas), line(`Causa conocida: ${c.causeKnown ? "sí" : "no"}`), heading("Lentes de verificación"), ...bullets(recipe.lenses.map((l) => LENSES[l]))] },
		{ id: "scope", title: "Alcance", lines: [heading("Dentro del alcance"), ...bullets(recipe.scope), heading("Fuera de alcance"), ...bullets(recipe.outOfScope),
			...(state.agreements?.length ? [heading("Acuerdos del chat"), ...bullets(state.agreements.map((a) => `«${a.quote}» → ${a.summary}`))] : [])] },
		{ id: "steps", title: "Pasos C / casos D", lines: [...state.steps.flatMap((s) => [heading(`${s.id} · ${s.title}`), line(`Casos cubiertos: ${s.cases.join(", ")}`)]),
			...(stack.length ? [heading("Stack de PRs"), line("Cada grupo se publica como un PR draft: el primero sobre main y cada uno sobre el de abajo. Sólo el último cierra el issue."), ...stack.map(line)] : [])] },
		{ id: "commands", title: "Pruebas y comandos exactos", lines: [line("Estos comandos definen la verificación. Revisarlos o aprobar la receta no los ejecuta ni crea grants: siguen la política de Foundations y las confirmaciones independientes."),
			{ kind: "legend" as const, text: COMMAND_LEGEND },
			...recipe.cases.flatMap((d) => [heading(`${d.id} · ${d.description}`), { kind: "command" as const, text: d.command }])] },
		{ id: "inferences", title: "Inferencias y respuestas", lines: state.inferences.length ? state.inferences.flatMap((i) => [heading(`${i.id} · ${i.kind === "what" ? "Qué" : "Cómo"} · ${i.question}`),
			line(`Recomendada: ${i.recommended}`), line(`Confianza estimada: ${i.confidence}/100 · Irreversible: ${i.irreversible ? "sí" : "no"}`),
			line(`Resolución: ${{ pending: "pendiente", assumed: "asumida", answered: "respondida" }[i.resolution]}`), line(`Respuesta: ${i.answer ?? "Sin respuesta"}`),
			...i.references.map((r) => line(`${r.path}:${r.line} · ${r.detail}`))]) : [line("No hay inferencias registradas.")] },
		{ id: "spec", title: "Spec y playbook", lines: state.spec ? [heading("Por qué"), line(state.spec.why), ...state.spec.steps.flatMap((s) => [heading(`${s.id} · ${s.title}`), line(`Casos: ${s.cases.join(", ")}`)]), heading("Playbook humano"), ...bullets(state.spec.playbook)] : [line("Ruta Directa: no requiere spec adicional.")] },
		{ id: "authorization", title: "Autorización", lines: [line(APPROVAL_AUTHORIZATION), line("Volver/cancelar conserva exploración y respuestas; se puede ajustar la receta y pedir un nuevo sí. No se ejecuta nada durante la revisión.")] },
		{ id: "source", title: "Fuente y vínculo técnico", lines: [line(`Issue #${state.source.number} · ${state.source.title}`), line(state.source.url), line(`Huella de fuente: ${state.source.hash}`)] },
	];
	return { title: "Aprobar receta y sincronizar issue", sections };
}
export function approvalText(document: ApprovalDocument): string {
	return document.sections.map((s) => `${s.title}\n${s.lines.map((l) => l.kind === "command" ? commandDisplayLines(l.text).join("\n") : approvalLineText(l)).join("\n")}`).join("\n\n");
}
