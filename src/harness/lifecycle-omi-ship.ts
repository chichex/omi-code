// Ship OMI: destino/recibos/SHA fijados por host, sin tools arbitrarias ni versión=commit inferido.
export { verifyOmiShip } from "./omi-verify.ts";
export { publishOmiVersion } from "./omi-publish.ts";
export { recordOmiPublication } from "./omi-receipts.ts";
export type { OmiShipDeps } from "./omi-ship-context.ts";
export { deployOmiVersion } from "./omi-operation.ts";
