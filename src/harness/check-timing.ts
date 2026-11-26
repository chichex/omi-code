// Cuánto tarda un check: sale de finishedAt − startedAt de la evidencia guardada, sin campos nuevos en el estado.
// Un setup no se guarda: su duración se conoce sólo si el mismo comando corrió con otra etiqueta.
import type { EvidenceKind, Workflow } from "./model.ts";

export const MAX_CHECK_TIMEOUT_SECONDS = 1800;
/** Un comando que alguna vez tardó esto o más espera turno en la cola de checks del repo. */
export const HEAVY_CHECK_MS = 30_000;
interface Run { ms: number; finishedAt: number; complete: boolean }

// De cualquier vuelta, también las archivadas, y del mismo comando exacto.
function runsOf(state: Workflow, command: string): Run[] {
 return [...(state.attempts ?? []).flatMap((a) => a.evidence), ...state.evidence]
  .filter((e) => e.command === command)
  .map((e) => ({ ms: Date.parse(e.finishedAt) - Date.parse(e.startedAt), finishedAt: Date.parse(e.finishedAt), complete: e.outcome !== "interrupted" }))
  .filter((r) => Number.isFinite(r.ms) && r.ms >= 0);
}
/** La duración de la última corrida que terminó sola (pasó o falló); nunca la de una interrumpida. */
export function lastCompleteMs(state: Workflow, command: string): number | undefined {
 return runsOf(state, command).filter((r) => r.complete)
  .reduce<Run | undefined>((last, r) => !last || r.finishedAt >= last.finishedAt ? r : last, undefined)?.ms;
}
/** Sin historia, es pesado un gate o un setup; con historia, si alguna corrida tardó 30 s o más, también una interrumpida. */
export function heavyCheck(state: Workflow, kind: EvidenceKind | "setup", command: string): boolean {
 const runs = runsOf(state, command);
 if (!runs.length) return kind === "gate" || kind === "setup";
 return runs.reduce((max, r) => Math.max(max, r.ms), 0) >= HEAVY_CHECK_MS;
}
const margin = (knownMs: number) => Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.ceil(knownMs * 1.5 / 1000));
/** Un timeout menor que 1,5× la última corrida completa sube a ese piso, con tope de 1800 s, y lo dice. */
export function plannedTimeout(requested: number, knownMs: number | undefined): { seconds: number; note?: string } {
 if (knownMs === undefined || requested >= margin(knownMs)) return { seconds: requested };
 const seconds = margin(knownMs); const cap = seconds === MAX_CHECK_TIMEOUT_SECONDS ? `, con tope de ${MAX_CHECK_TIMEOUT_SECONDS} s` : "";
 return { seconds, note: `timeoutSeconds ${requested} → ${seconds}: la última corrida completa de este comando tardó ${Math.round(knownMs / 1000)} s; el host deja 1,5× de margen${cap}.` };
}
/** Qué decir de un check que Pi cortó por tiempo: el doble del usado o 1,5× lo conocido, con tope de 1800 s. */
export function timeoutNote(used: number, knownMs: number | undefined): string {
 const cut = "No cuenta como corrida completa: quedó interrumpida.";
 if (used >= MAX_CHECK_TIMEOUT_SECONDS) return `Se cortó por tiempo a los ${used} s, el tope del host. ${cut} Partí el comando en partes más chicas.`;
 const next = Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.max(used * 2, knownMs === undefined ? 0 : margin(knownMs)));
 return `Se cortó por tiempo a los ${used} s. ${cut} Volvé a correrlo con timeoutSeconds: ${next}.`;
}
