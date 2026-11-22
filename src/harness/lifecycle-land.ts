// Listo para merge es un hecho durable, no un efecto ni permiso. CI/Review/Land/Ship siguen separados.
import { Value } from "typebox/value";
import { parseWorkflow, type WorkflowV2, MAX_HISTORY } from "./model.ts";
import { isApproved, recipeApprovalHash } from "./state.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash } from "./lifecycle-value.ts";
import { lifecycleFindingBlocks, bindLifecycleSubject } from "./lifecycle-state.ts";
import { currentLifecyclePin } from "./lifecycle-budget.ts";
import { landLedgerHash } from "./land-invariants.ts";
import { LandFactsSchema, LandRiskSchema, type LandFacts, type LandRisk, type ReadyLand } from "./land-schema.ts";
import { PullSchema } from "./lifecycle-github-schema.ts";
import { effectiveGitHubReviews } from "./github-review-opinions.ts";
export { landPullRequest } from "./land-operation.ts";
export interface LandReadiness { ready: boolean; auto: boolean; reasons: string[]; summary: string; hash: string }
function approvalFacts(f: LandFacts, configured: string[], required: number): boolean {
 const { valid, latest, forHead } = effectiveGitHubReviews(f.reviews, f.headSha); if (!valid) return false;
 if ([...forHead.values()].some(r => r.state === "CHANGES_REQUESTED")) return false;
 const approved = [...latest].filter(([login, r]) => f.reviewerPermissions.some(p => p.login.toLowerCase() === login && ["admin", "maintain", "write"].includes(p.permission)) && login !== f.pull.user.login.toLowerCase() && r.state === "APPROVED" && r.commit_id === f.headSha && r.submitted_at !== null).map(([login]) => login);
 return approved.length >= required && configured.every(r => approved.includes(r.toLowerCase()));
}
export function landReadiness(original: unknown, observed: unknown, witness: unknown): LandReadiness {
 const result: LandReadiness = { ready: false, auto: false, reasons: [], summary: "", hash: "" };
 try {
  const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted" && state.status === "active" && isApproved(state), "falta trabajo/PR adoptado y receta vigente");
  const s = state.lifecycle, config = currentLifecyclePin(s).accepted.block, subject = s.subjects.find(x => x.id === s.currentSubject);
  lifecycleAssert(subject && !subject.mergedSha && ["review", "ready", "land"].includes(s.stage) && state.steps.every(step => step.status === "done"), "falta sujeto actual o hay correcciones pendientes");
  lifecycleAssert(Value.Check(LandFactsSchema, observed) && Value.Check(LandRiskSchema, witness), "hechos/riesgo Land incompletos"); const f = observed, risk = witness;
  lifecycleAssert(f.complete && f.localVerified && f.repo === s.root.repo && f.number === subject.number && f.headSha === subject.headSha && f.baseSha === subject.baseSha && f.contentHash === subject.contentHash, "HEAD/base/contenido/facts incompletos u obsoletos");
  lifecycleAssert(subject.base === config.land.base && state.pullRequest.base === config.land.base, "base del PR no coincide con land.base aceptada");
  lifecycleAssert(state.pullRequest.head === f.headSha && f.pull.number === f.number && f.pull.head.sha === f.headSha && f.pull.base.sha === f.baseSha && f.pull.head.ref === subject.branch && f.pull.base.ref === subject.base && f.pull.base.repo.full_name.toLowerCase() === f.repo && f.pull.head.repo?.full_name.toLowerCase() === f.repo, "identidad PR/rama/base ajena");
  lifecycleAssert(f.pull.state === "open" && !f.pull.merged && !f.pull.draft && f.pull.mergeable === true && f.pull.mergeable_state === "clean", "PR draft/cerrado, mergeability desconocida o no limpio");
  lifecycleAssert(f.protection.status === "known" && f.protection.requiredChecks !== null && f.protection.requiredReviewCount !== null && f.protection.allowedMethods?.includes(config.land.method) && f.protection.actorCanPush === true, "protecciones/método/permisos efectivos desconocidos o incompatibles");
  lifecycleAssert(!f.protection.constraints.includes("strict_required_status_checks") || f.baseUpToDate === true, "strict exige base actual incluida en HEAD");
  lifecycleAssert(!(config.land.method === "merge" && f.protection.constraints.includes("required_linear_history")), "regla efectiva exige historia lineal");
  lifecycleAssert(["success", "not-required"].includes(f.checkState) && f.checks.every(c => c.state === "success"), "checks pendientes/fallidos/desconocidos");
  for (const required of [...f.protection.requiredChecks, ...config.land.requiredChecks]) lifecycleAssert(f.checks.some(c => c.context === required.context && (required.appId === null || c.appId === required.appId) && c.state === "success"), "falta required check context/appId actual");
  const provider = config.review.provider;
  lifecycleAssert(approvalFacts(f, provider.kind === "github" ? provider.reviewers : [], f.protection.requiredReviewCount), "reviews GitHub exigidas ausentes/dismissed/CHANGES_REQUESTED o del autor");
  lifecycleAssert(s.operations.some(o => o.kind === "review" && o.status === "confirmed" && o.receipt.outcome === "succeeded" && (o.receipt.verifiedSubjectId ?? o.subjectId) === subject.id), "falta Review inicial confirmada del SHA actual");
  if (provider.kind !== "github") lifecycleAssert(s.approvals.some(a => a.subjectId === subject.id && a.provider === provider.kind && a.state === "approved"), "review local/GHA actual no confirmada; no sustituye GitHub");
  lifecycleAssert(!lifecycleFindingBlocks(s).length, "hay hallazgos pendientes/humano/evidencia obsoleta");
  for (const finding of f.findings.filter(x => x.body.trim())) lifecycleAssert(s.ledger.some(entry => {
   const o = entry.observations.at(-1); return o?.provider === "github" && o.externalId === finding.externalId && o.subjectId === subject.id && o.text === finding.body && o.resolved === (finding.resolved === true) && o.outdated === finding.outdated;
  }), "nuevo comentario/hallazgo sin disposición en ledger");
  lifecycleAssert(risk.scopeHash === recipeApprovalHash(state) && risk.risk !== "unknown" && (risk.risk !== "high" || config.land.maxRisk === "high"), "riesgo/alcance desconocido o superior al aceptado");
  result.ready = true;
  result.auto = config.land.mode === "auto" && config.ship.status !== "unconfigured" && f.repo !== "chichex/omi-code" && risk.source !== "model" && !!risk.authorityHash;
  result.hash = landSnapshotHash(state, f, risk);
  result.summary = JSON.stringify({ objective: state.recipe?.objective, scope: state.recipe?.scope, outOfScope: state.recipe?.outOfScope, repo: f.repo, pr: f.number, headSha: f.headSha, baseSha: f.baseSha, base: subject.base, method: config.land.method,
   checks: f.checks, reviews: f.reviews.map(({ id, user, state, commit_id }) => ({ id, reviewer: user?.login, state, headSha: commit_id })), findings: s.ledger, warnings: state.reviews.filter(r => r.verdict !== "pass"), risk,
   ship: config.ship, note: "Listo para merge no es permiso de merge ni entrega; se releen hechos/reglas antes del efecto" }, null, 2);
  lifecycleAssert(Buffer.byteLength(result.summary) <= 1000000, "resumen demasiado grande; no se recorta para aprobar");
 } catch (e) { result.ready = false; result.auto = false; result.reasons.push(e instanceof Error ? e.message : "Land desconocido"); }
 return result;
}
export function landSnapshotHash(state: WorkflowV2, facts: LandFacts, risk: LandRisk): string {
 lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle deshabilitado");
 return dataHash({ subjectId: state.lifecycle.currentSubject, configHash: state.lifecycle.pinHash, sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), ledgerHash: landLedgerHash(state.lifecycle), facts, risk });
}
export function prepareLand(original: unknown, observed: unknown, witness: unknown, at: string): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)), readiness = landReadiness(state, observed, witness);
 lifecycleAssert(readiness.ready && Value.Check(LandFactsSchema, observed) && Value.Check(LandRiskSchema, witness) && state.lifecycle.status === "enabled" && state.lifecycle.currentSubject, readiness.reasons.join("; ") || "Land no listo");
 const s = state.lifecycle, subjectId = s.currentSubject; lifecycleAssert(subjectId, "falta sujeto actual");
 const snapshot: ReadyLand = { subjectId, configHash: s.pinHash, sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), ledgerHash: landLedgerHash(s), hash: readiness.hash, facts: structuredClone(observed), risk: structuredClone(witness), summary: readiness.summary, at };
 if (s.ready?.hash !== snapshot.hash) { if (s.ready) s.readyHistory = [...(s.readyHistory ?? []), s.ready]; s.ready = snapshot; }
 s.stage = "ready"; state.phase = "land"; state.revision++; state.activity = "Listo para merge; esperando permiso específico del PR/SHA"; state.history = [...state.history, { at, phase: state.phase, activity: state.activity }].slice(-MAX_HISTORY);
 return parseWorkflow(JSON.stringify(state));
}
export function acceptObservedMerge(original: unknown, observed: unknown, provenance: { source: "external" | "operation"; operationId?: string; at: string }): WorkflowV2 {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && state.pullRequest?.ownership === "adopted" && Value.Check(PullSchema, observed), "falta PR/merge observado válido");
 const s = state.lifecycle, subject = s.subjects.find(x => x.id === s.currentSubject);
 lifecycleAssert(subject && observed.merged && observed.state === "closed" && observed.merge_commit_sha && observed.number === state.pullRequest.number && observed.head.sha === state.pullRequest.head && observed.head.sha === subject.headSha && observed.head.ref === subject.branch && observed.base.ref === subject.base && observed.base.repo.full_name.toLowerCase() === s.root.repo && observed.head.repo?.full_name.toLowerCase() === s.root.repo, "merge externo ajeno/HEAD distinto o sin SHA integrado");
 const mergedSubjectId = `merged:${subject.number}:${observed.merge_commit_sha}`;
 state.lifecycle = bindLifecycleSubject(s, { id: mergedSubjectId, repo: subject.repo, number: subject.number, branch: subject.branch, base: subject.base, headSha: subject.headSha, baseSha: subject.baseSha, contentHash: subject.contentHash, mergedSha: observed.merge_commit_sha }, { id: `merge:${observed.merge_commit_sha}`, source: "merge", at: provenance.at });
 const fact = { subjectId: subject.id, mergedSubjectId, repo: s.root.repo, pr: subject.number, headSha: subject.headSha, mergeSha: observed.merge_commit_sha, base: subject.base, ...provenance };
 if (!(state.lifecycle.merges ?? []).some(m => m.mergeSha === fact.mergeSha && m.pr === fact.pr)) state.lifecycle.merges = [...(state.lifecycle.merges ?? []), fact];
 state.lifecycle.stage = "ship"; state.phase = "ship"; state.revision++; state.activity = "Merge observado: Land hecho, entrega todavía no verificada";
 return parseWorkflow(JSON.stringify(state));
}
