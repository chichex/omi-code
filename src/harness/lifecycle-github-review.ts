// Review GitHub observada por el host. Checks, hallazgos y aprobación son hechos separados.
import { Type, type Static } from "typebox";
import { GitHubReadClient, GitHubReadError, MAX_GITHUB_READ_BYTES } from "./lifecycle-github-read.ts";
import { ExpectedReviewSchema, PullSchema, ReviewSchema, CommentSchema, InlineSchema, StatusSchema, CheckRunSchema, githubChecked } from "./lifecycle-github-schema.ts";
import { readGitHubProtection, unknownProtection, type GitHubProtection, type RequiredGitHubCheck } from "./lifecycle-github-protection.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
import { effectiveGitHubReviews } from "./github-review-opinions.ts";
export { GitHubReadClient, GitHubReadError, MAX_GITHUB_READ_BYTES };
export interface GitHubFindingObservation {
 externalId: string; source: "review" | "inline" | "comment"; reviewer: string | null; body: string;
 commitSha: string | null; binding: "head" | "outdated" | "unbound"; path: string | null; line: number | null;
 resolved: boolean | null; outdated: boolean;
}
export interface ObservedGitHubCheck { id: number; context: string; appId: number | null; source: "status" | "check-run"; state: "success" | "failure" | "pending" | "unknown" }
export interface GitHubReviewObservation {
 complete: boolean; repo: string; number: number; headSha: string; baseSha: string; contentHash: string;
 approval: "approved" | "changes-requested" | "unknown";
 checkState: "success" | "failure" | "pending" | "unknown" | "not-required";
 protection: GitHubProtection; reviews: Static<typeof ReviewSchema>[]; checks: ObservedGitHubCheck[];
 inlineComments: GitHubFindingObservation[]; comments: GitHubFindingObservation[]; findings: GitHubFindingObservation[]; problems: string[];
}
function pullIdentity(pull: Static<typeof PullSchema>, expected: Static<typeof ExpectedReviewSchema>): void {
 if (pull.number !== expected.number || pull.head.sha !== expected.headSha || pull.base.sha !== expected.baseSha || pull.head.ref !== expected.branch || pull.base.ref !== expected.base || pull.base.repo.full_name.toLowerCase() !== expected.repo) throw new GitHubReadError("Cambió la identidad/HEAD/base del PR; evidencia obsoleta");
}
function approvalState(reviews: Static<typeof ReviewSchema>[], reviewers: string[], head: string): GitHubReviewObservation["approval"] {
 const { valid, latest, forHead } = effectiveGitHubReviews(reviews, head); if (!valid) return "unknown";
 const current = [...forHead.values()];
 if (current.some(review => review.state === "CHANGES_REQUESTED")) return "changes-requested";
 return reviewers.length > 0 && reviewers.every(login => { const review = latest.get(login.toLowerCase()); return review?.state === "APPROVED" && review.commit_id === head && review.submitted_at !== null; }) ? "approved" : "unknown";
}
function stateOfChecks(checks: ObservedGitHubCheck[], protection: GitHubProtection): GitHubReviewObservation["checkState"] {
 if (protection.requiredChecks === null) return "unknown";
 const required: RequiredGitHubCheck[] = protection.requiredChecks;
 const selected: (ObservedGitHubCheck | undefined)[] = [...checks, ...required.flatMap(required => {
  const matches = checks.filter(c => c.context === required.context && (required.appId === null || c.appId === required.appId));
  return matches.length ? matches : [undefined];
 })];
 if (selected.some(c => c?.state === "failure")) return "failure";
 if (selected.some(c => c?.state === "pending")) return "pending";
 if (selected.some(c => !c || c.state === "unknown")) return "unknown";
 return selected.length ? "success" : "not-required";
}
function observedChecks(statuses: Static<typeof StatusSchema>[], runs: Static<typeof CheckRunSchema>[], head: string): ObservedGitHubCheck[] {
 const checks: ObservedGitHubCheck[] = statuses.map(status => ({ id: status.id, context: status.context, appId: null, source: "status", state: status.state === "success" ? "success" : ["failure", "error"].includes(status.state) ? "failure" : status.state === "pending" ? "pending" : "unknown" }));
 for (const run of runs) {
  if (run.head_sha !== head) throw new GitHubReadError("Check de otro SHA");
  const state = run.status !== "completed" ? ["queued", "in_progress", "requested", "waiting", "pending"].includes(run.status) ? "pending" : "unknown"
   : run.conclusion === "success" ? "success" : ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(run.conclusion ?? "") ? "failure" : "unknown";
  checks.push({ id: run.id, context: run.name, appId: run.app?.id ?? null, source: "check-run", state });
 }
 // El historial de statuses no vuelve verde un contexto cuyo último resultado falló.
 return [...new Map(checks.sort((a, b) => a.id - b.id).map(check => [JSON.stringify([check.source, check.context, check.appId]), check])).values()];
}
function inlineObservation(comment: Static<typeof InlineSchema>, head: string): GitHubFindingObservation {
 return { externalId: String(comment.id), source: "inline", reviewer: comment.user?.login ?? null, body: comment.body, commitSha: comment.commit_id,
  binding: comment.commit_id === head ? "head" : "outdated", path: comment.path, line: comment.line, resolved: comment.resolved ?? null, outdated: comment.outdated === true || comment.commit_id !== head };
}
/** Lectura completa o unknown. Nunca solicita reviewers, hace push, mergea ni dispara workflows. */
async function collectGitHubReview(client: GitHubReadClient, input: unknown, configuredReviewers: unknown, extraChecks: unknown, signal: AbortSignal, minimumReviewers: number): Promise<GitHubReviewObservation> {
 const result: GitHubReviewObservation = { complete: false, repo: client.repo, number: 0, headSha: "", baseSha: "", contentHash: "", approval: "unknown", checkState: "unknown", protection: unknownProtection(), reviews: [], checks: [], inlineComments: [], comments: [], findings: [], problems: [] };
 try {
  const expected = githubChecked(ExpectedReviewSchema, input);
  const reviewers = githubChecked(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: minimumReviewers, maxItems: 1000 }), configuredReviewers);
  if (expected.repo !== client.repo || !lifecycleRef(expected.base) || !lifecycleRef(expected.branch) || new Set(reviewers.map(login => login.toLowerCase())).size !== reviewers.length) throw new GitHubReadError("Identidad/reviewers no válidos");
  Object.assign(result, { number: expected.number, headSha: expected.headSha, baseSha: expected.baseSha, contentHash: expected.contentHash });
  const prefix = `repos/${client.repo}`; const pr = `${prefix}/pulls/${expected.number}`;
  const before = githubChecked(PullSchema, await client.json(pr, signal)); pullIdentity(before, expected);
  if (before.state !== "open" || before.merged) throw new GitHubReadError("Review requiere PR abierto");
  result.reviews = await client.collection(`${pr}/reviews`, ReviewSchema, signal);
  const inline = await client.collection(`${pr}/comments`, InlineSchema, signal);
  const comments = await client.collection(`${prefix}/issues/${expected.number}/comments`, CommentSchema, signal);
  const statuses = await client.collection(`${prefix}/commits/${expected.headSha}/statuses`, StatusSchema, signal);
  const runs = await client.collection(`${prefix}/commits/${expected.headSha}/check-runs`, CheckRunSchema, signal, "check_runs");
  result.protection = await readGitHubProtection(client, expected.base, extraChecks, signal);
  result.inlineComments = inline.map(comment => inlineObservation(comment, expected.headSha));
  result.comments = comments.map(comment => ({ externalId: String(comment.id), source: "comment", reviewer: comment.user?.login ?? null, body: comment.body, commitSha: null, binding: "unbound", path: null, line: null, resolved: null, outdated: false }));
  result.findings = [...result.inlineComments, ...result.comments, ...result.reviews.filter(review => review.body.trim()).map(review => ({ externalId: String(review.id), source: "review" as const, reviewer: review.user?.login ?? null, body: review.body, commitSha: review.commit_id, binding: review.commit_id === expected.headSha ? "head" as const : "outdated" as const, path: null, line: null, resolved: null, outdated: review.commit_id !== expected.headSha }))];
  result.checks = observedChecks(statuses, runs, expected.headSha);
  const after = githubChecked(PullSchema, await client.json(pr, signal)); pullIdentity(after, expected);
  if (after.state !== before.state || after.merged !== before.merged || after.draft !== before.draft) throw new GitHubReadError("Cambió el PR durante la lectura");
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024 - 65536) throw new GitHubReadError("Snapshot demasiado grande; no se omiten hallazgos para aprobar");
  signal.throwIfAborted(); result.complete = true;
  result.approval = approvalState(result.reviews, reviewers, expected.headSha); result.checkState = stateOfChecks(result.checks, result.protection);
  if (result.protection.status === "unknown") result.problems.push("Protecciones efectivas desconocidas: no habilita Land automático");
  return result;
 } catch (error) {
  result.complete = false; result.approval = "unknown"; result.checkState = "unknown";
  result.problems.push(error instanceof GitHubReadError ? error.message : "No se completó la lectura GitHub; no acredita avance"); return result;
 }
}
export function readGitHubReview(client: GitHubReadClient, input: unknown, configuredReviewers: unknown, extraChecks: unknown, signal: AbortSignal): Promise<GitHubReviewObservation> {
 return collectGitHubReview(client, input, configuredReviewers, extraChecks, signal, 1);
}
/** Land observa también protecciones/reviews cuando el provider de Review es local/GHA. Vacío NO aprueba GitHub. */
export function readGitHubMergeReview(client: GitHubReadClient, input: unknown, configuredReviewers: unknown, extraChecks: unknown, signal: AbortSignal): Promise<GitHubReviewObservation> {
 return collectGitHubReview(client, input, configuredReviewers, extraChecks, signal, 0);
}
