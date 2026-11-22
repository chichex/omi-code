// Proyección pura: no ejecuta, no acredita gates y no usa mensajes/historial como evidencia.
import type { Workflow } from "./model.ts";
import { PHASES, PHASES_V1, recipeNextPhase, type Phase } from "./phases.ts";
import { expectedFailure, explorationBlock, isApproved, successful } from "./state.ts";
import { lensWarnings } from "./lenses.ts";
// warning: Verificar en curso o cumplida con avisos de lentes, que no bloquean.
export const STAGE_STATUSES = ["pending", "conditional", "active", "done", "not-applicable", "waiting", "paused", "failed", "interrupted", "warning"] as const;
export const OBSERVED_MODES = ["unknown", "inline", "subagent", "mixed", "isolated-lens", "inline+lens", "subagent+lens", "mixed+lens"] as const;
export interface StageProgress {
 id: Phase; label: string; status: typeof STAGE_STATUSES[number]; current: boolean;
 planned: "unknown" | "inline" | "subagents"; observed: typeof OBSERVED_MODES[number];
}
function completed(s: Workflow, id: Phase): boolean {
 switch (id) {
  // El mismo criterio del reducer: una exploración bloqueada no está cumplida; un wontfix cierra sin esos bloqueos.
  case "explore": return s.exploration !== null && (s.exploration.disposition === "wontfix" || !explorationBlock(s.exploration));
  case "decide": return s.phase === "recipe" || s.recipe !== null;
  case "recipe": return s.recipe !== null;
  case "diagnose": return s.diagnosis !== null;
  case "spec": return s.spec !== null;
  case "approve": return isApproved(s);
  case "implement": return s.steps.length > 0 && s.steps.every(step => step.status === "done");
  case "verify": return s.phase === "pr" || s.phase === "done";
  case "pr": return s.publication.status === "opened";
  case "review": return s.version === 2 && s.lifecycle.status === "enabled" && ["ready", "land", "ship", "delivered"].includes(s.lifecycle.stage);
  case "land": return s.version === 2 && s.lifecycle.status === "enabled" && !!s.lifecycle.merges?.length;
  case "ship": return s.version === 2 && s.lifecycle.status === "enabled" && s.lifecycle.completion !== undefined;
  case "delivered": return s.version === 2 && s.lifecycle.status === "enabled" && s.lifecycle.completion?.outcome === "verified";
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
  const warnings = lensWarnings(s);
  if (warnings.some(w => w.blocking)) return "failed";
  if (warnings.length) return "warning";
 }
 return s.status === "complete" ? "done" : "active";
}
function observed(s: Workflow, phase: Phase): StageProgress["observed"] {
 const observations = s.observations?.filter(o => o.phase === phase && (o.round === s.round || !["implement", "verify", "pr"].includes(phase))) ?? [];
 const inline = observations.some(o => o.inline), subagent = observations.some(o => o.subagent), lens = observations.some(o => o.lens);
 if (inline && subagent) return lens ? "mixed+lens" : "mixed";
 if (inline) return lens ? "inline+lens" : "inline";
 if (subagent) return lens ? "subagent+lens" : "subagent";
 return lens ? "isolated-lens" : "unknown";
}
export function workflowStages(s: Workflow): StageProgress[] {
 return (s.version === 2 && s.lifecycle.status === "enabled" ? PHASES : PHASES_V1).map(({ id, label }) => ({ id, label, current: s.phase === id,
  status: s.phase === id ? currentStatus(s) : completed(s, id) ? (id === "verify" && lensWarnings(s).length ? "warning" : "done") : applicability(s, id),
  planned: id === "implement" ? s.recipe?.executor.mode ?? "unknown" : "unknown", observed: observed(s, id) }));
}
