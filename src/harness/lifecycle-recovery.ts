// Recuperación preserva merge/identidad/recibos; restaurar servicio nunca equivale a entregar el cambio.
export { recoveryPlan, stopShipRecovery } from "./recovery-plan.ts";
export { captureOmiRecoveryBaseline, rollbackOmiVersion } from "./omi-recovery.ts";
export { recordRecoveryBaseline, recordRecoveryVerification } from "./recovery-state.ts";
export { rollbackGhaTarget, rollbackRunName } from "./gha-recovery.ts";
export type { GhaRecoveryDeps } from "./gha-recovery.ts";
export { reconcileOmiOperation } from "./omi-reconcile.ts";
