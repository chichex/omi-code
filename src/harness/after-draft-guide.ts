// Guía del agente después del PR draft: Review, Land y Ship de este PR los corre la persona con /omi-work, o los
// encadena la continuidad configurada. El agente no dispara workflows ni pasa comandos de terminal para hacerlo.
// Proyección pura del estado guardado: no ejecuta, no reanuda la cadena ni concede permisos.
import type { Workflow } from "./model.ts";
import { PHASE_LABELS } from "./phases.ts";
import { afterDraft } from "./execution-scope.ts";
import { currentContinuityPause } from "./continuity-pause.ts";
import { continuityPauseGuide, continuityPauseLine } from "./continuity-pause-text.ts";
import { selectLifecycleContinuation, type ContinuityAction } from "./lifecycle-continuity.ts";

const COMMANDS = { adopt: "/omi-work adopt", review: "/omi-work review", fix: "/omi-work fix", push: "/omi-work fix", land: "/omi-work land", ship: "/omi-work ship" } satisfies Record<ContinuityAction, string>;
const ADOPT_THEN_REVIEW = "corré /omi-work adopt y después /omi-work review; si la continuidad está configurada, adopt ya sigue con la Review";
const NO_WORKFLOWS = "No dispares workflows (por ejemplo, gh workflow run) ni le pases comandos de terminal para hacerlo: pasale el comando /omi-work tal cual";

const adopted = (state: Workflow) => state.version === 2 && state.lifecycle.status === "enabled";
/** El lifecycle no adopta un stack publicado: adopt lo rechaza, así que la guía no lo ofrece. */
const stacked = (state: Workflow) => state.publication.status === "opened" && !!state.publication.stack;
/** Una Review pedida en el chat, también con GHA, es un comando de la persona: adopt la habilita la primera vez. */
function ghaReview(state: Workflow): string {
 if (stacked(state)) return "Si la persona pide una Review, también con GHA: el lifecycle no adopta stacks y no la corre sobre estos PRs";
 return `Si la persona pide una Review, también con GHA, es ${adopted(state) ? "/omi-work review" : "/omi-work adopt y después /omi-work review"}: corre la Review configurada y, si es gha, OMI dispara el workflow configurado con el sí que corresponda`;
}
const enabledPin = (state: Workflow) => {
 if (state.version !== 2 || state.lifecycle.status !== "enabled") return undefined;
 const s = state.lifecycle; return s.pins.find(p => p.accepted.blockHash === s.pinHash)?.accepted.block;
};
/** Quién corre los efectos de este PR: antes de adoptarlo, adopt los habilita; después, cada comando de su etapa. */
function owners(state: Workflow): string {
 if (stacked(state)) return "El lifecycle no adopta stacks: Review, Land y Ship de estos PRs no corren con /omi-work";
 return adopted(state)
  ? "Review, correcciones, Land y Ship de este PR los corre la persona con /omi-work review | fix | land | ship, o los encadena la continuidad configurada"
  : "Review, Land y Ship de este PR los habilita la persona con /omi-work adopt y la Review se corre con /omi-work review, o los encadena la continuidad configurada";
}
/** Próximo paso de la persona: el de la pausa vigente o, sin pausa, el que elegiría la cadena con el estado guardado.
 * Sin la Review observada en esta sesión, el selector no pide repetirla: sale de los hallazgos ya registrados. */
export function afterDraftNextStep(state: Workflow): string {
 const pause = currentContinuityPause(state);
 if (pause) return continuityPauseGuide(pause.reason, pause.stage, pause.stackPulls).next;
 const selection = selectLifecycleContinuation({ workflow: state, config: null, trigger: "advance", reviewObserved: null });
 switch (selection.kind) {
  case "complete": return "nada: el lifecycle de este PR terminó";
  case "yield": return "esperá a que el agente termine la corrección en curso";
  case "action": return `corré ${COMMANDS[selection.action]}`;
  case "pause": return selection.reason === "entry-trigger-required" ? ADOPT_THEN_REVIEW : continuityPauseGuide(selection.reason, selection.stage).next;
  default: { const unhandled: never = selection; throw new Error(`Selección desconocida: ${JSON.stringify(unhandled)}`); }
 }
}
const nextLine = (state: Workflow) => `Próximo paso para la persona: ${afterDraftNextStep(state)}.`;
/** Para el contexto del agente, junto a la guía de la etapa (que dice quién corre cada efecto): la pausa vigente, la
 * Review pedida en el chat y el próximo paso. Vacío antes del draft o durante una corrección en curso, salvo la pausa. */
export function afterDraftGuide(state: Workflow): string {
 const pause = currentContinuityPause(state), line = pause && continuityPauseLine(pause);
 if (!afterDraft(state)) return line ? `${line}\nLos comandos /omi-work los corre la persona: pasale el próximo paso tal cual, sin reemplazarlo por comandos de terminal.` : "";
 return [line, `${ghaReview(state)}. ${NO_WORKFLOWS}.`, nextLine(state)].filter(Boolean).join("\n");
}
/** Con la continuidad de fix en auto o ask, la cadena publica la corrección verificada: no hay que pedir /omi-work fix. */
export function correctionPushGuide(state: Workflow): string {
 const fix = enabledPin(state)?.continuity?.fix;
 if (fix === "auto" || fix === "ask") return `Al terminar una corrección con verified, la continuidad hace el push al mismo PR con el permiso push_pr de Foundations${fix === "ask" ? " (fix: ask, con su sí en pantalla)" : ""}: no le pidas /omi-work fix.`;
 return "Al terminar una corrección con verified, pedile a la persona /omi-work fix para el push al mismo PR.";
}
/** Motivo de una tool bloqueada después del draft: no manda a omi_workflow_check, que ahí no corre. */
export function afterDraftToolBlock(state: Workflow, tool: string): string {
 return `Harness: ${tool} no está habilitada después del PR draft. ${owners(state)}. ${NO_WORKFLOWS}. ${nextLine(state)}`;
}
/** Error de omi_workflow_check después del draft: con el trabajo terminado, pausado o activo fuera de una corrección. */
export function afterDraftCheckError(state: Workflow): string {
 const inactive = state.status === "complete" || state.status === "paused" ? `El trabajo no está activo (${PHASE_LABELS[state.phase]}). ` : "";
 return `${inactive}Después del PR draft, omi_workflow_check sólo corre durante una corrección en curso: no dispara workflows ni comandos sueltos. ${owners(state)}. ${nextLine(state)}`;
}
