// Agregado durable post-PR. Todo dato externo se valida; no contiene comandos ni capacidades ejecutables.
import { Type, type Static } from "typebox";
import { LifecycleConfigSchema } from "./lifecycle-schema.ts";
import { GhaReviewRequestSchema } from "./gha-review-contract.ts";
import { LocalReviewRequestSchema } from "./local-review-schema.ts";
import { CorrectionRoundSchema, CorrectionPushRequestSchema } from "./correction-schema.ts";
import { ReadyLandSchema, LandRequestSchema, MergeFactSchema, DraftReadyRequestSchema } from "./land-schema.ts";
export const ReviewInvocationSchema = Type.Union([GhaReviewRequestSchema, LocalReviewRequestSchema]);
const closed = { additionalProperties: false } as const;
export const boundedText = (maxLength = 256) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const nullableText = () => Type.Union([boundedText(), Type.Null()]);
const Sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const OperationKindSchema = Type.Enum(["review", "correction", "push", "ready", "land", "ship", "publish", "deploy", "promote", "rollback", "fix-forward"]);
export type OperationKind = Static<typeof OperationKindSchema>;
export const LifecycleRootSchema = Type.Object({ workflowId: boundedText(100), issue: Type.Integer({ minimum: 1 }), repo: boundedText(200) }, closed);
export const LifecyclePinSchema = Type.Object({
 key: Type.Object({ kbUrl: boundedText(2000), product: boundedText(200), repo: boundedText(200) }, closed),
 accepted: Type.Object({ docId: boundedText(200), blockHash: Hash, block: LifecycleConfigSchema, author: Type.String({ maxLength: 400 }), date: Type.String({ maxLength: 100 }), acceptedAt: boundedText(100) }, closed),
}, closed);
export type LifecyclePin = Static<typeof LifecyclePinSchema>;
export const SubjectSchema = Type.Object({ id: boundedText(), repo: boundedText(200), number: Type.Integer({ minimum: 1 }), branch: boundedText(128), base: boundedText(128), headSha: Sha, baseSha: Sha, contentHash: Hash, mergedSha: Type.Union([Sha, Type.Null()]) }, closed);
export const AdoptionSchema = Type.Object({ id: boundedText(), source: Type.Enum(["person", "publication", "correction", "merge"]), at: boundedText(100) }, closed);
const AdoptedSubjectSchema = Type.Object({ ...SubjectSchema.properties, adoption: AdoptionSchema }, closed);
export const IntentSchema = Type.Object({ id: boundedText(), key: boundedText(), kind: OperationKindSchema, subjectId: boundedText(), targetId: nullableText(), correlationId: boundedText(), retryOf: nullableText() }, closed);
export type LifecycleIntent = Static<typeof IntentSchema>;
export const DecisionSchema = Type.Object({ id: boundedText(), kind: OperationKindSchema, subjectId: boundedText(), targetId: nullableText(), configHash: Hash, source: Type.Enum(["person", "policy"]), authorityHash: Type.Optional(Hash), effectHash: Type.Optional(Hash), at: boundedText(100) }, closed);
export type LifecycleDecision = Static<typeof DecisionSchema>;
export const ReceiptSchema = Type.Object({ operationId: boundedText(), correlationId: boundedText(), subjectId: boundedText(), targetId: nullableText(), externalId: boundedText(), outcome: Type.Enum(["succeeded", "failed", "not-applicable"]), verifiedSubjectId: nullableText(), at: boundedText(100) }, closed);
export type LifecycleReceipt = Static<typeof ReceiptSchema>;
const OperationFields = { ...IntentSchema.properties, configHash: Hash, decisionId: boundedText(), providerRequest: Type.Optional(ReviewInvocationSchema), pushRequest: Type.Optional(CorrectionPushRequestSchema), landRequest: Type.Optional(LandRequestSchema), readyRequest: Type.Optional(DraftReadyRequestSchema), history: Type.Array(Type.Object({ status: Type.Enum(["pending", "unknown", "confirmed"]), at: boundedText(100) }, closed), { minItems: 1, maxItems: 1000 }) };
const OperationSchema = Type.Union([
 Type.Object({ ...OperationFields, status: Type.Literal("pending") }, closed),
 Type.Object({ ...OperationFields, status: Type.Literal("unknown"), reason: boundedText(4000) }, closed),
 Type.Object({ ...OperationFields, status: Type.Literal("confirmed"), receipt: ReceiptSchema }, closed),
]);
export const EvidenceFactSchema = Type.Object({ id: boundedText(), subjectId: boundedText(), operationId: boundedText(), kind: Type.Enum(["verification", "refutation", "attestation"]), outcome: Type.Enum(["pass", "fail", "unknown"]), at: boundedText(100) }, closed);
export const FindingInputSchema = Type.Object({ id: boundedText(), provider: Type.Enum(["github", "gha", "local"]), externalId: boundedText(), operationId: boundedText(), subjectId: boundedText(), text: boundedText(4000), severity: Type.Enum(["low", "medium", "high", "critical", "unknown"]), resolved: Type.Boolean(), outdated: Type.Boolean(), at: boundedText(100) }, closed);
const { id: _id, ...ObservationFields } = FindingInputSchema.properties;
const ObservationSchema = Type.Object({ ...ObservationFields, hash: Hash, sequence: Type.Integer({ minimum: 1 }) }, closed);
const DispositionFields = { findingId: boundedText(), subjectId: boundedText(), observationHash: Hash, reason: boundedText(4000), at: boundedText(100) };
export const DispositionSchema = Type.Union([
 Type.Object({ ...DispositionFields, status: Type.Enum(["pending", "accepted", "human-required"]), evidenceIds: Type.Array(boundedText(), { maxItems: 0 }) }, closed),
 Type.Object({ ...DispositionFields, status: Type.Enum(["corrected", "refuted-with-evidence"]), evidenceIds: Type.Array(boundedText(), { minItems: 1, maxItems: 1000, uniqueItems: true }) }, closed),
]);
const StoredDispositionFields = { ...DispositionFields, observationSequence: Type.Integer({ minimum: 1 }) };
const StoredDispositionSchema = Type.Union([
 Type.Object({ ...StoredDispositionFields, status: Type.Enum(["pending", "accepted", "human-required"]), evidenceIds: Type.Array(boundedText(), { maxItems: 0 }) }, closed),
 Type.Object({ ...StoredDispositionFields, status: Type.Enum(["corrected", "refuted-with-evidence"]), evidenceIds: Type.Array(boundedText(), { minItems: 1, maxItems: 1000, uniqueItems: true }) }, closed),
]);
const FindingSchema = Type.Object({ id: boundedText(), key: boundedText(2000), observations: Type.Array(ObservationSchema, { minItems: 1, maxItems: 1000 }), dispositions: Type.Array(StoredDispositionSchema, { maxItems: 1000 }) }, closed);
const SegmentSchema = Type.Object({ id: boundedText(), owner: boundedText(), elapsedMilliseconds: Count, chargedMilliseconds: Count, mode: Type.Enum(["active", "human-wait", "closed"]) }, closed);
const CheckSchema = Type.Object({ id: boundedText(), subjectId: boundedText(), context: boundedText(1000), appId: Type.Integer({ minimum: 1 }), state: Type.Enum(["success", "failure", "pending", "unknown"]), externalId: boundedText(), at: boundedText(100) }, closed);
const ApprovalSchema = Type.Object({ id: boundedText(), subjectId: boundedText(), provider: Type.Enum(["github", "gha", "local"]), reviewer: boundedText(), state: Type.Enum(["approved", "changes-requested", "dismissed", "unknown"]), externalId: boundedText(), at: boundedText(100) }, closed);
export const EnabledLifecycleSchema = Type.Object({
 status: Type.Literal("enabled"), root: LifecycleRootSchema, pins: Type.Array(LifecyclePinSchema, { minItems: 1, maxItems: 1000 }), pinHash: Hash,
 stage: Type.Enum(["review", "corrections", "ready", "land", "ship", "paused", "delivered"]),
 corrections: Type.Optional(Type.Array(CorrectionRoundSchema, { maxItems: 10 })),
 ready: Type.Optional(ReadyLandSchema), readyHistory: Type.Optional(Type.Array(ReadyLandSchema, { maxItems: 100 })), merges: Type.Optional(Type.Array(MergeFactSchema, { maxItems: 10 })),
 currentSubject: nullableText(), subjects: Type.Array(AdoptedSubjectSchema, { maxItems: 1000 }),
 decisions: Type.Array(DecisionSchema, { maxItems: 100 }), operations: Type.Array(OperationSchema, { maxItems: 100 }),
 budget: Type.Object({ attemptsUsed: Count, fixForwardPRsUsed: Count, roundsUsed: Count, activeMilliseconds: Count }, closed),
 segments: Type.Array(SegmentSchema, { maxItems: 1000 }), ledger: Type.Array(FindingSchema, { maxItems: 1000 }), evidence: Type.Array(EvidenceFactSchema, { maxItems: 1000 }),
 checks: Type.Array(CheckSchema, { maxItems: 1000 }), approvals: Type.Array(ApprovalSchema, { maxItems: 1000 }),
}, closed);
export const LifecycleStateSchema = Type.Union([Type.Object({ status: Type.Literal("disabled") }, closed), EnabledLifecycleSchema]);
export type LifecycleState = Static<typeof LifecycleStateSchema>;
export type EnabledLifecycle = Static<typeof EnabledLifecycleSchema>;
