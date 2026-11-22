// Contexto acotado por operación/destino/SHA integrado, compartido por los adaptadores GHA.
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow, type WorkflowV2 } from "./model.ts";
import type { updateWorkflow } from "./store.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { GhaShipRequestSchema, ShipWorkflowSchema, ShipProbesSchema, type GhaShipRequest, type ShipProbes } from "./ship-schema.ts";
export interface GhaShipDeps {
 runner?: Runner; timeoutSeconds: number; signal: AbortSignal; now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<void>;
 workflow: (signal: AbortSignal, refresh?: boolean) => Promise<unknown>; listReleases: (signal: AbortSignal) => Promise<unknown>; listRuns: (signal: AbortSignal) => Promise<unknown>;
 resolveTag: (tag: string, signal: AbortSignal) => Promise<string>; containsCommit: (ancestor: string, descendant: string, signal: AbortSignal) => Promise<boolean>;
 downloadAsset: (id: number, signal: AbortSignal) => Promise<Buffer | { sha256: string; size: number }>; loadReceipt: (run: unknown, request: GhaShipRequest, signal: AbortSignal) => Promise<unknown>;
 beforeDispatch?: (request: GhaShipRequest) => Promise<void>; recordRequest?: (request: GhaShipRequest) => Promise<void>;
 verifyProbes?: (expected: { targetId: string; integratedSha: string; deployedSha: string; version: string | null }, signal: AbortSignal) => Promise<unknown>;
 notApplicable?: unknown; loadReleasePlan?: (run: unknown, request: GhaShipRequest, signal: AbortSignal) => Promise<unknown>;
 workflowStore?: { checkout: WorkflowV2["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow };
}
export function shipContext(original: unknown, operationId: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted", "falta lifecycle/PR adoptado");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), subject = s.subjects.find(x => x.id === op?.subjectId), pin = s.pins.find(p => p.accepted.blockHash === op?.configHash);
 const config = pin?.accepted.block, target = config?.ship.targets.find(t => t.id === op?.targetId);
 lifecycleAssert(op?.kind === "ship" && subject?.mergedSha && config?.ship.status === "configured" && target && target.provider.kind === "gha", "operación/destino GHA o merge integrado no comprobados");
 const integratedSha = subject.mergedSha; lifecycleAssert(integratedSha, "falta SHA integrado");
 return { state, s, op, subject, integratedSha, config, target };
}
export type GhaShipContext = ReturnType<typeof shipContext>;
export async function ghaShipRequest(c: GhaShipContext, deps: GhaShipDeps, signal: AbortSignal): Promise<GhaShipRequest> {
 if (c.op.shipRequest) { lifecycleAssert(Value.Check(GhaShipRequestSchema, c.op.shipRequest), "request Ship futuro/ajeno"); return structuredClone(c.op.shipRequest); }
 const workflow = await deps.workflow(signal); lifecycleAssert(Value.Check(ShipWorkflowSchema, workflow) && c.target.provider.kind === "gha" && workflow.path === `.github/workflows/${c.target.provider.workflow.replace(/^\.github\/workflows\//, "")}` && workflow.ref === c.target.provider.ref, "workflow/ref Ship no confiables");
 const request = { kind: c.target.evidence.kind === "github-release" ? "gha-release" : "gha-receipt", repo: c.s.root.repo, pr: c.subject.number, subjectId: c.subject.id, targetId: c.target.id, integratedSha: c.integratedSha, configHash: c.op.configHash, correlationId: c.op.correlationId, mode: c.target.provider.mode, workflow };
 lifecycleAssert(Value.Check(GhaShipRequestSchema, request), "request Ship inválido/incompleto"); return request;
}
export function shipProofBase(c: GhaShipContext, probes: ShipProbes) { return { subjectId: c.subject.id, targetId: c.target.id, operationId: c.op.id, configHash: c.op.configHash, integratedSha: c.integratedSha, probes }; }
export async function shipProbes(c: GhaShipContext, deps: GhaShipDeps, deployedSha: string, version: string | null, signal: AbortSignal): Promise<ShipProbes> {
 const expected = c.target.evidence;
 if (!expected.health && !expected.version) return { health: "not-configured", version: "not-configured" };
 lifecycleAssert(deps.verifyProbes, "destino de probes no identificado: setup/humano");
 const probes = await deps.verifyProbes({ targetId: c.target.id, integratedSha: c.integratedSha, deployedSha, version }, signal);
 lifecycleAssert(Value.Check(ShipProbesSchema, probes), "health/version incompletos");
 return { health: expected.health ? probes.health === "not-configured" ? "unknown" : probes.health : "not-configured", version: expected.version ? probes.version === "not-configured" ? "unknown" : probes.version : "not-configured" };
}
export function shipScope(deps: GhaShipDeps, targetTimeout: number) {
 lifecycleAssert(Number.isInteger(deps.timeoutSeconds) && deps.timeoutSeconds >= 60 && deps.timeoutSeconds <= 7200, "timeout Ship inválido");
 const controller = new AbortController(), duration = Math.min(deps.timeoutSeconds, targetTimeout) * 1000, start = deps.now(); lifecycleAssert(Number.isFinite(start), "reloj Ship inválido"); const deadline = start + duration;
 const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(duration)]);
 return { signal, check() { if (deps.now() >= deadline) controller.abort(); signal.throwIfAborted(); }, close() { controller.abort(); } };
}
