// Planner soportado de omi-code por SHA-256 exacto. Un cambio de source exige soporte nuevo, no adivinar.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GhaRunSchema } from "./gha-review-contract.ts";
import { latestV1, versionV1 } from "./release-version-policy-v1.ts";
import type { GhaShipRequest } from "./ship-schema.ts";
export const SUPPORTED_RELEASE_PLANNER_HASH = "f7b16acbf69a072a440445305dc22eff801f0b9b565b2e0bc26302c9f20817c5";
const closed = { additionalProperties: false } as const, sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" }), text = Type.String({ minLength: 1, maxLength: 4000 });
export const ReleasePlanSchema = Type.Object({ version: Type.Literal(1), contract: Type.Literal("omi-release-plan-v1"), repo: Type.String({ minLength: 1, maxLength: 200 }), sourceSha: sha, runId: Type.Integer({ minimum: 1 }), runAttempt: Type.Integer({ minimum: 1 }), plannerHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), force: Type.Boolean(), complete: Type.Boolean(), baseTag: Type.String({ pattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$" }), baseSha: sha,
 tags: Type.Array(Type.Object({ name: Type.String({ pattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$" }), sha }, closed), { minItems: 1, maxItems: 1000 }),
 commits: Type.Array(Type.Object({ sha, message: text, files: Type.Array(text, { maxItems: 1000 }) }, closed), { maxItems: 1000 }), nextVersion: Type.Union([Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }), Type.Null()]) }, closed);
export type ReleasePlan = Static<typeof ReleasePlanSchema>;
export function verifyOmiReleasePlan(input: unknown, request: GhaShipRequest, observedRun: unknown): boolean {
 if (request.repo !== "chichex/omi-code" || request.workflow.path !== ".github/workflows/release.yml" || request.kind !== "gha-release" || !Value.Check(ReleasePlanSchema, input) || !Value.Check(GhaRunSchema, observedRun)) return false;
 if (!input.complete || input.force || input.plannerHash !== SUPPORTED_RELEASE_PLANNER_HASH || input.repo !== request.repo || input.sourceSha !== observedRun.head_sha || input.runId !== observedRun.id || input.runAttempt !== observedRun.run_attempt || observedRun.workflow_id !== request.workflow.id || observedRun.repository.full_name.toLowerCase() !== request.repo || observedRun.event !== "push" || observedRun.status !== "completed" || observedRun.conclusion !== "success") return false;
 if (new Set(input.tags.map(t => t.name)).size !== input.tags.length || new Set(input.commits.map(c => c.sha)).size !== input.commits.length || input.commits.some(c => c.files.some(p => /[\x00-\x1f\x7f]/.test(p)))) return false;
 const version = latestV1(input.tags.map(t => t.name));
 if (input.baseTag !== `v${version}` || input.tags.find(t => t.name === input.baseTag)?.sha !== input.baseSha || input.baseSha === input.sourceSha) return false;
 return input.nextVersion === null && version !== null && versionV1(version, input.commits, false) === null;
}
