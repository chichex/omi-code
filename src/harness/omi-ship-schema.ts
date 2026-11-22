// Identidad OMI/provenance sin valores de secretos. La versión/deployment no contienen commit en omi-api.
import { Type, type Static } from "typebox";
const closed = { additionalProperties: false } as const, text = (max = 256) => Type.String({ minLength: 1, maxLength: max });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const OmiDestinationSchema = Type.Object({ apiOrigin: text(2048), organization: text(), project: text(), projectPath: text(2048), service: text(100), environment: Type.Enum(["stage", "prod"]), linkHash: hash }, closed);
export const OmiRequestSchema = Type.Object({ kind: Type.Literal("omi"), action: Type.Enum(["publish-direct", "publish-tag", "deploy", "promote", "rollback"]), repo: text(200), subjectId: text(), targetId: text(100), integratedSha: sha, configHash: hash, correlationId: text(128), idempotencyKey: text(128), version: text(100), destination: OmiDestinationSchema }, closed);
export type OmiRequest = Static<typeof OmiRequestSchema>;
export const OmiAttestationSchema = Type.Object({ source: Type.Literal("person"), subjectId: text(), targetId: text(100), integratedSha: sha, version: text(100), reason: text(4000), at: text(100) }, closed);
export const PublicationInputSchema = Type.Union([
 Type.Object({ kind: Type.Literal("endpoint"), version: text(100), commitSha: sha }, closed),
 Type.Object({ kind: Type.Literal("publication"), id: text(), version: text(100), commitSha: sha, image: text(2048), digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }) }, closed),
]);
export const OmiOriginSchema = Type.Union([
 Type.Object({ kind: Type.Literal("endpoint"), commitSha: sha, field: text() }, closed),
 Type.Object({ kind: Type.Literal("publication"), commitSha: sha, publicationId: text(), image: text(2048), digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }) }, closed),
 Type.Object({ kind: Type.Literal("attested"), attestation: OmiAttestationSchema }, closed),
]);
export const OmiShipProofFields = { subjectId: text(), targetId: text(100), operationId: text(), configHash: hash, integratedSha: sha, kind: Type.Literal("omi"), destination: OmiDestinationSchema, version: text(100), deploymentId: text(), hostnameHash: hash, origin: OmiOriginSchema };
export const OmiStartedSchema = Type.Object({ id: text(), service: text(100), environment: Type.Enum(["stage", "prod"]), version: text(100), at: text(100) }, closed);
export const OmiQueuedSchema = Type.Object({ mutationId: text(), state: text(), at: text(100) }, closed);
export const PublicationFactSchema = Type.Object({ id: text(), operationId: text(), subjectId: text(), targetId: text(100), configHash: hash, version: text(100), commitSha: sha, image: text(2048), digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), destination: OmiDestinationSchema, via: Type.Enum(["tag", "direct"]), at: text(100) }, closed);
export type PublicationFact = Static<typeof PublicationFactSchema>;
