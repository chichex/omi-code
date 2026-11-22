// Rondas de código post-PR y solicitud push fija. Datos host, nunca comandos o aprobaciones del modelo.
import { Type, type Static } from "typebox";
const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 256 });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const CorrectionProposalSchema = Type.Object({ operationId: text, findingIds: Type.Array(text, { minItems: 1, maxItems: 1000, uniqueItems: true }),
 scope: Type.Object({ source: Type.Enum(["person", "policy"]), scopeHash: hash, withinScope: Type.Boolean(), risk: Type.Enum(["low", "high", "unknown"]), authorityHash: Type.Optional(hash) }, closed), at: text }, closed);
const fields = { operationId: text, subjectId: text, findings: Type.Array(Type.Object({ id: text, hash, sequence: Type.Integer({ minimum: 1 }), dispositionSequence: Type.Integer({ minimum: 1 }) }, closed), { minItems: 1, maxItems: 1000 }),
 startHead: sha, startFingerprint: hash, scopeHash: hash, scopeSource: Type.Enum(["person", "policy"]), authorityHash: Type.Optional(hash), evidenceOffset: Type.Integer({ minimum: 0, maximum: 1000 }), reviewOffset: Type.Integer({ minimum: 0, maximum: 100 }), at: text };
const verified = { stepId: text, newSubjectId: text, head: sha, fingerprint: hash };
export const CorrectionRoundSchema = Type.Union([
 Type.Object({ ...fields, status: Type.Literal("planned") }, closed),
 Type.Object({ ...fields, stepId: text, status: Type.Literal("coding") }, closed),
 Type.Object({ ...fields, stepId: text, status: Type.Literal("failed"), failedHead: sha, failedFingerprint: hash, reason: text }, closed),
 Type.Object({ ...fields, ...verified, status: Type.Literal("verified") }, closed),
 Type.Object({ ...fields, ...verified, pushOperationId: text, status: Type.Literal("pushed") }, closed),
]);
export type CorrectionRound = Static<typeof CorrectionRoundSchema>;
export const CorrectionPushRequestSchema = Type.Object({ repo: text, pr: Type.Integer({ minimum: 1 }), branch: text, base: text, beforeHead: sha, head: sha, fingerprint: hash, correctionId: text, correlationId: text }, closed);
export type CorrectionPushRequest = Static<typeof CorrectionPushRequestSchema>;
