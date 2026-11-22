// Hechos Land nuevos, no una aprobación derivada de provider local/GHA ni del listado informativo de runs.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow } from "./model.ts";
import { inspectCheckout, type CheckoutSnapshot } from "./git.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { GitHubReadClient, boundedGitHubRunner } from "./lifecycle-github-read.ts";
import { readGitHubMergeReview } from "./lifecycle-github-review.ts";
import { LandFactsSchema, LandPullSchema, ReviewerPermissionSchema, type LandFacts } from "./land-schema.ts";
import { sha, text, githubChecked } from "./lifecycle-github-schema.ts";
const Branch = Type.Object({ name: text(128), commit: Type.Object({ sha }) });
const Compare = Type.Object({ status: Type.Enum(["ahead", "behind", "diverged", "identical"]), ahead_by: Type.Integer({ minimum: 0 }), behind_by: Type.Integer({ minimum: 0 }) });
const Permission = Type.Object({ permission: ReviewerPermissionSchema.properties.permission, user: Type.Object({ login: text(100) }) });
export async function readGitHubLand(client: GitHubReadClient, original: unknown, options: { signal: AbortSignal; runner?: Runner; snapshot?: () => Promise<CheckoutSnapshot> }): Promise<{ status: "observed"; facts: LandFacts } | { status: "unknown"; reason: string }> {
 try {
  const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no habilitado");
  const s = state.lifecycle, sub = s.subjects.find(x => x.id === s.currentSubject), config = currentLifecyclePin(s).accepted.block;
  lifecycleAssert(sub && !sub.mergedSha && sub.repo === client.repo, "falta sujeto/repo actual");
  const inspect = options.snapshot ?? (() => inspectCheckout(state.checkout, options.runner ?? boundedGitHubRunner, options.signal));
  const local = await inspect(); lifecycleAssert(local.clean && local.head === sub.headSha && local.fingerprint === sub.contentHash && local.branch === sub.branch, "checkout no coincide con contenido adoptado");
  const provider = config.review.provider;
  const review = await readGitHubMergeReview(client, { repo: sub.repo, number: sub.number, headSha: sub.headSha, baseSha: sub.baseSha, branch: sub.branch, base: sub.base, contentHash: sub.contentHash }, provider.kind === "github" ? provider.reviewers : [], config.land.requiredChecks, options.signal);
  lifecycleAssert(review.complete && review.protection.status === "known", "reviews/checks/reglas incompletos");
  const reviewers = [...new Set(review.reviews.map(r => r.user?.login).filter((x): x is string => typeof x === "string"))];
  const reviewerPermissions: LandFacts["reviewerPermissions"] = [];
  for (const login of reviewers) {
   lifecycleAssert(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(login), "reviewer inválido");
   const response = githubChecked(Permission, await client.json(`repos/${client.repo}/collaborators/${encodeURIComponent(login)}/permission`, options.signal));
   lifecycleAssert(response.user.login.toLowerCase() === login.toLowerCase(), "permiso de otro reviewer"); reviewerPermissions.push({ login, permission: response.permission });
  }
  const branch = githubChecked(Branch, await client.json(`repos/${client.repo}/branches/${encodeURIComponent(sub.base)}`, options.signal));
  lifecycleAssert(branch.name === sub.base && branch.commit.sha === sub.baseSha, "base cambió durante la lectura");
  const compared = githubChecked(Compare, await client.json(`repos/${client.repo}/compare/${sub.baseSha}...${sub.headSha}`, options.signal));
  const pull = githubChecked(LandPullSchema, await client.json(`repos/${client.repo}/pulls/${sub.number}`, options.signal));
  lifecycleAssert(pull.head.sha === sub.headSha && pull.base.sha === sub.baseSha && pull.head.ref === sub.branch && pull.base.ref === sub.base && pull.base.repo.full_name.toLowerCase() === client.repo, "HEAD/base cambiaron al finalizar");
  const after = await inspect(); lifecycleAssert(after.clean && after.head === local.head && after.fingerprint === local.fingerprint && after.branch === local.branch, "checkout cambió durante lectura Land");
  const facts: LandFacts = { complete: true, localVerified: true, baseUpToDate: compared.behind_by === 0 && ["ahead", "identical"].includes(compared.status), reviewerPermissions,
   repo: review.repo, number: review.number, headSha: review.headSha, baseSha: review.baseSha, contentHash: local.fingerprint, pull, protection: review.protection, checkState: review.checkState, checks: review.checks, reviews: review.reviews, findings: review.findings, problems: review.problems };
  lifecycleAssert(Value.Check(LandFactsSchema, facts), "facts Land no verificables"); options.signal.throwIfAborted(); return { status: "observed", facts };
 } catch { return { status: "unknown", reason: "Lectura Land incompleta: no inventar permisos, aprobaciones ni protecciones vacías" }; }
}
