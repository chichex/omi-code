// Adquisición exclusiva del derecho a una llamada Review; existente/crash sólo admite observación.
import { Value } from "typebox/value";
import type { Workflow } from "./model.ts";
import { readWorkflow, updateWorkflow } from "./store.ts";
import { ReviewInvocationSchema } from "./lifecycle-state-schema.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
export interface ReviewClaimStore { checkout: Workflow["checkout"]; issue: number; operationId: string; persist?: typeof updateWorkflow }
export async function claimReviewRequest(store: ReviewClaimStore, input: unknown): Promise<void> {
 lifecycleAssert(Value.Check(ReviewInvocationSchema, input), "request de review inválido"); const request = structuredClone(input);
 const current = await readWorkflow(store.checkout, store.issue);
 lifecycleAssert(current?.lifecycle.status === "enabled" && current.status === "active", "trabajo no activo para registrar request");
 lifecycleAssert(!current.lifecycle.operations.find(o => o.id === store.operationId)?.providerRequest, "request ya reservado/fijado; sólo observar, nunca redispatch");
 await (store.persist ?? updateWorkflow)(store.checkout, store.issue, current.revision, saved => {
  lifecycleAssert(saved?.version === 2 && saved.status === "active" && saved.lifecycle.status === "enabled", "trabajo cambió antes de registrar request");
  const index = saved.lifecycle.operations.findIndex(o => o.id === store.operationId), op = saved.lifecycle.operations[index];
  lifecycleAssert(op?.kind === "review" && op.status === "pending" && !op.providerRequest && op.configHash === saved.lifecycle.pinHash && saved.lifecycle.stage === "review" && op.subjectId === saved.lifecycle.currentSubject, "falta operación review pending vigente");
  saved.lifecycle.operations[index] = { ...op, providerRequest: request }; return { ...saved, revision: saved.revision + 1 };
 });
}
