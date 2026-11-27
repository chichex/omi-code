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
const CAPPED = "el D o el gate se cortó con el tope del host (1800 s): más tiempo no hay y cuenta como rojo. amend no lo corrige: usá retry. Si es un gate, partí el comando en partes más chicas; si es un D, el comando lo fija la receta: si no entra en el tope, pausá con el motivo";
const RERUN = "el D o el gate quedó interrumpido (sin código, por señal o por timeout): no es un rojo del cambio; volvé a correrlo con el timeoutSeconds que sugiere OMI. Si vuelve a morir por la misma señal (exit 128 o más) sobre este contenido, es un crash del cambio y cuenta como rojo";
// Comando ausente o interrumpido no es un rojo, igual en amend y retry; roundRed sí: con el tope del host no hay más tiempo
// y un crash que se repite da lo mismo cada vez.
export const notRedReason = (pending: readonly Evidence[]): string => pending.some(cappedTimeout) ? CAPPED : pending.some(missingCommand) ? MISSING_COMMAND : RERUN;
export const roundRed = (state: Workflow, e: Evidence): boolean => correctable(state, e) || cappedTimeout(e);
// La salida que guarda el host termina con esta marca sólo si Pi lo cortó con el tope: la duración sola no alcanza, porque
// un Esc o una laptop suspendida también dejan 1800 s de reloj sin código.
const CAPPED_MARK = `\n[OMI: cortado por el tope del host de ${MAX_CHECK_TIMEOUT_SECONDS} s]`;
const MAX_OUTPUT = 12_000;
/** La salida que se guarda: sus últimos 12.000 caracteres y, si Pi lo cortó con el tope, la marca al final. */
export function recordedOutput(result: { output: string; timedOut?: true }, seconds: number): string {
 const mark = result.timedOut && seconds >= MAX_CHECK_TIMEOUT_SECONDS ? CAPPED_MARK : "";
 return result.output.slice(-(MAX_OUTPUT - mark.length)) + mark;
}
const cappedTimeout = (e: Evidence): boolean => e.outcome === "interrupted" && e.exitCode === null && e.output.endsWith(CAPPED_MARK) && Date.parse(e.finishedAt) - Date.parse(e.startedAt) >= MAX_CHECK_TIMEOUT_SECONDS * 1000;
/** Un crash del cambio: el D o el gate murió por la misma señal (exit 128 o más) las dos últimas veces sobre este contenido. */
export function repeatedCrash(state: Workflow, e: Evidence): boolean {
 if (e.outcome !== "interrupted" || e.exitCode === null || e.exitCode < 128) return false;
 const runs = executionEvidence(state).filter(r => r.fingerprint === e.fingerprint && r.kind === e.kind && (e.kind === "gate" ? r.command === e.command : r.caseId === e.caseId));
 const previous = runs[runs.indexOf(e) - 1];
 return previous?.outcome === "interrupted" && previous.exitCode === e.exitCode;
}
/** Lo que amend corrige: un rojo (exit 1 a 125) o un crash que se repite. Sin amends, retry. */
export const correctable = (state: Workflow, e: Evidence): boolean => expectedFailure(e) || repeatedCrash(state, e);
/** Qué hacer en verified con un gate que no pasó: sobre este contenido, un rojo o un crash repetido se corrige con amend y un
 * corte en el tope pide retry; otra interrumpida, o lo que vino de un contenido anterior, se repite sobre este contenido. */
export function gateFailureAction(state: Workflow, e: Evidence, fingerprint: string): string {
 if (e.fingerprint !== fingerprint || !roundRed(state, e)) return "repetilo sobre este contenido";
 return cappedTimeout(e) ? "se cortó con el tope del host (1800 s) y cuenta como rojo; amend no lo corrige: usá retry" : "es un rojo sobre este contenido: corregilo con amend (sin amends, retry), o repetilo si no se reproduce";
}
