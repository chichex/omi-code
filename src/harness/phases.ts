// Catálogo del proceso real, compartido por esquema, reducer, instrucciones y presentación.
import type { Plan, Recipe } from "./model.ts";
export const PHASES = [
 { id: "explore", label: "Explorar" }, { id: "decide", label: "Resolver inferencias" }, { id: "recipe", label: "Preparar receta" },
 { id: "diagnose", label: "Diagnóstico" }, { id: "spec", label: "Escribir spec" }, { id: "approve", label: "Aprobar receta" },
 { id: "implement", label: "Implementar" }, { id: "verify", label: "Verificar" }, { id: "pr", label: "Abrir PR draft" },
 { id: "done", label: "PR draft abierto" }, { id: "closed", label: "Cerrado sin cambio" },
] as const;
export type Phase = typeof PHASES[number]["id"];
export const PHASE_LABELS = Object.fromEntries(PHASES.map(p => [p.id, p.label])) as Record<Phase, string>;
export function recipeRoute(c: Plan["classification"]): Recipe["route"] {
 return c.type === "fix" && !c.causeKnown ? "diagnostic" : c.size === "small" ? "direct" : "spec";
}
const ROUTE_NEXT = { direct: "approve", diagnostic: "diagnose", spec: "spec" } as const;
export const recipeNextPhase = (route: Recipe["route"]): Phase => ROUTE_NEXT[route];
