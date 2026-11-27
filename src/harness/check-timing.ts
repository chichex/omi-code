// Cuánto tarda un check: sale de finishedAt − startedAt de la evidencia guardada, sin campos nuevos en el estado.
// Un setup no se guarda en el estado: el host recuerda sus corridas en memoria, por trabajo, mientras dura la sesión
// (SetupHistory). Al reabrir OMI se pierden, y el primer setup de cada comando vuelve a esperar turno.
import type { EvidenceKind, Workflow } from "./model.ts";

export const MAX_CHECK_TIMEOUT_SECONDS = 1800;
/** Un comando que alguna vez tardó esto o más espera turno en la cola de checks del repo. */
export const HEAVY_CHECK_MS = 30_000;
interface Run { ms: number; finishedAt: number; complete: boolean }
/** Una corrida de setup de esta sesión: complete si terminó sola, sin corte, señal ni cancelación. */
export interface SetupRun extends Run { command: string }
const MAX_SETUP_RUNS = 50;
/** Las corridas de setup por trabajo, sólo en memoria y con tope: el estado no las guarda. */
export class SetupHistory {
 readonly #runs = new Map<string, readonly SetupRun[]>();
 of(workflowId: string): readonly SetupRun[] { return this.#runs.get(workflowId) ?? []; }
 record(workflowId: string, run: SetupRun): void { this.#runs.set(workflowId, [...this.of(workflowId), run].slice(-MAX_SETUP_RUNS)); }
}

// De cualquier vuelta, también las archivadas, y de los setup de la sesión, siempre del mismo comando exacto.
function runsOf(state: Workflow, command: string, setups: readonly SetupRun[]): Run[] {
 const evidence = [...(state.attempts ?? []).flatMap((a) => a.evidence), ...state.evidence].filter((e) => e.command === command)
  .map((e) => ({ ms: Date.parse(e.finishedAt) - Date.parse(e.startedAt), finishedAt: Date.parse(e.finishedAt), complete: e.outcome !== "interrupted" }));
 return [...evidence, ...setups.filter((r) => r.command === command)].filter((r) => Number.isFinite(r.ms) && r.ms >= 0);
}
/** La duración de la última corrida que terminó sola (pasó o falló); nunca la de una interrumpida. */
export function lastCompleteMs(state: Workflow, command: string, setups: readonly SetupRun[] = []): number | undefined {
 return runsOf(state, command, setups).filter((r) => r.complete)
  .reduce<Run | undefined>((last, r) => !last || r.finishedAt >= last.finishedAt ? r : last, undefined)?.ms;
}
/** Pesado si alguna corrida tardó 30 s o más, también una interrumpida. Sólo una corrida completa prueba que es liviano:
 * sin ninguna (sin historia o sólo cortes), es pesado un gate o un setup. */
export function heavyCheck(state: Workflow, kind: EvidenceKind | "setup", command: string, setups: readonly SetupRun[] = []): boolean {
 const runs = runsOf(state, command, setups);
 if (runs.some((r) => r.ms >= HEAVY_CHECK_MS)) return true;
 return !runs.some((r) => r.complete) && (kind === "gate" || kind === "setup");
}
const margin = (knownMs: number) => Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.ceil(knownMs * 1.5 / 1000));
/** Un timeout menor que 1,5× la última corrida completa sube a ese piso, con tope de 1800 s, y lo dice. */
export function plannedTimeout(requested: number, knownMs: number | undefined): { seconds: number; note?: string } {
 if (knownMs === undefined || requested >= margin(knownMs)) return { seconds: requested };
 const seconds = margin(knownMs); const cap = seconds === MAX_CHECK_TIMEOUT_SECONDS ? `, con tope de ${MAX_CHECK_TIMEOUT_SECONDS} s` : "";
 return { seconds, note: `timeoutSeconds ${requested} → ${seconds}: la última corrida completa de este comando tardó ${Math.round(knownMs / 1000)} s; el host deja 1,5× de margen${cap}.` };
}
/** Qué decir de un check que Pi cortó por tiempo: el doble del usado o 1,5× lo conocido, con tope de 1800 s. Con el tope ya
 * usado, un D o un gate cuentan como rojo y piden retry, como dice el reducer (check-reds). */
export function timeoutNote(used: number, knownMs: number | undefined, kind?: EvidenceKind | "setup"): string {
 const cut = "No cuenta como corrida completa: quedó interrumpida.";
 if (used >= MAX_CHECK_TIMEOUT_SECONDS) {
  const red = kind === "gate" || kind === "verification" ? " Cuenta como rojo y pide retry." : "";
  const next = kind === "verification" ? "El comando lo fija la receta: si no entra en el tope, pausá con el motivo." : "Partí el comando en partes más chicas.";
  return `Se cortó por tiempo a los ${used} s, el tope del host: más tiempo no hay.${red} ${next}`;
 }
 const next = Math.min(MAX_CHECK_TIMEOUT_SECONDS, Math.max(used * 2, knownMs === undefined ? 0 : margin(knownMs)));
 return `Se cortó por tiempo a los ${used} s. ${cut} Volvé a correrlo con timeoutSeconds: ${next}.`;
}
