// Recuperación es un contrato distinto de entrega. No contiene ejecutores ni secretos.
import { Type, type Static } from "typebox";
import { OmiDestinationSchema } from "./omi-ship-schema.ts";
import { ShipProbesSchema, ShipWorkflowSchema } from "./ship-schema.ts";
const closed = { additionalProperties: false } as const, text = (max = 256) => Type.String({ minLength: 1, maxLength: max });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const base = { id: text(), beforeOperationId: text(), subjectId: text(), targetId: text(100), configHash: hash, integratedSha: sha, previousVersion: text(100), probes: ShipProbesSchema, at: text(100) };
export const RecoveryBaselineSchema = Type.Union([
 Type.Object({ ...base, kind: Type.Literal("omi"), destination: OmiDestinationSchema, previousCommitSha: Type.Union([sha, Type.Null()]), previousDeploymentId: text() }, closed),
 Type.Object({ ...base, kind: Type.Literal("gha"), previousCommitSha: sha, deploymentId: text(), evidenceHash: hash }, closed),
]);
export type RecoveryBaseline = Static<typeof RecoveryBaselineSchema>;
export const GhaRollbackRequestSchema = Type.Object({ kind: Type.Literal("gha-rollback"), operationId: text(), baselineId: text(), failureDeliveryId: text(), repo: text(200), pr: Type.Integer({ minimum: 1 }), subjectId: text(), targetId: text(100), configHash: hash, integratedSha: sha, previousVersion: text(100), previousCommitSha: sha, correlationId: text(128), workflow: ShipWorkflowSchema }, closed);
export type GhaRollbackRequest = Static<typeof GhaRollbackRequestSchema>;
const proofBase = { subjectId: text(), targetId: text(100), operationId: text(), baselineId: text(), failureDeliveryId: text(), configHash: hash, integratedSha: sha, previousVersion: text(100), probes: ShipProbesSchema };
export const RecoveryProofSchema = Type.Union([
 Type.Object({ ...proofBase, kind: Type.Literal("omi-rollback"), destination: OmiDestinationSchema, previousCommitSha: Type.Union([sha, Type.Null()]), deploymentId: text() }, closed),
 Type.Object({ ...proofBase, kind: Type.Literal("gha-rollback"), repo: text(200), previousCommitSha: sha, workflowSha: sha, runId: Type.Integer({ minimum: 1 }), runAttempt: Type.Integer({ minimum: 1 }), correlationId: text(128), artifactHash: hash }, closed),
]);
export const RecoveryResultSchema = Type.Object({ state: Type.Enum(["recovered", "failed", "unknown"]), proof: Type.Union([RecoveryProofSchema, Type.Null()]), reason: text(4000) }, closed);
export type RecoveryResult = Static<typeof RecoveryResultSchema>;
export const RecoveryObservationSchema = Type.Object({ id: text(), operationId: text(), subjectId: text(), targetId: text(100), configHash: hash, failureDeliveryId: text(), result: RecoveryResultSchema, at: text(100) }, closed);
