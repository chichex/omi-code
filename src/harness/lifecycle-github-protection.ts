// Observación de reglas efectivas clásicas+rulesets. Un error/contrato desconocido no equivale a vacío.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { GitHubReadClient, GitHubReadError } from "./lifecycle-github-read.ts";
import { BranchSchema, ClassicSchema, RepoSchema, RuleSchema, RuleChecksSchema, RuleReviewSchema, githubChecked, id, text } from "./lifecycle-github-schema.ts";
export interface RequiredGitHubCheck { context: string; appId: number | null }
export interface GitHubProtection {
 status: "known" | "unknown"; requiredChecks: RequiredGitHubCheck[] | null; requiredReviewCount: number | null;
 constraints: string[]; allowedMethods: ("squash" | "merge" | "rebase")[] | null; actorCanPush: boolean | null;
}
export const unknownProtection = (): GitHubProtection => ({ status: "unknown", requiredChecks: null, requiredReviewCount: null, constraints: [], allowedMethods: null, actorCanPush: null });
const ExtraChecks = Type.Array(Type.Object({ context: text(), appId: id }, { additionalProperties: false }), { maxItems: 1000 });
const enabledFlag = Type.Object({ enabled: Type.Boolean() });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CLASSIC_KEYS = new Set(["url", "required_status_checks", "required_pull_request_reviews", "enforce_admins", "restrictions", "required_signatures", "required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations", "required_conversation_resolution", "lock_branch", "allow_fork_syncing"]);
export async function readGitHubProtection(client: GitHubReadClient, base: string, extraChecks: unknown, signal: AbortSignal): Promise<GitHubProtection> {
 try {
  const extras = githubChecked(ExtraChecks, extraChecks);
  const prefix = `repos/${client.repo}`; const branch = encodeURIComponent(base);
  const repo = githubChecked(RepoSchema, await client.json(prefix, signal));
  if (repo.full_name.toLowerCase() !== client.repo) throw new GitHubReadError("Reglas de otro repositorio");
  const metadata = githubChecked(BranchSchema, await client.json(`${prefix}/branches/${branch}`, signal));
  if (metadata.name !== base) throw new GitHubReadError("Reglas de otra base");
  let raw: unknown;
  try { raw = await client.json(`${prefix}/branches/${branch}/protection`, signal); }
  catch (error) { if (!(error instanceof GitHubReadError) || error.status !== 404 || metadata.protected) throw error; raw = null; }
  const checks: RequiredGitHubCheck[] = [...extras]; const constraints: string[] = []; let reviews = 0;
  let methods = [...(repo.allow_squash_merge ? ["squash" as const] : []), ...(repo.allow_merge_commit ? ["merge" as const] : []), ...(repo.allow_rebase_merge ? ["rebase" as const] : [])];
  if (raw !== null) {
   const classic = githubChecked(ClassicSchema, raw);
   const url = new URL(classic.url);
   const identity = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)\/protection$/.exec(decodeURIComponent(url.pathname));
   if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.username || url.password || url.search || url.hash || identity?.[1]?.toLowerCase() !== client.repo || identity[2] !== base) throw new GitHubReadError("Protección de otra identidad");
   if (!record(raw) || Object.keys(raw).some(key => !CLASSIC_KEYS.has(key))) throw new GitHubReadError("Protección con contrato no soportado");
   if (classic.required_status_checks?.strict) constraints.push("strict_required_status_checks");
   const detailed = classic.required_status_checks?.checks ?? [];
   for (const check of detailed) checks.push({ context: check.context, appId: check.app_id });
   for (const context of classic.required_status_checks?.contexts ?? []) if (!detailed.some(c => c.context === context)) checks.push({ context, appId: null });
   reviews = classic.required_pull_request_reviews?.required_approving_review_count ?? 0;
   const reviewRules: unknown = raw.required_pull_request_reviews;
   if (record(reviewRules) && (reviewRules.require_code_owner_reviews === true || reviewRules.require_last_push_approval === true)) throw new GitHubReadError("Falta evidencia específica de code owner/último push");
   if (raw.restrictions !== undefined && raw.restrictions !== null) throw new GitHubReadError("Restricciones de actores requieren verificación específica");
   for (const key of ["required_signatures", "required_conversation_resolution", "lock_branch", "block_creations"]) {
    const flag = raw[key]; if (flag !== undefined && flag !== null && (!Value.Check(enabledFlag, flag) || flag.enabled)) throw new GitHubReadError("Falta verificador para una protección efectiva");
   }
   if (raw.required_linear_history !== undefined) { const flag = githubChecked(enabledFlag, raw.required_linear_history); if (flag.enabled) constraints.push("required_linear_history"); }
  }
  const rules = await client.collection(`${prefix}/rules/branches/${branch}`, RuleSchema, signal);
  for (const rule of rules) {
   if (rule.type === "required_status_checks") {
    const p = githubChecked(RuleChecksSchema, rule.parameters); for (const check of p.required_status_checks) checks.push({ context: check.context, appId: check.integration_id });
    if (p.strict_required_status_checks_policy) constraints.push("strict_required_status_checks");
   } else if (rule.type === "pull_request") {
    const p = githubChecked(RuleReviewSchema, rule.parameters);
    if (p.require_code_owner_review || p.require_last_push_approval || p.required_review_thread_resolution) throw new GitHubReadError("Falta evidencia específica de reviews/conversaciones");
    reviews = Math.max(reviews, p.required_approving_review_count);
    if (p.allowed_merge_methods) methods = methods.filter(method => p.allowed_merge_methods?.includes(method));
   }
   else if (["required_linear_history", "non_fast_forward", "deletion"].includes(rule.type)) constraints.push(rule.type);
   else throw new GitHubReadError("Regla efectiva sin verificador");
  }
  const unique = [...new Map(checks.map(c => [JSON.stringify([c.context, c.appId]), c])).values()];
  return { status: "known", requiredChecks: unique, requiredReviewCount: reviews, constraints: [...new Set(constraints)],
   allowedMethods: methods, actorCanPush: repo.permissions?.push ?? null };
 } catch { return unknownProtection(); }
}
