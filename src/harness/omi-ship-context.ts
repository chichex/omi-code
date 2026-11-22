// Contexto de operación OMI acotado al vínculo/servicio/ambiente aceptados. No expone variables/secretos.
import { Value } from "typebox/value";
import { parseWorkflow } from "./model.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash } from "./lifecycle-value.ts";
import { openScope, linkedService, readService, environmentOf, type Scope } from "../tools/scope.ts";
import type { ToolRuntime } from "../tools/types.ts";
import { OmiDestinationSchema, OmiRequestSchema, type OmiRequest } from "./omi-ship-schema.ts";
import type { PublicationInputSchema } from "./omi-ship-schema.ts";
import type { Static } from "typebox";
import type { updateWorkflow } from "./store.ts";
import type { WorkflowV2 } from "./model.ts";
export interface OmiShipDeps {
 runtime: ToolRuntime; version: string; signal: AbortSignal; timeoutSeconds: number; now: () => number; fetch?: typeof fetch; scope?: Scope;
 beforeMutation: (request: OmiRequest) => Promise<void>; recordRequest?: (request: OmiRequest) => Promise<void>; recordDeployment?: (deployment: { id: string; service: string; environment: "stage" | "prod"; version: string }) => Promise<void>; recordQueued?: (receipt: { mutationId: string; state: string }) => Promise<void>;
 publication?: Static<typeof PublicationInputSchema>; attestation?: unknown;
 fixedCheckout?: (commit: string, signal: AbortSignal) => Promise<{ root: string; commitSha: string; release: () => Promise<void> }>;
 workflowStore?: { checkout: WorkflowV2["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow };
}
export async function omiShipContext(original: unknown, operationId: string, deps: OmiShipDeps) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted", "falta PR/lifecycle adoptado");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), sub = s.subjects.find(x => x.id === op?.subjectId), pin = s.pins.find(p => p.accepted.blockHash === op?.configHash), target = pin?.accepted.block.ship.targets.find(t => t.id === op?.targetId);
 lifecycleAssert(op && sub?.mergedSha && target?.provider.kind === "omi", "operación/servicio OMI/merge no comprobados"); const integratedSha = sub.mergedSha;
 const signal = AbortSignal.any([deps.signal, ...(deps.runtime.signal ? [deps.runtime.signal] : []), AbortSignal.timeout(Math.min(target.timeoutSeconds, deps.timeoutSeconds) * 1000)]); signal.throwIfAborted();
 const scope = deps.scope ?? await openScope({ ...deps.runtime, signal }); const service = linkedService(scope.link, target.provider.service);
 const api = new URL(scope.client.apiUrl); lifecycleAssert(!api.username && !api.password && !api.search && !api.hash, "API OMI con credenciales/URL no admitidas");
 const destination = { apiOrigin: api.origin, organization: scope.link.organizationSlug, project: scope.link.projectSlug, projectPath: scope.projectPath, service: service.name, environment: target.provider.environment, linkHash: dataHash(scope.link) };
 lifecycleAssert(Value.Check(OmiDestinationSchema, destination), "destino OMI no identificado");
 const view = await readService(scope, service.name, signal); lifecycleAssert(view.name === service.name && view.versions.length <= 1000 && view.environments.length <= 20, "service/censo de versiones incompleto o ajeno");
 const environment = environmentOf(view, target.provider.environment);
 return { state, s, op, sub, integratedSha, target, provider: target.provider, scope, service, destination, view, environment, signal };
}
export type OmiShipContext = Awaited<ReturnType<typeof omiShipContext>>;
export function omiRequest(c: OmiShipContext, action: OmiRequest["action"], version: string): OmiRequest {
 const request = { kind: "omi", action, repo: c.s.root.repo, subjectId: c.sub.id, targetId: c.target.id, integratedSha: c.integratedSha, configHash: c.op.configHash, correlationId: c.op.correlationId, idempotencyKey: c.op.correlationId, version, destination: c.destination };
 lifecycleAssert(Value.Check(OmiRequestSchema, request), "request OMI inválido"); return request;
}
