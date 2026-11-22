// Recibo/claim local host: no es aprobación GitHub ni un lente asesor de Verificar.
import { Type, type Static } from "typebox";
import { ReviewFindingSchema } from "./gha-review-contract.ts";
const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 256 });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const LocalReviewModelSchema = Type.Object({ provider: text, id: text, contextWindow: Type.Integer({ minimum: 1 }) });
export const LocalReviewRequestSchema = Type.Object({ provider: Type.Literal("local"), repo: Type.String({ maxLength: 200, pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$" }), pr: Type.Integer({ minimum: 1 }), headSha: sha, baseSha: sha, diffBaseSha: sha, contentHash: hash, materialHash: hash,
 correlationId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$", maxLength: 128 }), fileCount: Type.Integer({ minimum: 0, maximum: 1000 }), model: Type.Object({ provider: text, id: text }, closed) }, closed);
export type LocalReviewRequest = Static<typeof LocalReviewRequestSchema>;
export const ReviewUsageSchema = Type.Object({ input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }), cacheRead: Type.Integer({ minimum: 0 }), cacheWrite: Type.Integer({ minimum: 0 }), totalTokens: Type.Integer({ minimum: 1 }) });
export type ReviewUsage = Static<typeof ReviewUsageSchema>;
export const LocalReviewReceiptSchema = Type.Object({ version: Type.Literal(1), ...LocalReviewRequestSchema.properties, state: Type.Enum(["complete", "incomplete"]), verdict: Type.Enum(["pass", "findings", "unknown"]),
 findings: Type.Array(ReviewFindingSchema, { maxItems: 1000 }), usage: ReviewUsageSchema }, closed);
export type LocalReviewReceipt = Static<typeof LocalReviewReceiptSchema>;
export const LocalReviewSnapshotSchema = Type.Object({ repo: text, pr: Type.Integer({ minimum: 1 }), headSha: sha, baseSha: sha, contentHash: hash, clean: Type.Boolean() }, closed);
