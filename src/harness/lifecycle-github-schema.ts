// Vistas externas mínimas de GitHub: campos relevantes validados, extras de API tolerados como datos.
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { GitHubReadError } from "./lifecycle-github-read.ts";
export const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const text = (maxLength = 1000) => Type.String({ minLength: 1, maxLength });
export const sha = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const login = Type.Union([Type.Null(), Type.Object({ login: text(100) })]);
const body = Type.String({ maxLength: 4000 });
export const ExpectedReviewSchema = Type.Object({ repo: Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 200 }), number: id,
 headSha: sha, baseSha: sha, branch: text(128), base: text(128), contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false });
export type ExpectedReview = Static<typeof ExpectedReviewSchema>;
export const PullSchema = Type.Object({ number: id, state: text(), draft: Type.Boolean(), head: Type.Object({ sha, ref: text(128), repo: Type.Union([Type.Null(), Type.Object({ full_name: text(200) })]) }),
 base: Type.Object({ sha, ref: text(128), repo: Type.Object({ full_name: text(200) }) }), merged: Type.Boolean(), merged_at: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])), merge_commit_sha: Type.Union([sha, Type.Null()]) });
export const RepoSchema = Type.Object({ full_name: text(200), default_branch: text(128), allow_squash_merge: Type.Boolean(), allow_merge_commit: Type.Boolean(), allow_rebase_merge: Type.Boolean(), permissions: Type.Optional(Type.Object({ push: Type.Boolean(), admin: Type.Boolean() })) });
export const BranchSchema = Type.Object({ name: text(128), protected: Type.Boolean() });
export const ReviewSchema = Type.Object({ id, user: login, state: text(100), commit_id: sha, submitted_at: Type.Union([text(100), Type.Null()]), body });
const CommentFields = { id, user: login, body, created_at: text(100), updated_at: text(100) };
export const CommentSchema = Type.Object(CommentFields);
export const InlineSchema = Type.Object({ ...CommentFields, commit_id: sha, original_commit_id: Type.Optional(sha), pull_request_review_id: Type.Optional(Type.Union([id, Type.Null()])),
 path: text(4096), line: Type.Union([id, Type.Null()]), resolved: Type.Optional(Type.Boolean()), outdated: Type.Optional(Type.Boolean()) });
export const StatusSchema = Type.Object({ id, context: text(), state: text(100), created_at: text(100), updated_at: text(100) });
export const CheckRunSchema = Type.Object({ id, name: text(), head_sha: sha, status: text(100), conclusion: Type.Union([text(100), Type.Null()]), app: Type.Union([Type.Null(), Type.Object({ id })]), completed_at: Type.Optional(Type.Union([text(100), Type.Null()])) });
export const RequiredCheckSchema = Type.Object({ context: text(), app_id: Type.Union([id, Type.Null()]) });
export const ClassicSchema = Type.Object({ url: text(2000), required_status_checks: Type.Optional(Type.Union([Type.Null(), Type.Object({ strict: Type.Boolean(), checks: Type.Array(RequiredCheckSchema, { maxItems: 1000 }), contexts: Type.Array(text(), { maxItems: 1000 }) })])),
 required_pull_request_reviews: Type.Optional(Type.Union([Type.Null(), Type.Object({ required_approving_review_count: Type.Integer({ minimum: 0, maximum: 1000 }), require_code_owner_reviews: Type.Optional(Type.Boolean()), require_last_push_approval: Type.Optional(Type.Boolean()), dismiss_stale_reviews: Type.Optional(Type.Boolean()) })])) });
export const RuleSchema = Type.Object({ type: text(100), parameters: Type.Optional(Type.Unknown()) });
export const RuleChecksSchema = Type.Object({ required_status_checks: Type.Array(Type.Object({ context: text(), integration_id: Type.Union([id, Type.Null()]) }), { maxItems: 1000 }), strict_required_status_checks_policy: Type.Boolean() });
export const RuleReviewSchema = Type.Object({ required_approving_review_count: Type.Integer({ minimum: 0, maximum: 1000 }),
 require_code_owner_review: Type.Optional(Type.Boolean()), require_last_push_approval: Type.Optional(Type.Boolean()), required_review_thread_resolution: Type.Optional(Type.Boolean()),
 allowed_merge_methods: Type.Optional(Type.Array(Type.Enum(["squash", "merge", "rebase"]), { maxItems: 3, uniqueItems: true })) });
export function githubChecked<S extends TSchema>(schema: S, value: unknown): Static<S> {
 if (!Value.Check(schema, value)) throw new GitHubReadError("GitHub devolvió datos incompletos o fuera del contrato"); return value;
}
