// Evidencia y operaciones Ship declarativas. Nunca contienen comandos, credenciales ni éxito por ausencia.
import { Type, type Static } from "typebox";
const closed = { additionalProperties: false } as const;
const text = (maxLength = 256) => Type.String({ minLength: 1, maxLength });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const ShipWorkflowSchema = Type.Object({ id, path: Type.String({ pattern: "^\\.github/workflows/[A-Za-z0-9_][A-Za-z0-9_.-]*\\.ya?ml$", maxLength: 256 }), ref: text(), sha }, closed);
export const GhaShipRequestSchema = Type.Object({ kind: Type.Enum(["gha-release", "gha-receipt"]), repo: Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 200 }), pr: id, subjectId: text(), targetId: text(100), integratedSha: sha, configHash: hash, correlationId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$", maxLength: 128 }), mode: Type.Enum(["observe", "dispatch"]), workflow: ShipWorkflowSchema }, closed);
export type GhaShipRequest = Static<typeof GhaShipRequestSchema>;
export const ShipProbesSchema = Type.Object({ health: Type.Enum(["pass", "fail", "unknown", "not-configured"]), version: Type.Enum(["pass", "fail", "unknown", "not-configured"]) }, closed);
export type ShipProbes = Static<typeof ShipProbesSchema>;
const proof = { subjectId: text(), targetId: text(100), operationId: text(), configHash: hash, integratedSha: sha, probes: ShipProbesSchema };
const Asset = Type.Object({ id, name: text(256), size: Type.Integer({ minimum: 0 }), sha256: hash }, closed);
export const ReleaseShipProofSchema = Type.Object({ ...proof, kind: Type.Literal("github-release"), repo: text(200), releaseId: id, tag: text(), commitSha: sha, runId: id, runAttempt: id, checksumsId: id, assets: Type.Array(Asset, { minItems: 1, maxItems: 1000 }) }, closed);
export const ReceiptShipProofSchema = Type.Object({ ...proof, kind: Type.Literal("gha-receipt"), repo: text(200), workflowSha: sha, runId: id, runAttempt: id, correlationId: text(), providerCorrelationId: text(), sourceSha: sha, deployedSha: sha, versionTag: Type.Union([text(), Type.Null()]), deploymentId: text(), artifactHash: hash }, closed);
export const NotApplicableShipProofSchema = Type.Object({ ...proof, kind: Type.Literal("not-applicable"), source: Type.Enum(["person", "plan"]), reason: text(4000), evidenceHash: hash }, closed);
export const ShipProofSchema = Type.Union([ReleaseShipProofSchema, ReceiptShipProofSchema, NotApplicableShipProofSchema]);
export type ShipProof = Static<typeof ShipProofSchema>;
export const ShipVerificationSchema = Type.Object({ state: Type.Enum(["verified", "not-applicable", "failed", "unknown"]), proof: Type.Union([ShipProofSchema, Type.Null()]), reason: Type.String({ maxLength: 4000 }) }, closed);
export type ShipVerification = Static<typeof ShipVerificationSchema>;
export const GhaShipReceiptSchema = Type.Object({ version: Type.Literal(1), contract: Type.Literal("omi-ship-v1"), repo: text(200), pr: id, targetId: text(100), integratedSha: sha, deployedSha: sha, workflowSha: sha, correlationId: text(), runId: id, runAttempt: id,
 state: Type.Enum(["delivered", "failed", "not-applicable", "incomplete"]), versionTag: Type.Union([text(), Type.Null()]), deploymentId: text() }, closed);
export const ReleaseAssetSchema = Type.Object({ id, name: text(256), size: Type.Integer({ minimum: 0, maximum: 1024 * 1024 * 1024 }), state: Type.Literal("uploaded"), digest: Type.Optional(Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()])) });
export const GitHubReleaseSchema = Type.Object({ id, tag_name: text(), draft: Type.Boolean(), prerelease: Type.Boolean(), published_at: text(100), assets: Type.Array(ReleaseAssetSchema, { maxItems: 1000 }) });
export const NotApplicableChoiceSchema = Type.Object({ source: Type.Literal("person"), subjectId: text(), targetId: text(100), integratedSha: sha, reason: text(4000), at: text(100) }, closed);
export const ManualShipSchema = Type.Object({ source: Type.Literal("person"), subjectId: text(), integratedSha: sha, configHash: hash, reason: text(4000), at: text(100) }, closed);
const completion = { subjectId: text(), configHash: hash, integratedSha: sha, evidenceIds: Type.Array(text(), { maxItems: 20 }), at: text(100) };
export const ShipCompletionSchema = Type.Union([
 Type.Object({ ...completion, outcome: Type.Enum(["verified", "not-applicable"]) }, closed),
 Type.Object({ ...completion, outcome: Type.Literal("manual-attested"), attestation: ManualShipSchema }, closed),
]);
export const ShipDeliverySchema = Type.Object({ id: text(), subjectId: text(), targetId: text(100), operationId: text(), configHash: hash, result: ShipVerificationSchema, at: text(100) }, closed);
