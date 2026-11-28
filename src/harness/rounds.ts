// El presupuesto de vueltas sale del estado y de nada más: la guía, el status y el progreso lo leen de acá.
// La vuelta 0 es la pasada inicial y cada retry abre la siguiente, hasta maxRounds; maxRounds sube con
// round_added (una persona en la TUI). Con el PR adoptado, la corrección tiene su propio presupuesto.
import { MAX_AMENDS, type Workflow } from "./model.ts";
import { amendsOf } from "./lenses.ts";

export interface RoundBudget { round: number; maxRounds: number; retriesLeft: number; amends: number; maxAmends: number }
export function roundBudget(state: Workflow): RoundBudget | undefined {
 if (!["implement", "verify", "pr"].includes(state.phase)) return undefined;
 if (state.version === 2 && state.pullRequest?.ownership === "adopted") return undefined;
 return { round: state.round, maxRounds: state.maxRounds, retriesLeft: Math.max(0, state.maxRounds - state.round), amends: amendsOf(state).length, maxAmends: MAX_AMENDS };
}
export function roundBudgetLine(state: Workflow): string {
 const s = roundBudget(state);
 if (!s) return "";
 return `vuelta ${s.round} de ${s.maxRounds} · ${s.retriesLeft === 1 ? "queda" : "quedan"} ${s.retriesLeft} retry · amends ${s.amends} de ${s.maxAmends}`;
}
