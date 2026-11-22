// Checkout/PR de recuperación adjuntos a la misma raíz: nunca otro contador/lifecycle autónomo.
import { Type, type Static } from "typebox";
const closed = { additionalProperties: false } as const, text = (max = 256) => Type.String({ minLength: 1, maxLength: max });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const RecoveryCheckoutSchema = Type.Object({ root: text(8192), commonDir: text(8192), branch: text(128), baseCommit: sha }, closed);
export const RecoveryPullSchema = Type.Object({ number: Type.Integer({ minimum: 1 }), url: text(2048), head: sha, branch: text(128), base: text(128), ownership: Type.Literal("adopted") }, closed);
export const RecoveryWorkspaceSchema = Type.Object({
 id: text(), operationId: text(), failureDeliveryId: text(), sourceSubjectId: text(), targetId: text(100), configHash: hash,
 checkout: RecoveryCheckoutSchema, base: text(128), baseSha: sha, scopeHash: hash, scopeSource: Type.Enum(["person", "policy"]), authorityHash: Type.Optional(hash),
 stepId: text(32), evidenceOffset: Type.Integer({ minimum: 0 }), reviewOffset: Type.Integer({ minimum: 0 }), at: text(100),
 status: Type.Enum(["coding", "verified", "pushed", "opened"]), head: Type.Union([sha, Type.Null()]), fingerprint: Type.Union([hash, Type.Null()]),
 pushOperationId: Type.Union([text(), Type.Null()]), pullRequest: Type.Union([RecoveryPullSchema, Type.Null()]),
}, closed);
export type RecoveryWorkspace = Static<typeof RecoveryWorkspaceSchema>;
export const FixForwardRequestSchema = Type.Object({ kind: Type.Literal("fix-forward"), rootWorkflowId: text(100), workspaceId: text(), operationId: text(), failureDeliveryId: text(), sourceSubjectId: text(), targetId: text(100), configHash: hash,
 repo: text(200), sourcePr: Type.Integer({ minimum: 1 }), integratedSha: sha, branch: text(128), base: text(128), baseSha: sha, head: sha, fingerprint: hash, body: text(65536), bodyHash: hash, title: text(2000), correlationId: text(128),
}, closed);
export type FixForwardRequest = Static<typeof FixForwardRequestSchema>;
export const FixForwardPushSchema = Type.Object({ kind: Type.Literal("fix-forward-push"), workspaceId: text(), fixForwardOperationId: text(), repo: text(200), branch: text(128), base: text(128), baseSha: sha, head: sha, fingerprint: hash, correlationId: text(128) }, closed);
export type FixForwardPush = Static<typeof FixForwardPushSchema>;
