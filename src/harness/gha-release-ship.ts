// Release es evidencia por tag→commit→ancestro, workflow/evento y assets íntegros, no por semver/run verde.
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { lifecycleRef } from "./lifecycle-config.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash } from "./lifecycle-value.ts";
import { ReleasePlanSchema, verifyOmiReleasePlan } from "./omi-release-plan.ts";
import { GhaRunSchema } from "./gha-review-contract.ts";
import { GitHubReleaseSchema, ReleaseShipProofSchema, NotApplicableChoiceSchema, type ShipVerification } from "./ship-schema.ts";
import { shipContext, ghaShipRequest, shipScope, shipProbes, shipProofBase, type GhaShipDeps } from "./ship-context.ts";
function checksumEntries(bytes: Buffer): Map<string, string> {
 lifecycleAssert(bytes.length <= 2 * 1024 * 1024, "checksums demasiado grandes"); const entries = new Map<string, string>();
 for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/).filter(Boolean)) {
  const m = /^([a-f0-9]{64})[ \t]+[* ]?([^/\\]+)$/.exec(line); const name = m?.[2], hash = m?.[1];
  lifecycleAssert(name && hash && name !== "." && name !== ".." && !entries.has(name), "checksum incompleto/duplicado/path ajeno"); entries.set(name, hash);
 }
 return entries;
}
export async function verifyGhaRelease(original: unknown, operationId: string, deps: GhaShipDeps): Promise<ShipVerification> {
 let scope: ReturnType<typeof shipScope> | undefined;
 try {
  const c = shipContext(original, operationId); lifecycleAssert(c.target.evidence.kind === "github-release" && c.target.provider.kind === "gha" && c.target.provider.mode === "observe", "release sólo observa un contrato configurado; no dispara pipeline por inferencia");
  const evidence = c.target.evidence;
  scope = shipScope(deps, c.target.timeoutSeconds); const signal = scope.signal;
  if (Value.Check(NotApplicableChoiceSchema, deps.notApplicable)) {
   const fact = deps.notApplicable; lifecycleAssert(fact.subjectId === c.subject.id && fact.targetId === c.target.id && fact.integratedSha === c.subject.mergedSha, "no-aplica de otro destino/merge");
   return { state: "not-applicable", reason: fact.reason, proof: { ...shipProofBase(c, { health: "not-configured", version: "not-configured" }), kind: "not-applicable", source: "person", reason: fact.reason, evidenceHash: dataHash(fact) } };
  }
  const request = await ghaShipRequest(c, deps, signal); scope.check();
  const normalize = (ref: string) => ref.replace(/^refs\/heads\//, "");
  while (true) {
   scope.check(); const releases = await deps.listReleases(signal); scope.check(); const runs = await deps.listRuns(signal); scope.check();
   lifecycleAssert(Value.Check(Type.Array(GitHubReleaseSchema, { maxItems: 1000 }), releases) && Value.Check(Type.Array(GhaRunSchema, { maxItems: 1000 }), runs), "releases/runs truncados/incompletos");
   lifecycleAssert(new Set(releases.map(r => r.id)).size === releases.length && new Set(runs.map(r => r.id)).size === runs.length, "colecciones con IDs duplicados");
   for (const release of releases.filter(r => !r.draft && !r.prerelease).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at))) {
    scope.check(); lifecycleAssert(Number.isFinite(Date.parse(release.published_at)) && lifecycleRef(release.tag_name), "release/tag desconocidos");
    if (c.target.evidence.tag && release.tag_name !== c.target.evidence.tag) continue;
    const commitSha = await deps.resolveTag(release.tag_name, signal); scope.check();
    if (!(await deps.containsCommit(request.integratedSha, commitSha, signal))) continue; scope.check();
    const correlated = runs.filter(r => r.workflow_id === request.workflow.id && r.path.split("@")[0] === request.workflow.path && normalize(r.head_branch) === normalize(request.workflow.ref) && r.event === "push" && r.head_sha === commitSha && r.repository.full_name.toLowerCase() === request.repo && r.status === "completed" && r.conclusion === "success");
    if (correlated.length !== 1) continue; const run = correlated[0]; lifecycleAssert(run, "run ambiguo");
    const assets = release.assets; lifecycleAssert(new Set(assets.map(a => a.name)).size === assets.length, "assets ambiguos");
    const checksum = assets.find(a => a.name === evidence.checksumsAsset); lifecycleAssert(checksum && checksum.size <= 2 * 1024 * 1024, "falta checksum asset esperado");
    const raw = await deps.downloadAsset(checksum.id, signal); scope.check(); lifecycleAssert(Buffer.isBuffer(raw) && raw.length === checksum.size, "checksums incompletos"); const checksums = checksumEntries(raw);
    const verified = [];
    for (const name of c.target.evidence.assets) {
     const asset = assets.find(a => a.name === name), expected = checksums.get(name); lifecycleAssert(asset && expected, "falta asset/checksum esperado");
     const bytes = await deps.downloadAsset(asset.id, signal); scope.check();
     const digest = Buffer.isBuffer(bytes) ? { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } : bytes;
     lifecycleAssert(digest.sha256 === expected && digest.size === asset.size && (!asset.digest || asset.digest === `sha256:${digest.sha256}`), "digest/bytes de asset incorrectos"); verified.push({ id: asset.id, name: asset.name, ...digest });
    }
    lifecycleAssert(await deps.resolveTag(release.tag_name, signal) === commitSha, "tag cambió durante verificación"); scope.check();
    const probes = await shipProbes(c, deps, commitSha, release.tag_name, signal); scope.check();
    const proof = { ...shipProofBase(c, probes), kind: "github-release", repo: request.repo, releaseId: release.id, tag: release.tag_name, commitSha, runId: run.id, runAttempt: run.run_attempt, checksumsId: checksum.id, assets: verified };
    lifecycleAssert(Value.Check(ReleaseShipProofSchema, proof), "prueba release inválida");
    return { state: probes.health === "fail" || probes.version === "fail" ? "failed" : probes.health === "unknown" || probes.version === "unknown" ? "unknown" : "verified", proof, reason: "Release/tag/assets comprobados; probes independientes cuando están configurados" };
   }
   // Sólo el planner soportado del source fijado; no reconstruir con tags posteriores.
   const planRuns = runs.filter(r => r.workflow_id === request.workflow.id && r.path.split("@")[0] === request.workflow.path && normalize(r.head_branch) === normalize(request.workflow.ref) && r.event === "push" && r.head_sha === request.workflow.sha && r.repository.full_name.toLowerCase() === request.repo && r.status === "completed" && r.conclusion === "success");
   if (request.repo === "chichex/omi-code" && request.workflow.path === ".github/workflows/release.yml" && deps.loadReleasePlan && planRuns.length === 1) {
    const run = planRuns[0]; lifecycleAssert(run, "plan run ausente"); const raw = await deps.loadReleasePlan(run, request, signal); scope.check();
    lifecycleAssert(typeof raw === "string" && Buffer.byteLength(raw) <= 8 * 1024 * 1024 - 65536, "plan incompleto/grande"); const plan: unknown = JSON.parse(raw);
    if (Value.Check(ReleasePlanSchema, plan) && verifyOmiReleasePlan(plan, request, run)
     && await deps.containsCommit(request.integratedSha, plan.sourceSha, signal) && await deps.containsCommit(plan.baseSha, plan.sourceSha, signal) && !await deps.containsCommit(request.integratedSha, plan.baseSha, signal)) {
     scope.check(); return { state: "not-applicable", reason: "Planner conocido del source fijado no genera versión", proof: { ...shipProofBase(c, { health: "not-configured", version: "not-configured" }), kind: "not-applicable", source: "plan", reason: "nextVersion=null sobre snapshot completo anterior a la publicación", evidenceHash: dataHash(plan) } };
    }
   }
   await deps.wait(1000, signal);
  }
 } catch { return { state: "unknown", proof: null, reason: "Release/pipeline/provenance incompletos o timeout; ausencia no es no-aplica" }; }
 finally { scope?.close(); }
}
