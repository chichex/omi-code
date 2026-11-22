// Reconcilia una mutación OMI ya iniciada: GET de identidad conocida, nunca otro POST/PUT.
import { DeploymentsSchema } from "../client/views.ts";
import { environmentPath } from "../tools/scope.ts";
import { omiShipContext, type OmiShipDeps } from "./omi-ship-context.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { sameData } from "./lifecycle-value.ts";
import type { LifecycleReceipt } from "./lifecycle-state-schema.ts";
export async function reconcileOmiOperation(original: unknown, operationId: string, deps: OmiShipDeps): Promise<{ state: "confirmed" | "unknown"; receipt: LifecycleReceipt | null }> {
 try {
  const c = await omiShipContext(original, operationId, deps), r = c.op.shipRequest;
  lifecycleAssert(r?.kind === "omi" && ["deploy", "promote", "rollback"].includes(r.action) && sameData(r.destination, c.destination), "sin request OMI/destino fijado");
  if (c.op.status === "confirmed") return { state: "confirmed", receipt: c.op.receipt };
  let id = c.op.deployments?.[0]?.id;
  if (!id && c.op.queued?.length === 1) {
   const payload: unknown = await c.scope.client.observeMutation(c.op.queued[0]!.mutationId, c.scope.projectPath, c.signal);
   lifecycleAssert(payload && typeof payload === "object" && "id" in payload && typeof payload.id === "string" && "service" in payload && payload.service === r.destination.service && "environment" in payload && payload.environment === r.destination.environment && "to_version" in payload && payload.to_version === r.version, "resultado cola ajeno/incompleto"); id = payload.id;
  }
  lifecycleAssert(id, "sin deployment conocido: no adoptar último ni inferir desde semver");
  const response = await c.scope.client.request("GET", `${environmentPath(c.scope, c.service.name, c.provider.environment)}/deployments`, DeploymentsSchema, { signal: c.signal });
  lifecycleAssert(response.deployments.length <= 1000, "historial deployments truncado"); const matching = response.deployments.filter(d => d.id === id), d = matching[0];
  lifecycleAssert(matching.length === 1 && d && d.service === r.destination.service && d.environment === r.destination.environment && d.to_version === r.version && ["exitoso", "fallido"].includes(d.status), "deployment pendiente/ajeno/ambiguo");
  return { state: "confirmed", receipt: { operationId: c.op.id, correlationId: c.op.correlationId, subjectId: c.op.subjectId, targetId: c.op.targetId, externalId: d.id, verifiedSubjectId: c.op.subjectId, outcome: d.status === "exitoso" ? "succeeded" : "failed", at: new Date().toISOString() } };
 } catch { return { state: "unknown", receipt: null }; }
}
