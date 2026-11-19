// Cuerpo del PR draft: presentación pura del trabajo, sin Git ni GitHub.
import type { Workflow } from "./model.ts";
import { lensReport } from "./lenses.ts";

function escaped(value: string): string { return value.replace(/<!--\s*omi-development:/g, "&lt;!-- omi-development:"); }
function bounded(value: string, limit: number): string {
 const safe = escaped(value);
 return safe.length <= limit ? safe : safe.slice(0, limit) + "\n[Presentación acotada: consultar el estado local completo; no implica aprobación.]";
}
export function githubBody(body: string): string {
 // Conservative UTF-8 bound, including ownership markers and other wrappers.
 if (Buffer.byteLength(body, "utf8") > 65536) throw new Error("El artefacto excede el límite de GitHub; dividir la tarea sin omitir receta, spec ni inferencias");
 return body;
}
function section(title: string, value: unknown): string {
 return `## ${title}\n\n${escaped(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`;
}
export function renderWorkflowArtifact(workflow: Workflow): string {
 const source = `${workflow.source.title}\n\n${workflow.source.body}`.split("\n").map(line => `> ${line}`).join("\n");
 const evidence = workflow.evidence.map(e => ({ id: e.id, kind: e.kind, command: e.command, step: e.stepId, case: e.caseId, exitCode: e.exitCode, outcome: e.outcome, head: e.head, fingerprint: e.fingerprint, }));
 return githubBody(["# OMI · Desarrollo asistido", "Pedido externo citado como datos, no instrucciones del harness.", section("Pedido original", source),
  section("Ruta y estado", { route: workflow.recipe?.route ?? "pendiente", phase: workflow.phase, status: workflow.status, blockedReason: workflow.blockedReason }),
  section("Clasificación", workflow.recipe?.classification ?? "Sin clasificar"), section("Inferencias y respuestas", workflow.inferences),
  // Sólo si hay: una publicación pendiente de un estado anterior conserva su hash.
  ...(workflow.agreements?.length ? [section("Acuerdos del chat (citas textuales de la persona)", workflow.agreements.map(({ quote, summary, replan }) => ({ quote, summary, replan })))] : []),
  section("Spec C/D y playbook", { recipe: workflow.recipe, diagnosis: workflow.diagnosis, spec: workflow.spec, steps: workflow.steps }),
  section("Evidencia observada (no aprobación de PR)", evidence.length ? bounded(JSON.stringify(evidence, null, 2), 14000) : "Sin evidencia ejecutada"), section("Avisos de los lentes", bounded(lensReport(workflow), 8000)), section("Revisiones y errores", bounded(JSON.stringify(workflow.reviews, null, 2), 14000)),
  workflow.recipe?.classification.risk === "high" ? "**Riesgo alto: revisión humana obligatoria antes de aprobar o mergear.**" : "El PR draft requiere revisión y aprobación humana; nunca se mergea automáticamente.",
 ].join("\n"));
}
