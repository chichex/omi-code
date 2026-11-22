// Lecturas reales Ship y streaming binario. Datos externos no eligen comandos/URLs/credenciales.
import { Type } from "typebox";
import { setTimeout as sleep } from "node:timers/promises";
import { GitHubReadClient } from "./lifecycle-github-read.ts";
import { GhaRunSchema } from "./gha-review-contract.ts";
import { GitHubReleaseSchema, ReleaseAssetSchema, type GhaShipRequest } from "./ship-schema.ts";
import { githubChecked, id, sha, text } from "./lifecycle-github-schema.ts";
import { trustedWorkflow, resolveCommitTag } from "./github-workflow-reference.ts";
import { githubBinary, githubAssetDigest, MAX_RELEASE_TARGET_BYTES } from "./github-binary-read.ts";
import { readReceiptZip } from "./gha-artifact.ts";
import { shipContext, type GhaShipDeps } from "./ship-context.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
const Artifact = Type.Object({ id, name: text(1000), expired: Type.Boolean(), size_in_bytes: Type.Integer({ minimum: 1, maximum: 8 * 1024 * 1024 }), digest: Type.Optional(Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()])), workflow_run: Type.Object({ id, head_sha: sha }) });
const Compare = Type.Object({ status: Type.Enum(["ahead", "behind", "diverged", "identical"]), ahead_by: Type.Integer({ minimum: 0 }), behind_by: Type.Integer({ minimum: 0 }), base_commit: Type.Object({ sha }) });
export interface GhaShipIOOptions {
 client: GitHubReadClient; signal: AbortSignal; runner?: GhaShipDeps["runner"]; now?: () => number; wait?: GhaShipDeps["wait"];
 downloadAsset?: GhaShipDeps["downloadAsset"]; downloadArtifact?: (id: number, signal: AbortSignal) => Promise<Buffer>;
 beforeDispatch?: GhaShipDeps["beforeDispatch"]; recordRequest?: GhaShipDeps["recordRequest"]; verifyProbes?: GhaShipDeps["verifyProbes"]; workflowStore?: GhaShipDeps["workflowStore"];
}
export function createGhaShipPorts(original: unknown, operationId: string, options: GhaShipIOOptions): GhaShipDeps {
 const c = shipContext(original, operationId), client = options.client; lifecycleAssert(client.repo === c.s.root.repo && c.target.provider.kind === "gha", "cliente/proveedor ajenos a Ship");
 const provider = c.target.provider, assets = new Map<number, { name: string; size: number }>(); let downloaded = 0;
 let workflow: Awaited<ReturnType<typeof trustedWorkflow>> | undefined;
 const getWorkflow = async (signal: AbortSignal, refresh = false) => {
  if (c.op.shipRequest && !refresh) { lifecycleAssert(c.op.shipRequest.kind !== "omi", "request de otro proveedor"); return c.op.shipRequest.workflow; }
  if (refresh) workflow = undefined;
  return workflow ??= await trustedWorkflow(client, provider.workflow, provider.ref, signal);
 };
 async function artifact(runValue: unknown, expectedName: string, filename: "ship.json" | "omi-release-plan.json", signal: AbortSignal) {
  const run = githubChecked(GhaRunSchema, runValue);
  const all = await client.collection(`repos/${client.repo}/actions/runs/${run.id}/artifacts`, Artifact, signal, "artifacts"); const matching = all.filter(a => a.name === expectedName), found = matching[0];
  lifecycleAssert(matching.length === 1 && found && !found.expired && found.workflow_run.id === run.id && found.workflow_run.head_sha === run.head_sha, "artefacto Ship/plan ausente/duplicado/de otro run");
  const bytes = await (options.downloadArtifact ? options.downloadArtifact(found.id, signal) : githubBinary(client.repo, "artifact", found.id, 8 * 1024 * 1024, signal));
  return readReceiptZip(bytes, filename, found.digest, signal);
 }
 const config: GhaShipDeps = {
  signal: options.signal, timeoutSeconds: c.target.timeoutSeconds, now: options.now ?? (() => performance.now()), wait: options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal })), workflow: getWorkflow,
  ...(options.runner ? { runner: options.runner } : {}), ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}), ...(options.recordRequest ? { recordRequest: options.recordRequest } : {}), ...(options.verifyProbes ? { verifyProbes: options.verifyProbes } : {}), ...(options.workflowStore ? { workflowStore: options.workflowStore } : {}),
  async listRuns(signal) {
   const wf = await getWorkflow(signal); const query = new URLSearchParams({ branch: provider.ref.replace(/^refs\/(?:heads|tags)\//, "") });
   if (c.target.evidence.kind === "github-release") query.set("event", "push"); else if (provider.mode === "dispatch") query.set("event", "workflow_dispatch");
   const mergedAt = c.s.merges?.find(m => m.mergedSubjectId === c.subject.id)?.mergedAt;
   if (mergedAt && Number.isFinite(Date.parse(mergedAt))) query.set("created", `>=${new Date(Date.parse(mergedAt) - 300000).toISOString()}`);
   return client.collection(`repos/${client.repo}/actions/workflows/${wf.id}/runs?${query}`, GhaRunSchema, signal, "workflow_runs");
  },
  async listReleases(signal) {
   const all = await client.collection(`repos/${client.repo}/releases`, GitHubReleaseSchema, signal); let bytes = 0;
   for (const release of all) { release.assets = await client.collection(`repos/${client.repo}/releases/${release.id}/assets`, ReleaseAssetSchema, signal); bytes += Buffer.byteLength(JSON.stringify(release)); lifecycleAssert(bytes <= 8 * 1024 * 1024, "snapshot release demasiado grande"); for (const asset of release.assets) assets.set(asset.id, { name: asset.name, size: asset.size }); }
   return all;
  },
  resolveTag: (tag, signal) => resolveCommitTag(client, tag, signal),
  async containsCommit(ancestor, descendant, signal) {
   if (ancestor === descendant) return true;
   const compared = githubChecked(Compare, await client.json(`repos/${client.repo}/compare/${ancestor}...${descendant}`, signal));
   lifecycleAssert(compared.base_commit.sha === ancestor, "compare de otro commit"); return compared.behind_by === 0 && ["ahead", "identical"].includes(compared.status);
  },
  async downloadAsset(id, signal) {
   const asset = assets.get(id); lifecycleAssert(asset, "asset no pertenece al release observado"); downloaded += asset.size; lifecycleAssert(downloaded <= MAX_RELEASE_TARGET_BYTES, "assets exceden presupuesto de bytes del target");
   if (options.downloadAsset) return options.downloadAsset(id, signal);
   if (c.target.evidence.kind === "github-release" && asset.name === c.target.evidence.checksumsAsset) return githubBinary(client.repo, "asset", id, 2 * 1024 * 1024, signal);
   return githubAssetDigest(client.repo, id, asset.size, signal);
  },
  loadReceipt: (run, request: GhaShipRequest, signal) => { const r = githubChecked(GhaRunSchema, run); const correlation = request.mode === "dispatch" ? request.correlationId : r.display_title.slice(`omi-ship-v1 ${request.targetId} `.length); lifecycleAssert(/^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/.test(correlation), "correlación de provider inválida"); return artifact(r, `omi-ship-v1-${correlation}-${r.id}-${r.run_attempt}`, "ship.json", signal); },
  loadReleasePlan: (run, _request, signal) => { const r = githubChecked(GhaRunSchema, run); return artifact(r, `omi-release-plan-v1-${r.id}-${r.run_attempt}`, "omi-release-plan.json", signal); },
 };
 return config;
}
