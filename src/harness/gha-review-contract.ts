// omi-review-v1: identidad host separada del veredicto del reviewer. Sin efectos ni credenciales.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { lifecycleRef } from "./lifecycle-config.ts";
import { sameData } from "./lifecycle-value.ts";
const closed = { additionalProperties: false } as const;
const text = (maxLength = 256) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const Repo = Type.String({ maxLength: 200, pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$" });
const Correlation = Type.String({ maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$" });
export const MAX_REVIEW_ARTIFACT_BYTES = 8 * 1024 * 1024 - 65536;
export const ReviewFindingSchema = Type.Object({ id: text(128), severity: Type.Enum(["low", "medium", "high", "critical", "unknown"]), message: text(4000), path: Type.Union([text(4096), Type.Null()]), line: Type.Union([id, Type.Null()]) }, closed);
export const ModelReviewSchema = Type.Object({ verdict: Type.Enum(["pass", "findings", "unknown"]), findings: Type.Array(ReviewFindingSchema, { maxItems: 1000 }) }, closed);
export const ReviewMetadataSchema = Type.Object({ repo: Repo, pr: id, headSha: sha, baseSha: sha, diffBaseSha: sha, workflowSha: sha,
 materialHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), materialComplete: Type.Boolean(), fileCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
 correlationId: Correlation, runId: id, runAttempt: id }, closed);
export const GhaReviewArtifactSchema = Type.Object({ version: Type.Literal(1), contract: Type.Literal("omi-review-v1"), ...ReviewMetadataSchema.properties, state: Type.Enum(["complete", "incomplete", "error"]), verdict: Type.Enum(["pass", "findings", "unknown"]), findings: Type.Array(ReviewFindingSchema, { maxItems: 1000 }) }, closed);
export type GhaReviewArtifact = Static<typeof GhaReviewArtifactSchema>;
export const GhaReviewRequestSchema = Type.Object({ repo: Repo, pr: id, headSha: sha, baseSha: sha, correlationId: Correlation, createdAfter: text(100),
 workflow: Type.Object({ id, path: Type.String({ pattern: "^\\.github/workflows/[A-Za-z0-9_][A-Za-z0-9_.-]*\\.ya?ml$", maxLength: 256 }), ref: text(256), sha }, closed) }, closed);
export type GhaReviewRequest = Static<typeof GhaReviewRequestSchema>;
export const GhaRunSchema = Type.Object({ id, workflow_id: id, path: text(1000), head_sha: sha, head_branch: text(256), event: text(100), display_title: text(1000), run_attempt: id,
 status: text(100), conclusion: Type.Union([text(100), Type.Null()]), created_at: text(100), repository: Type.Object({ full_name: text(200) }) });
export type GhaRun = Static<typeof GhaRunSchema>;
const InputsSchema = Type.Object({ pr: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 16 }), expected_head_sha: Type.Optional(Type.String({ maxLength: 64 })), correlation_id: Type.Optional(Type.String({ maxLength: 128 })),
 model: Type.Optional(Type.Enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"])), effort: Type.Optional(Type.Enum(["low", "medium", "high", "xhigh", "max"])) }, closed);
export function parseReviewDispatchInputs(input: unknown): { kind: "legacy"; pr: number } | { kind: "strong"; pr: number; headSha: string; correlationId: string } {
 if (!Value.Check(InputsSchema, input)) throw new Error("Inputs de review inválidos");
 const pr = Number(input.pr); if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("PR inválido");
 const head = input.expected_head_sha ?? "", correlationId = input.correlation_id ?? "";
 if (!head && !correlationId) return { kind: "legacy", pr };
 if (!Value.Check(sha, head) || !Value.Check(Correlation, correlationId)) throw new Error("expected_head_sha y correlation_id se requieren juntos y válidos");
 return { kind: "strong", pr, headSha: head, correlationId };
}
export function checkedGhaRequest(input: unknown): GhaReviewRequest {
 if (!Value.Check(GhaReviewRequestSchema, input) || !lifecycleRef(input.workflow.ref) || !Number.isFinite(Date.parse(input.createdAfter))) throw new Error("Identidad/ref/correlación de review GHA inválidos");
 return structuredClone(input);
}
export const reviewRunName = (input: unknown): string => { const r = checkedGhaRequest(input); return `omi-review-v1 PR #${r.pr} ${r.correlationId}`; };
export function uniqueReviewFindings(findings: Static<typeof ReviewFindingSchema>[]): { valid: boolean; findings: Static<typeof ReviewFindingSchema>[] } {
 const unique = new Map<string, Static<typeof ReviewFindingSchema>>();
 for (const finding of findings) {
  if (finding.path && (finding.path.startsWith("/") || finding.path.includes("\\") || finding.path.split("/").some(p => p === ".." || p === ".") || /[\x00-\x1f\x7f]/.test(finding.path))) return { valid: false, findings };
  const previous = unique.get(finding.id);
  if (previous && !sameData(previous, finding)) return { valid: false, findings };
  unique.set(finding.id, finding);
 }
 return { valid: true, findings: [...unique.values()] };
}
/** El reviewer sólo controla verdict/findings; nunca SHA, run/attempt, repo ni estado de ejecución. */
export function buildReviewArtifact(metadata: unknown, output: unknown, conclusion: string): GhaReviewArtifact {
 if (!Value.Check(ReviewMetadataSchema, metadata)) throw new Error("Metadata host de review incompleta");
 const receipt: GhaReviewArtifact = { version: 1, contract: "omi-review-v1", ...structuredClone(metadata), state: !metadata.materialComplete || conclusion === "success" ? "incomplete" : "error", verdict: "unknown", findings: [] };
 try {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_REVIEW_ARTIFACT_BYTES) return receipt;
  const raw: unknown = JSON.parse(output);
  if (!Value.Check(ModelReviewSchema, raw)) return receipt;
  const normalized = uniqueReviewFindings(raw.findings); receipt.findings = normalized.findings;
  if (conclusion !== "success" || !metadata.materialComplete || !normalized.valid || raw.verdict === "unknown" || raw.verdict === "findings" && !raw.findings.length) return receipt;
  receipt.state = "complete"; receipt.verdict = receipt.findings.length ? "findings" : "pass"; return receipt;
 } catch { return receipt; }
}
