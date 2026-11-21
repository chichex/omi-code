// Contrato cerrado de las perillas post-PR. Sin I/O, permisos, proveedores ejecutables ni scripts.
import { Type, type Static } from "typebox";

const closed = { additionalProperties: false } as const;
const text = (maxLength = 256) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const Mode = Type.Union([Type.Literal("ask"), Type.Literal("auto")]);
const Timeout = Type.Integer({ minimum: 60, maximum: 7200 });
const Count = Type.Integer({ minimum: 0, maximum: 10 });
const Ref = text();
const WorkflowFile = Type.String({ maxLength: 256, pattern: "^(?:\\.github/workflows/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\\.ya?ml$" });
const WorkflowIdentity = { workflow: WorkflowFile, ref: Ref };
const ReviewProvider = Type.Union([
 Type.Object({ kind: Type.Literal("local") }, closed),
 Type.Object({ kind: Type.Literal("github"), reviewers: Type.Array(Type.String({ maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9-]*(?:\\[bot\\])?$" }), { minItems: 1, maxItems: 1000, uniqueItems: true }) }, closed),
 Type.Object({ kind: Type.Literal("gha"), ...WorkflowIdentity, contract: Type.Literal("omi-review-v1") }, closed),
]);
const Endpoint = Type.String({ minLength: 1, maxLength: 1024, pattern: "^/(?!/)[A-Za-z0-9_./~-]*$" });
const JsonField = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$" });
const Health = Type.Object({ path: Endpoint, status: Type.Integer({ minimum: 100, maximum: 599 }) }, closed);
const Version = Type.Object({ path: Endpoint, versionField: JsonField, commitField: Type.Optional(JsonField) }, closed);
const Probes = { health: Type.Optional(Health), version: Type.Optional(Version) };
const ReceiptEvidence = Type.Object({ kind: Type.Literal("receipt"), ...Probes }, closed);
const ReleaseEvidence = Type.Object({
 kind: Type.Literal("github-release"), tag: Type.Optional(Ref),
 assets: Type.Array(text(), { minItems: 1, maxItems: 1000, uniqueItems: true }), checksumsAsset: text(), ...Probes,
}, closed);
const OmiEvidence = Type.Union([
 Type.Object({ kind: Type.Literal("omi"), ...Probes, health: Health, provenance: Type.Optional(Type.Literal("publication-receipt")) }, closed),
 Type.Object({ kind: Type.Literal("omi"), ...Probes, version: Version, provenance: Type.Optional(Type.Literal("publication-receipt")) }, closed),
 Type.Object({ kind: Type.Literal("omi"), ...Probes, provenance: Type.Literal("publication-receipt") }, closed),
]);
const GhaFields = {
 kind: Type.Literal("gha"), ...WorkflowIdentity,
 mode: Type.Union([Type.Literal("observe"), Type.Literal("dispatch")]),
 rollback: Type.Optional(Type.Object({ ...WorkflowIdentity, contract: Type.Literal("omi-ship-v1") }, closed)),
};
const GhaReceipt = Type.Object({ ...GhaFields, contract: Type.Literal("omi-ship-v1") }, closed);
const GhaRelease = Type.Object({ ...GhaFields, contract: Type.Literal("github-release") }, closed);
const OmiProvider = Type.Object({
 kind: Type.Literal("omi"), service: Type.String({ maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" }),
 environment: Type.Union([Type.Literal("stage"), Type.Literal("prod")]),
 mode: Type.Union([Type.Literal("observe"), Type.Literal("tag"), Type.Literal("direct")]),
}, closed);
const TargetFields = {
 id: Type.String({ maxLength: 100, pattern: "^[a-z0-9][a-z0-9_.-]*$" }), mode: Mode, timeoutSeconds: Timeout, maxRetries: Count,
 onFailure: Type.Object({ action: Type.Union([Type.Literal("stop"), Type.Literal("rollback"), Type.Literal("fix-forward")]), mode: Mode }, closed),
};
// Correlación provider/evidence también en el tipo, no sólo una bolsa con opcionales.
export const LifecycleTargetSchema = Type.Union([
 Type.Object({ ...TargetFields, provider: GhaRelease, evidence: ReleaseEvidence }, closed),
 Type.Object({ ...TargetFields, provider: GhaReceipt, evidence: ReceiptEvidence }, closed),
 Type.Object({ ...TargetFields, provider: OmiProvider, evidence: OmiEvidence }, closed),
]);
export type LifecycleTarget = Static<typeof LifecycleTargetSchema>;
const Ship = Type.Union([
 Type.Object({ status: Type.Literal("configured"), targets: Type.Array(LifecycleTargetSchema, { minItems: 1, maxItems: 20 }) }, closed),
 Type.Object({ status: Type.Union([Type.Literal("unconfigured"), Type.Literal("manual"), Type.Literal("not-applicable")]), targets: Type.Array(LifecycleTargetSchema, { maxItems: 0 }) }, closed),
]);
export const LifecycleConfigSchema = Type.Object({
 version: Type.Literal(1), repo: Type.String({ maxLength: 200, pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$" }),
 review: Type.Object({ mode: Mode, provider: ReviewProvider, timeoutSeconds: Timeout }, closed),
 corrections: Type.Object({ mode: Mode, maxRounds: Count }, closed),
 land: Type.Object({
  mode: Mode, base: Ref, method: Type.Union([Type.Literal("squash"), Type.Literal("merge"), Type.Literal("rebase")]),
  maxRisk: Type.Union([Type.Literal("low"), Type.Literal("high")]),
  requiredChecks: Type.Array(Type.Object({ context: text(1000), appId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, closed), { maxItems: 1000 }),
 }, closed),
 ship: Ship,
 budget: Type.Object({ maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }), maxFixForwardPRs: Type.Integer({ minimum: 0, maximum: 5 }), activeSeconds: Type.Integer({ minimum: 60, maximum: 86400 }) }, closed),
}, closed);
export type LifecycleConfig = Static<typeof LifecycleConfigSchema>;
