// Texto para la persona de cada motivo de pausa: qué pasó y cuál es el próximo paso.
// Un único mapa para el panel, /omi-work status y el contexto del agente; nunca el código crudo.
import type { ContinuityPause, ContinuityPauseRecord } from "./continuity-pause.ts";

type Stage = NonNullable<ContinuityPauseRecord["stage"]>;
export const CONTINUITY_PAUSE_TITLE = "Continuidad en pausa";
const COMMANDS = { entry: "/omi-work adopt", review: "/omi-work review", fix: "/omi-work fix", land: "/omi-work land", ship: "/omi-work ship" } satisfies Record<Stage, string>;
const NAMES = { entry: "la adopción del PR", review: "Review", fix: "la corrección", land: "Land", ship: "Ship" } satisfies Record<Stage, string>;
const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export interface PauseGuide { message: string; next: string }
/** El lifecycle adopta un solo PR. Sin el número (una pausa sin ese dato), no inventa uno. */
function stackUnsupportedGuide(pulls?: number): PauseGuide {
 return { message: `Este trabajo se publicó como stack de ${pulls === undefined ? "PRs" : `${pulls} PRs`} y el lifecycle no adopta stacks`, next: "mergealos en orden con su sí" };
}
/** La misma razón como error de /omi-work adopt: dos oraciones, con el próximo paso. */
export function stackUnsupportedText(pulls: number): string {
 const { message, next } = stackUnsupportedGuide(pulls); return `${message}. ${sentence(next)}.`;
}
/** Sin la Review observada en esta sesión, el próximo paso sale de los hallazgos ya registrados: Land o fix no repiten la Review. */
function unobservedReviewGuide(stage?: Stage): PauseGuide {
 const message = "La Review del HEAD actual no se observó en esta sesión";
 if (stage === "land") return { message, next: "corré /omi-work land; relee GitHub y no repite la Review" };
 if (stage === "fix") return { message, next: "corré /omi-work fix; usa los hallazgos ya registrados" };
 return { message: "Falta la Review observada del HEAD actual", next: "corré /omi-work review" };
}

/** `stackPulls`: sólo lo usa stack-unsupported. */
export function continuityPauseGuide(reason: ContinuityPause, stage?: Stage, stackPulls?: number): PauseGuide {
 const name = stage ? NAMES[stage] : "la etapa", command = stage ? COMMANDS[stage] : "el comando /omi-work de la etapa";
 switch (reason) {
  case "workflow-paused": return { message: "El trabajo está pausado", next: "retomalo con /omi-work resume" };
  case "workflow-waiting": return { message: "El trabajo espera a una persona", next: "mirá qué falta con /omi-work status" };
  case "workflow-blocked": return { message: "El trabajo tiene un bloqueo", next: "resolvelo y seguí con el comando de la etapa; el bloqueo está en /omi-work status" };
  case "publication-required": return { message: "Todavía no hay un PR draft publicado", next: "publicalo con /omi-work pr" };
  case "entry-trigger-required": return { message: "La entrada sólo corre al publicar el PR", next: "adoptalo con /omi-work adopt" };
  case "manual": return { message: `${sentence(name)} está en manual`, next: `corré ${command}` };
  case "config-required": return { message: "Falta configurar el lifecycle", next: "/omi-setup" };
  case "subject-required": return { message: "Falta el PR adoptado vigente", next: "revisá el estado con /omi-work status" };
  case "lifecycle-paused": return { message: "El lifecycle quedó en pausa", next: "la recuperación la decide una persona; el motivo está en /omi-progress" };
  case "operation-unsettled": return { message: "Hay una operación con resultado incierto", next: "no se repite sola; revisá en GitHub" };
  case "operation-failed": return { message: "La última operación falló", next: "no se reintenta sola; mirá el motivo en /omi-progress y repetí el comando de esa etapa" };
  case "budget-exhausted": return { message: "Se agotó el presupuesto del lifecycle (intentos o tiempo activo)", next: "la cadena no gasta más; seguí a mano con los comandos /omi-work" };
  case "review-facts-required": return unobservedReviewGuide(stage);
  case "human-required": return { message: "Un hallazgo necesita una decisión humana", next: "revisalo en /omi-progress y decidí cómo seguir" };
  case "rounds-exhausted": return { message: "Se agotaron las rondas de corrección", next: "revisá los hallazgos que quedan en /omi-progress y decidí cómo seguir" };
  case "correction-failed": return { message: "La última corrección falló", next: "no se reintenta sola; mirá el motivo en /omi-progress y corré /omi-work fix" };
  case "correction-facts-required": return { message: "Faltan los hechos de la corrección en curso", next: "revisá /omi-work status y seguí con /omi-work fix" };
  case "ship-unconfigured": return { message: "Ship no está configurado o es manual", next: "configuralo con /omi-setup o declaralo con /omi-work ship" };
  case "activity-unsettled": return { message: "Hay una actividad del lifecycle sin cerrar", next: "reconciliala antes de otro efecto; está en /omi-progress" };
  case "stack-unsupported": return stackUnsupportedGuide(stackPulls);
  case "declined": return { message: `Dijiste que no a seguir con ${name}`, next: `cuando quieras, ${command}` };
  case "not-adopted": return { message: "No se adoptó el PR", next: "adoptalo con /omi-work adopt" };
  case "no-progress": return { message: `La cadena no confirmó progreso en ${name} y no repite el efecto`, next: `mirá /omi-progress y seguí con ${command}` };
  case "continuity-disabled": return { message: "La configuración vigente ya no tiene continuidad", next: `seguí a mano con ${command}` };
  case "error": return { message: "La cadena se cortó por un error y puede haber un efecto incierto", next: "no se reintenta sola; revisá /omi-progress y GitHub antes de repetir" };
  default: { const unhandled: never = reason; throw new Error(`Motivo de pausa desconocido: ${String(unhandled)}`); }
 }
}
/** «mensaje: próximo paso», con el detalle de texto libre al final si lo hay. */
export function continuityPauseText(pause: Pick<ContinuityPauseRecord, "reason" | "stage" | "detail" | "stackPulls">): string {
 const { message, next } = continuityPauseGuide(pause.reason, pause.stage, pause.stackPulls);
 return `${message}: ${next}${pause.detail ? ` · Detalle: ${pause.detail}` : ""}`.slice(0, 1000);
}
export const continuityPauseLine = (pause: Pick<ContinuityPauseRecord, "reason" | "stage" | "detail" | "stackPulls">): string => `${CONTINUITY_PAUSE_TITLE} · ${continuityPauseText(pause)}`;
