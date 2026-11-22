// Puertos reales GHA: GETs paginados y descarga binaria acotada por ID, nunca 'último run'.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { childEnvironment } from "../core/process-environment.ts";
import { parseWorkflow, type Workflow } from "./model.ts";
import { claimReviewRequest } from "./review-claim.ts";
import { GitHubReadClient, GitHubReadError } from "./lifecycle-github-read.ts";
import { PullSchema, githubChecked, sha, id, text } from "./lifecycle-github-schema.ts";
import { GhaRunSchema, checkedGhaRequest, type GhaReviewRequest, type GhaRun } from "./gha-review-contract.ts";
import { readReceiptZip } from "./gha-artifact.ts";
import type { GhaReviewPorts } from "./lifecycle-gha-review.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { trustedWorkflow } from "./github-workflow-reference.ts";
const ArtifactSchema = Type.Object({ id, name: text(1000), size_in_bytes: Type.Integer({ minimum: 1 }), expired: Type.Boolean(), digest: Type.Optional(Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()])), workflow_run: Type.Object({ id, head_sha: sha }) });
/** Resuelve el ref aceptado; un nombre ambiguo branch/tag no elige uno por inferencia. */
export async function persistGhaReviewRequest(checkout: Workflow["checkout"], issue: number, operationId: string, input: unknown): Promise<void> {
 await claimReviewRequest({ checkout, issue, operationId }, checkedGhaRequest(input));
}
export async function resolveGhaReviewRequest(original: unknown, operationId: string, client: GitHubReadClient, signal: AbortSignal): Promise<GhaReviewRequest> {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled", "lifecycle no configurado");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), subject = s.subjects.find(x => x.id === op?.subjectId);
 const pin = s.pins.find(p => p.accepted.blockHash === op?.configHash); const provider = pin?.accepted.block.review.provider;
 lifecycleAssert(op?.kind === "review" && subject && provider?.kind === "gha" && client.repo === s.root.repo, "operación/proveedor/repo de review ajenos");
 if (op.providerRequest) return checkedGhaRequest(op.providerRequest);
 const workflow = await trustedWorkflow(client, provider.workflow, provider.ref, signal);
 const created = Date.parse(op.history[0]?.at ?? ""); lifecycleAssert(Number.isFinite(created), "reserva sin fecha reconciliable");
 return checkedGhaRequest({ repo: client.repo, pr: subject.number, headSha: subject.headSha, baseSha: subject.baseSha, correlationId: op.correlationId,
  createdAfter: new Date(created - 300000).toISOString(), workflow });
}
export function reviewArtifactName(request: GhaReviewRequest, run: GhaRun): string { return `omi-review-v1-${request.correlationId}-${run.id}-${run.run_attempt}`; }
export type ArtifactDownload = (repo: string, artifactId: number, signal: AbortSignal) => Promise<Buffer>;
const download: ArtifactDownload = (repo, artifactId, signal) => new Promise((done, reject) => {
 execFile("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repo}/actions/artifacts/${artifactId}/zip`], {
  encoding: "buffer", signal, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  env: childEnvironment({ ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" }),
 }, (error, stdout) => error ? reject(new GitHubReadError("No se pudo leer el artefacto por ID; conservar correlación")) : done(stdout));
});
export interface GhaReviewIOOptions { client: GitHubReadClient; timeoutSeconds: number; signal: AbortSignal; runner?: Runner; now?: () => number; wait?: GhaReviewPorts["wait"]; downloadArtifact?: ArtifactDownload; beforeDispatch?: (request: GhaReviewRequest) => Promise<void>; workflowStore?: { checkout: Workflow["checkout"]; issue: number; operationId: string } }
export function createGhaReviewPorts(input: unknown, options: GhaReviewIOOptions): GhaReviewPorts {
 const request = checkedGhaRequest(input), client = options.client; const store = options.workflowStore; lifecycleAssert(client.repo === request.repo, "cliente de otro repositorio");
 return {
  ...(options.runner ? { runner: options.runner } : {}), ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}),
  ...(store ? { recordRequest: (input: GhaReviewRequest) => persistGhaReviewRequest(store.checkout, store.issue, store.operationId, input) } : {}),
  timeoutSeconds: options.timeoutSeconds, signal: options.signal, now: options.now ?? (() => performance.now()), wait: options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal })),
  listRuns: signal => {
   const query = new URLSearchParams({ event: "workflow_dispatch", branch: request.workflow.ref.replace(/^refs\/(?:heads|tags)\//, ""), created: `>=${request.createdAfter}` });
   return client.collection(`repos/${client.repo}/actions/workflows/${request.workflow.id}/runs?${query}`, GhaRunSchema, signal, "workflow_runs");
  },
  async currentSubject(signal) {
   const pr = githubChecked(PullSchema, await client.json(`repos/${client.repo}/pulls/${request.pr}`, signal));
   lifecycleAssert(pr.state === "open" && !pr.merged, "PR ya cerrado/mergeado; reconocer merge externo");
   return { repo: pr.base.repo.full_name.toLowerCase(), pr: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha };
  },
  async loadArtifact(run, expected, signal) {
   lifecycleAssert(Value.Check(GhaRunSchema, run) && run.workflow_id === request.workflow.id && expected.correlationId === request.correlationId, "run/correlación de otro artefacto");
   const artifacts = await client.collection(`repos/${client.repo}/actions/runs/${run.id}/artifacts`, ArtifactSchema, signal, "artifacts");
   const matching = artifacts.filter(a => a.name === reviewArtifactName(request, run)); const artifact = matching[0];
   lifecycleAssert(matching.length === 1 && artifact && !artifact.expired && artifact.workflow_run.id === run.id && artifact.workflow_run.head_sha === request.workflow.sha && artifact.size_in_bytes <= 8 * 1024 * 1024, "artefacto ausente/duplicado/expirado o de otro run/attempt");
   const bytes = await (options.downloadArtifact ?? download)(client.repo, artifact.id, signal);
   return readReceiptZip(bytes, "review.json", artifact.digest, signal);
  },
 };
}
