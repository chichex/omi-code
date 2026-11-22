// Proyección pura del lifecycle para progreso y status: rondas, presupuesto, checks, hallazgos y bloqueos.
// No ejecuta ni acredita nada; un legacy en done sigue siendo «PR draft abierto», nunca una entrega.
import type { Workflow } from "./model.ts";
import { lifecycleFindingBlocks } from "./lifecycle-state.ts";

const STAGES = { review: "Review", corrections: "Correcciones", ready: "Listo para merge (no es permiso)", land: "Land", ship: "Ship", paused: "Pausado", delivered: "Entregado", complete: "Terminado" } as const;
const OUTCOMES = { verified: "entrega verificada", "externally-attested": "entrega atestiguada por una persona, sin origen demostrado", "not-applicable": "Ship no aplica (elegido explícitamente)", "manual-attested": "entrega declarada a mano, sin verificar" } as const;
const minutes = (ms: number) => Math.floor(ms / 60000);
/** Bloqueos honestos del lifecycle: hallazgos sin disposición vigente y operaciones inciertas. */
export function lifecycleBlocks(state: Workflow): string[] {
 if (state.version !== 2 || state.lifecycle.status !== "enabled") return [];
 const s = state.lifecycle;
 const uncertain = s.operations.filter(o => o.status === "unknown").map(o => `${o.kind} ${o.id} incierto: observar/reconciliar, no repetir`);
 const open = s.segments.filter(x => x.mode !== "closed").map(x => `Actividad ${x.id} sin cerrar: reconciliar antes de otro efecto`);
 return [...lifecycleFindingBlocks(s), ...uncertain, ...open];
}
export function lifecycleLines(state: Workflow): string[] {
 if (state.version !== 2 || state.lifecycle.status !== "enabled") {
  return state.publication.status === "opened" ? ["Lifecycle no habilitado: el trabajo terminó en PR draft. No hubo Review, Land ni Ship verificados. Para seguir: /omi-work adopt."] : [];
 }
 const s = state.lifecycle, pin = s.pins.find(p => p.accepted.blockHash === s.pinHash)?.accepted.block, subject = s.subjects.find(x => x.id === s.currentSubject);
 if (!pin) return ["Lifecycle sin configuración vigente: no se inician efectos."];
 const checks = s.checks.filter(c => c.subjectId === s.currentSubject), passed = checks.filter(c => c.state === "success").length;
 const blocks = lifecycleFindingBlocks(s), corrected = s.ledger.length - blocks.length;
 const rounds = s.corrections ?? [], active = rounds.findLast(r => r.status !== "pushed" && r.status !== "failed");
 const reviews = s.operations.filter(o => o.kind === "review"), lastReview = reviews.at(-1);
 const approval = s.approvals.findLast(a => a.subjectId === s.currentSubject);
 const merge = s.merges?.at(-1);
 const lines = [
  `Lifecycle · ${STAGES[s.stage]} · PR #${subject?.number ?? state.pullRequest?.number ?? "?"}${subject ? ` · ${subject.headSha.slice(0, 12)}` : ""}`,
  `Presupuesto: intentos ${s.budget.attemptsUsed}/${pin.budget.maxAttempts} · rondas ${s.budget.roundsUsed}/${pin.corrections.maxRounds} · activo ${minutes(s.budget.activeMilliseconds)}/${minutes(pin.budget.activeSeconds * 1000)} min · fix-forward ${s.budget.fixForwardPRsUsed}/${pin.budget.maxFixForwardPRs}`,
  `Review ${pin.review.provider.kind}: ${lastReview ? lastReview.status === "confirmed" ? lastReview.receipt.outcome === "succeeded" ? "observada" : "falló" : lastReview.status === "unknown" ? "incierta" : "en curso" : "sin correr"}${approval ? ` · opinión ${approval.state}` : ""}`,
  `Checks del SHA actual: ${checks.length ? `${passed}/${checks.length} OK` : "sin checks observados"}`,
  `Hallazgos: ${blocks.length} pendiente(s) · ${corrected} con disposición vigente`,
  ...(active ? [`Corrección en curso: ronda ${rounds.indexOf(active) + 1} · ${active.status}`] : []),
  ...(merge ? [`Merge observado ${merge.mergeSha.slice(0, 12)}: integrado, no entregado por sí solo`] : []),
  ...(pin.ship.status === "configured" ? pin.ship.targets.map(t => { const d = s.deliveries?.findLast(x => x.targetId === t.id && x.subjectId === s.currentSubject); return `Ship ${t.id}: ${d ? d.result.state : merge ? "sin verificar" : "espera el merge"}`; }) : [`Ship: ${pin.ship.status === "unconfigured" ? "sin configurar (omi init --development)" : pin.ship.status}`]),
  ...(s.completion ? [`Resultado: ${OUTCOMES[s.completion.outcome]}`] : []),
  ...lifecycleBlocks(state).map(b => `Bloqueo: ${b}`),
 ];
 return lines.map(line => line.slice(0, 1000));
}
/** Una línea para paneles bajos y angostos: primero lo que bloquea, para no aparentar avance. */
export function lifecycleSummary(state: Workflow): string | undefined {
 if (state.version !== 2 || state.lifecycle.status !== "enabled") return state.publication.status === "opened" ? "Sin Review/Land/Ship" : undefined;
 const s = state.lifecycle, pin = s.pins.find(p => p.accepted.blockHash === s.pinHash)?.accepted.block; if (!pin) return undefined;
 return `Hallazgos ${lifecycleFindingBlocks(s).length} · rondas ${s.budget.roundsUsed}/${pin.corrections.maxRounds} · intentos ${s.budget.attemptsUsed}/${pin.budget.maxAttempts}`;
}
