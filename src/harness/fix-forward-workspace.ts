// Workspace de recuperación dentro del mismo agregado raíz: C/evidencia nuevos, identidad histórica intacta.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isAbsolute, resolve } from "node:path";
import { parseWorkflow, MAX_STEPS } from "./model.ts";
import { isApproved, recipeApprovalHash, successful } from "./state.ts";
import { recoveryCause } from "./recovery-state.ts";
import { RecoveryCheckoutSchema } from "./recovery-workspace-schema.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
const closed = { additionalProperties: false } as const;
const Proposal = Type.Object({ id: Type.String(), failureDeliveryId: Type.String(), checkout: RecoveryCheckoutSchema, base: Type.String(), baseSha: Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), clean: Type.Boolean(), containsMerge: Type.Boolean(), scope: Type.Object({ source: Type.Enum(["person", "policy"]), withinScope: Type.Boolean(), risk: Type.Enum(["low", "high"]), scopeHash: Type.String(), authorityHash: Type.Optional(Type.String()) }, closed), at: Type.String() }, closed);
export function prepareFixForwardWorkspace(original: unknown, operationId: string, proposal: unknown) {
 lifecycleAssert(Value.Check(Proposal, proposal), "workspace propuesta inválida"); const c = recoveryCause(original, proposal.failureDeliveryId, operationId), op = c.s.operations.find(o => o.id === operationId);
 lifecycleAssert(isApproved(c.state) && c.state.recipe && c.state.status === "active" && c.s.stage === "ship" && c.target.onFailure.action === "fix-forward" && op?.kind === "fix-forward" && op.status === "pending" && op.subjectId === c.sub.id && op.targetId === c.target.id && op.configHash === c.s.pinHash, "fix-forward sin reserva/receta/permiso vigentes");
 lifecycleAssert(proposal.scope.withinScope && proposal.scope.risk === "low" && proposal.scope.scopeHash === recipeApprovalHash(c.state) && (proposal.scope.source === "person" || proposal.scope.authorityHash), "nuevo alcance/riesgo sin aceptación");
 lifecycleAssert(proposal.clean && proposal.containsMerge && proposal.checkout.root !== c.state.checkout.root && proposal.checkout.baseCommit === proposal.baseSha && proposal.base === c.config.land.base && lifecycleRef(proposal.checkout.branch) && !["main", "master", "HEAD", proposal.base, c.state.checkout.branch].includes(proposal.checkout.branch), "workspace/Git/base/branch no comprobados");
 for (const path of [proposal.checkout.root, proposal.checkout.commonDir]) lifecycleAssert(isAbsolute(path) && resolve(path) === path && !path.includes("\0"), "workspace path inválido");
 lifecycleAssert(c.state.steps.length < MAX_STEPS && c.state.steps.every(s => s.status === "done") && !(c.s.recoveryWorkspaces ?? []).some(w => w.id === proposal.id || w.operationId === operationId || w.status !== "opened"), "workspace/C anterior pendiente o ID reutilizado");
 const stepId = `C${Math.max(0, ...c.state.steps.map(s => Number(/^C(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1}`;
 c.state.steps.push({ id: stepId, title: `Fix-forward del PR #${c.sub.number}: exige TDD nuevo`, cases: c.state.recipe.cases.map(c => c.id), status: "pending", red: null, green: null, commit: null });
 c.s.recoveryWorkspaces = [...(c.s.recoveryWorkspaces ?? []), { id: proposal.id, operationId, failureDeliveryId: c.d.id, sourceSubjectId: c.sub.id, targetId: c.target.id, configHash: op.configHash, checkout: proposal.checkout, base: proposal.base, baseSha: proposal.baseSha, scopeHash: proposal.scope.scopeHash, scopeSource: proposal.scope.source, ...(proposal.scope.authorityHash ? { authorityHash: proposal.scope.authorityHash } : {}), stepId, evidenceOffset: c.state.evidence.length, reviewOffset: c.state.reviews.length, at: proposal.at, status: "coding", head: null, fingerprint: null, pushOperationId: null, pullRequest: null }];
 c.s.activeRecoveryId = proposal.id; c.state.phase = "implement"; c.state.revision++; c.state.activity = "Fix-forward en checkout nuevo; PR mergeado y presupuesto raíz intactos"; return parseWorkflow(JSON.stringify(c.state));
}
const Snapshot = Type.Object({ head: Type.String(), fingerprint: Type.String(), clean: Type.Boolean(), ancestor: Type.Boolean() }, closed);
export function verifyFixForwardWorkspace(original: unknown, workspaceId: string, observed: unknown, _at: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no habilitado"); const s = state.lifecycle, w = s.recoveryWorkspaces?.find(w => w.id === workspaceId), op = s.operations.find(o => o.id === w?.operationId);
 lifecycleAssert(w?.status === "coding" && s.activeRecoveryId === w.id && op?.status === "pending" && op.configHash === s.pinHash && isApproved(state) && w.scopeHash === recipeApprovalHash(state) && state.phase === "pr" && Value.Check(Snapshot, observed) && observed.clean && observed.ancestor && observed.head !== w.baseSha, "falta verificar código nuevo/ancestría de recuperación");
 const step = state.steps.find(c => c.id === w.stepId), fresh = state.evidence.slice(w.evidenceOffset);
 lifecycleAssert(step?.status === "done" && step.commit === observed.head && fresh.some(e => e.id === step.red && e.kind === "red" && e.exitCode !== 0) && fresh.some(e => e.id === step.green && e.kind === "green" && successful(e)), "TDD rojo/verde/commit propios de la C de recuperación");
 lifecycleAssert(state.recipe?.cases.every(c => { const e = fresh.findLast(e => e.kind === "verification" && e.caseId === c.id); return e && successful(e) && e.command === c.command && e.head === observed.head && e.fingerprint === observed.fingerprint; }), "faltan D nuevos de recuperación");
 w.status = "verified"; w.head = observed.head; w.fingerprint = observed.fingerprint; state.phase = "ship"; state.revision++; state.activity = "Fix-forward verificado; faltan permisos de push y PR independientes"; return parseWorkflow(JSON.stringify(state));
}
