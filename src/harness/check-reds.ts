// Qué es un rojo de un D o de un gate: un solo criterio para retry, amend, verified y aceptar un riesgo en el reducer, y
// para quien muestra la evidencia. Exit 1 a 125 es un rojo; 126/127, un comando ausente; sin código o 128 o más, interrumpido.
import type { Evidence, Workflow } from "./model.ts";
import { executionEvidence } from "./execution-scope.ts";
import { MAX_CHECK_TIMEOUT_SECONDS } from "./check-timing.ts";

export function successful(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean { return evidence.exitCode === 0 && evidence.outcome === "passed"; }
// Único criterio de "falló de verdad": 126/127 son comando ausente o no ejecutable y >=128 es una señal.
export function expectedFailure(evidence: Pick<Evidence, "exitCode" | "outcome">): boolean {
 return evidence.outcome === "failed" && evidence.exitCode !== null && evidence.exitCode >= 1 && evidence.exitCode <= 125;
}
// 126/127: el comando no existe o no es ejecutable; nunca corrió.
export function missingCommand(e: Pick<Evidence, "exitCode" | "outcome">): boolean { return e.outcome === "failed" && (e.exitCode === 126 || e.exitCode === 127); }
/** La última corrida de cada D y de cada gate sobre este contenido. */
export function latestChecks(state: Workflow, fingerprint: string): Evidence[] {
 const runs = executionEvidence(state).filter(e => e.fingerprint === fingerprint && (e.kind === "verification" || e.kind === "gate"));
 return [...new Map(runs.map(e => [`${e.kind}:${e.kind === "gate" ? e.command : e.caseId}`, e])).values()];
}
const MISSING_COMMAND = "el comando no existe o no es ejecutable (exit 126 o 127): no es un rojo del cambio. Si es un gate, corregí el comando (ese no cuenta como gate); si es un D de la receta, pausá con el motivo: hay que corregir la receta";
const RERUN = "el D o el gate quedó interrumpido (sin código, por señal o por timeout): no es un rojo del cambio; volvé a correrlo con el timeoutSeconds que sugiere OMI";
// Comando ausente o interrumpido no es un rojo, igual en amend y retry; roundRed sí: con el tope del host no hay más tiempo.
export const notRedReason = (pending: readonly Evidence[]): string => pending.some(missingCommand) ? MISSING_COMMAND : RERUN;
export const roundRed = (e: Evidence): boolean => expectedFailure(e) || e.outcome === "interrupted" && e.exitCode === null && Date.parse(e.finishedAt) - Date.parse(e.startedAt) >= MAX_CHECK_TIMEOUT_SECONDS * 1000;
