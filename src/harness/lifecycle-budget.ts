// Admisión contable, etapas y perillas. No reemplaza la autorización host ni los guardrails.
import type { EnabledLifecycle, LifecycleIntent, LifecycleDecision, OperationKind } from "./lifecycle-state-schema.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
export function currentLifecyclePin(s: EnabledLifecycle) {
 const pin = s.pins.find(p => p.accepted.blockHash === s.pinHash); lifecycleAssert(pin, "falta pin vigente"); return pin;
}
const TARGET_KINDS = new Set<OperationKind>(["ship", "publish", "deploy", "promote", "rollback", "fix-forward"]);
const STAGES: Record<EnabledLifecycle["stage"], readonly OperationKind[]> = {
 review: ["review", "ready"], corrections: ["correction", "push"], ready: ["ready", "land"], land: ["land"],
 ship: ["ship", "publish", "deploy", "promote", "rollback", "fix-forward"], paused: [], delivered: [],
};
export function lifecycleBudgetBlock(s: EnabledLifecycle, intent: LifecycleIntent, owner: string): string {
 const block = currentLifecyclePin(s).accepted.block;
 if (!s.currentSubject || intent.subjectId !== s.currentSubject) return "Falta sujeto actual adoptado";
 if (!STAGES[s.stage].includes(intent.kind)) return "Operación fuera de la etapa lifecycle";
 if (s.segments.some(segment => segment.mode !== "closed" && segment.owner !== owner)) return "Actividad interrumpida: reconciliar duración antes de otro proceso";
 if (s.budget.attemptsUsed >= block.budget.maxAttempts) return "Presupuesto global de intentos agotado";
 if (s.budget.activeMilliseconds >= block.budget.activeSeconds * 1000) return "Presupuesto de tiempo activo agotado";
 if (intent.kind === "correction" && s.budget.roundsUsed >= block.corrections.maxRounds) return "Se agotaron las rondas de corrección post-PR";
 if (intent.kind === "fix-forward" && s.budget.fixForwardPRsUsed >= block.budget.maxFixForwardPRs) return "Presupuesto fix-forward/PR de recuperación agotado";
 const subject = s.subjects.find(x => x.id === intent.subjectId);
 if (TARGET_KINDS.has(intent.kind)) {
  if (!subject?.mergedSha) return "Ship/recuperación exige merge observado";
  const target = block.ship.targets.find(t => t.id === intent.targetId);
  if (block.ship.status !== "configured" || !target) return "Destino Ship no configurado";
  if ((intent.kind === "rollback" || intent.kind === "fix-forward") && target.onFailure.action !== intent.kind) return "La recuperación no está configurada para este destino";
 } else if (intent.targetId !== null) return "Esta operación no admite destino Ship";
 return "";
}
export function assertLifecycleDecision(s: EnabledLifecycle, intent: LifecycleIntent, decision: LifecycleDecision): void {
 lifecycleAssert(decision.kind === intent.kind && decision.subjectId === intent.subjectId && decision.targetId === intent.targetId && decision.configHash === s.pinHash, "decisión ajena u obsoleta");
 const block = currentLifecyclePin(s).accepted.block;
 const target = block.ship.targets.find(t => t.id === intent.targetId);
 const mode = intent.kind === "review" ? block.review.mode : intent.kind === "correction" ? block.corrections.mode
  : intent.kind === "land" || intent.kind === "ready" ? block.land.mode
   : intent.kind === "rollback" || intent.kind === "fix-forward" ? target?.onFailure.mode
    : intent.kind === "push" ? "ask" : target?.mode;
 // Foundations de push se observa por el host: no deriva de corrections:auto.
 const foundationsPush = intent.kind === "push" && decision.source === "policy" && !!decision.authorityHash;
 lifecycleAssert(decision.source === "person" || mode === "auto" || foundationsPush, "falta decisión humana específica; ask no admite auto implícito");
}
