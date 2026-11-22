// Plan puro de recuperación: configura una opción, jamás autoriza ni ejecuta el efecto.
import { parseWorkflow, MAX_HISTORY } from "./model.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { recoveryCause, rollbackBaseline } from "./recovery-state.ts";
export function recoveryPlan(original: unknown, deliveryId: string) {
 try {
  const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && !state.lifecycle.completion, "trabajo no recuperable/completo");
  const s = state.lifecycle, d = s.deliveries?.find(d => d.id === deliveryId), config = currentLifecyclePin(s).accepted.block, sub = s.subjects.find(x => x.id === s.currentSubject), target = config.ship.targets.find(t => t.id === d?.targetId);
  lifecycleAssert(d && d.subjectId === sub?.id && sub.mergedSha && d.configHash === s.pinHash && d.result.state === "failed" && target && s.deliveries?.findLast(x => x.targetId === d.targetId && x.subjectId === sub.id)?.id === d.id, "fallo no confirmado/obsoleto; observar y reconciliar antes de compensar");
  if (target.onFailure.action === "stop") return { action: "stop" as const, reason: "Merge hecho; Ship fallido. Stop configurado, sin compensación ni entrega" };
  const cause = recoveryCause(state, deliveryId);
  if (target.onFailure.action === "fix-forward") {
   lifecycleAssert(s.budget.fixForwardPRsUsed < config.budget.maxFixForwardPRs && s.budget.attemptsUsed < config.budget.maxAttempts && s.budget.activeMilliseconds < config.budget.activeSeconds * 1000, "presupuesto raíz agotado");
   return { action: "fix-forward" as const, reason: "Nuevo checkout/PR con raíz y presupuesto compartidos; no reabrir PR mergeado" };
  }
  rollbackBaseline(cause);
  return { action: "rollback" as const, reason: "Previa y verificador identificados; falta autorización específica y guardrails antes de recuperar" };
 } catch { return { action: "blocked" as const, reason: "Recuperación no comprobable: conservar merge/recibos y detener sin efectos" }; }
}
export function stopShipRecovery(original: unknown, deliveryId: string, at: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no habilitado"); const s = state.lifecycle, d = s.deliveries?.find(d => d.id === deliveryId);
 lifecycleAssert(d && d.subjectId === s.currentSubject && ["failed", "unknown"].includes(d.result.state) && !s.completion, "no hay fallo/incertidumbre actual para detener");
 s.stage = "paused"; state.status = "paused"; state.blockedReason = `Ship ${d.targetId}: ${d.result.state}; merge hecho, cambio no entregado`; state.activity = state.blockedReason;
 state.history = [...state.history, { phase: state.phase, activity: state.activity, at }].slice(-MAX_HISTORY); state.revision++; return parseWorkflow(JSON.stringify(state));
}
