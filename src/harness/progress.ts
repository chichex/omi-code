// Proyección pura: no ejecuta, no acredita gates y no usa mensajes/historial como evidencia.
import type { Workflow } from "./model.ts";
import { PHASES, recipeNextPhase, type Phase } from "./phases.ts";
import { expectedFailure, isApproved, successful } from "./state.ts";
export const STAGE_STATUSES = ["pending", "conditional", "active", "done", "not-applicable", "waiting", "paused", "failed", "interrupted"] as const;
export const OBSERVED_MODES = ["unknown", "inline", "subagent", "mixed", "isolated-lens", "inline+lens", "mixed+lens"] as const;
export interface StageProgress {
 id: Phase; label: string; status: typeof STAGE_STATUSES[number]; current: boolean;
 planned: "unknown" | "inline" | "subagents"; observed: typeof OBSERVED_MODES[number];
}
function completed(s: Workflow, id: Phase): boolean {
 switch (id) {
  case "explore": return s.exploration !== null && s.exploration.disposition !== "needs-info" && !s.exploration.missingFoundation.length && !s.exploration.dependencies.some(d => d.blocking && !d.ready);
  case "decide": return s.phase === "recipe" || s.recipe !== null;
  case "recipe": return s.recipe !== null;
  case "diagnose": return s.diagnosis !== null;
  case "spec": return s.spec !== null;
  case "approve": return isApproved(s);
  case "implement": return s.steps.length > 0 && s.steps.every(step => step.status === "done");
  case "verify": return s.phase === "pr" || s.phase === "done";
  case "pr": return s.publication.status === "opened";
  case "done": return s.phase === "done";
  case "closed": return s.phase === "closed";
 }
}
function applicability(s: Workflow, id: Phase): "pending" | "conditional" | "not-applicable" {
 if (s.phase === "closed" && id !== "explore" && id !== "closed") return "not-applicable";
 if (id === "closed") return s.recipe ? "not-applicable" : "conditional";
 if (id !== "diagnose" && id !== "spec") return "pending";
 if (!s.recipe) return "conditional";
 if (id === "diagnose") return s.diagnosis || recipeNextPhase(s.recipe.route) === "diagnose" ? "pending" : "not-applicable";
 return recipeNextPhase(s.recipe.route) === "diagnose" ? "conditional" : s.recipe.route === "spec" ? "pending" : "not-applicable";
}
function currentStatus(s: Workflow): StageProgress["status"] {
 if (s.status === "waiting" || s.status === "paused") return s.status;
 const checks = s.phase === "implement" ? s.evidence.filter(e => e.stepId === s.steps.find(step => step.status === "active")?.id && (e.kind === "red" || e.kind === "green"))
  : s.phase === "verify" ? s.evidence.filter(e => e.kind === "verification" || e.kind === "gate")
  : s.phase === "diagnose" || s.phase === "explore" ? s.evidence.filter(e => e.kind === "reproduction") : [];
 // Último resultado por comando/caso: un éxito de otro check no oculta una falla pendiente.
 const latest = checks.filter((e, index) => !checks.slice(index + 1).some(next => next.command === e.command && next.caseId === e.caseId));
 if (latest.some(e => e.outcome === "interrupted")) return "interrupted";
 if (latest.some(e => !successful(e) && !(e.kind === "red" && expectedFailure(e)) && !(e.kind === "reproduction" && expectedFailure(e)))) return "failed";
 if (s.phase === "implement" && latest.some(e => e.kind === "red" && !expectedFailure(e))) return "failed";
 if (s.phase === "verify") {
  const reviews = s.reviews.filter((r, index) => !s.reviews.slice(index + 1).some(next => next.lens === r.lens));
  if (reviews.some(r => r.verdict === "fail")) return "failed";
  if (reviews.some(r => r.verdict === "unknown")) return "interrupted";
 }
 return s.status === "complete" ? "done" : "active";
}
export function workflowStages(s: Workflow): StageProgress[] {
 return PHASES.map(({ id, label }) => ({ id, label, current: s.phase === id,
  status: s.phase === id ? currentStatus(s) : completed(s, id) ? "done" : applicability(s, id),
  planned: id === "implement" ? s.recipe?.executor.mode ?? "unknown" : "unknown", observed: "unknown" }));
}
