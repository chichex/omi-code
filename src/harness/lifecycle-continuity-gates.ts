// Predicado puro: ¿el primer efecto de la etapa elegida ya pide un sí humano? Con continuidad ask, ese diálogo
// lleva también el sí de continuidad; si no, se pregunta aparte, antes. No hace I/O ni concede permisos.
import type { ContinuityAction } from "./lifecycle-continuity.ts";
import type { LifecycleConfig, LifecycleTarget } from "./lifecycle-schema.ts";
import type { EnabledLifecycle, LifecycleState } from "./lifecycle-state-schema.ts";

/** human: el primer efecto pregunta igual. auto: corre sin preguntar. unknown: depende de hechos que no se leyeron. */
export type EffectGate = "human" | "auto" | "unknown";
export interface EffectGateInput {
 action: ContinuityAction;
 lifecycle: LifecycleState;
 /** La configuración que eligió la acción: el pin vigente o, para entrar, la aceptada. */
 config: LifecycleConfig;
 /** En chichex/omi-code el merge y cualquier dispatch son siempre humanos. */
 ownRepo: boolean;
 /** push_pr de Foundations; sólo la necesita push. Sin leerla, push queda unknown. */
 pushPolicy: "ask" | "auto" | undefined;
}

/** Destinos sin entrega verificada (o no aplicable) para el sujeto y el pin vigentes, en orden. */
export function pendingShipTargets(s: EnabledLifecycle, targets: LifecycleTarget[]): LifecycleTarget[] {
 return targets.filter(t => !s.deliveries?.some(d => d.targetId === t.id && d.subjectId === s.currentSubject && d.configHash === s.pinHash && ["verified", "not-applicable"].includes(d.result.state)));
}
function confirmed(s: EnabledLifecycle, kind: "review" | "ready", sameSubject: (subjectId: string) => boolean): boolean {
 return s.operations.some(o => o.kind === kind && o.status === "confirmed" && o.receipt.outcome === "succeeded" && sameSubject(o.subjectId));
}
function reviewGate(s: EnabledLifecycle, config: LifecycleConfig, ownRepo: boolean): EffectGate {
 const provider = config.review.provider;
 // Con GitHub, una Review ya confirmada del mismo HEAD sólo se relee: no hay efecto que pregunte.
 if (provider.kind === "github" && confirmed(s, "review", id => id === s.currentSubject)) return "auto";
 if (config.review.mode !== "auto") return "human";
 return provider.kind === "gha" && ownRepo ? "human" : "auto";
}
function landGate(s: EnabledLifecycle, config: LifecycleConfig, ownRepo: boolean): EffectGate {
 if (config.land.mode !== "auto") return "human"; // ready y merge preguntan
 const number = s.subjects.find(x => x.id === s.currentSubject)?.number;
 const samePr = (id: string) => number !== undefined && s.subjects.some(x => x.id === id && x.number === number);
 // El PR nace draft: sin ready confirmado, el primer efecto es ready, que con land.mode auto no pregunta.
 if (!confirmed(s, "ready", samePr)) return "auto";
 // Ya listo, el primer efecto es el merge: humano en omi-code; afuera depende de la readiness que se lee después.
 return ownRepo ? "human" : "unknown";
}
function shipGate(s: EnabledLifecycle, config: LifecycleConfig, ownRepo: boolean): EffectGate {
 // No aplica, o todos entregados: sólo se completa. Manual o sin configurar pausan en el selector.
 if (config.ship.status !== "configured") return "auto";
 const target = pendingShipTargets(s, config.ship.targets)[0];
 if (!target) return "auto";
 const provider = target.provider;
 if (provider.kind === "omi" && provider.mode !== "observe") return "unknown"; // no conectado: corta antes de preguntar
 if (target.mode !== "auto") return "human";
 return provider.kind === "gha" && provider.mode === "dispatch" && ownRepo ? "human" : "auto";
}

/** Predice el primer sí de la etapa como lo pediría su ejecutor. El host igual pregunta la continuidad
 * si la predicción falla: el diálogo de un efecto que resultó auto no existe y nada corre sin el sí. */
export function firstEffectGate(input: EffectGateInput): EffectGate {
 const { action, lifecycle: s, config, ownRepo } = input;
 // Entrar con ask es un único sí: el de la adopción, que muestra el PR, el HEAD y la configuración que se fija.
 if (action === "adopt") return "human";
 if (s.status !== "enabled") return "unknown";
 switch (action) {
  case "review": return reviewGate(s, config, ownRepo);
  // corrections.mode auto pasa por el evaluador aislado sin otro sí; si no, «Ya corregidos» o «Corregir» preguntan.
  case "fix": return config.corrections.mode === "auto" ? "auto" : "human";
  case "push": return input.pushPolicy === undefined ? "unknown" : input.pushPolicy === "ask" ? "human" : "auto";
  case "land": return landGate(s, config, ownRepo);
  case "ship": return shipGate(s, config, ownRepo);
  default: { const unhandled: never = action; throw new Error(`Acción de continuidad desconocida: ${String(unhandled)}`); }
 }
}
