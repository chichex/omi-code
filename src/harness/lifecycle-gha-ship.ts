// Superficie interna Ship GHA: verificación de releases/recibos, no shell ni workflows libres.
export { verifyGhaRelease } from "./gha-release-ship.ts";
export { observeGhaShipReceipt, dispatchGhaShip, shipRunName } from "./gha-receipt-ship.ts";
export type { GhaShipDeps } from "./ship-context.ts";
