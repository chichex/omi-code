// Review GHA: el run de main no prueba checkout del PR; el recibo completo y correlacionado sí.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runner } from "../core/exec.ts";
import { parseWorkflow } from "./model.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { boundedGitHubRunner } from "./lifecycle-github-read.ts";
import { GhaReviewArtifactSchema, GhaRunSchema, MAX_REVIEW_ARTIFACT_BYTES, checkedGhaRequest, reviewRunName, uniqueReviewFindings, type GhaReviewRequest, type GhaReviewArtifact, type GhaRun } from "./gha-review-contract.ts";
export { parseReviewDispatchInputs, buildReviewArtifact, reviewRunName } from "./gha-review-contract.ts";
export interface GhaReviewResult { status: "pass" | "findings" | "unknown"; receipt: GhaReviewArtifact | null; reason: string }
const unknown = (reason: string, receipt: GhaReviewArtifact | null = null): GhaReviewResult => ({ status: "unknown", receipt, reason });
function runIdentity(request: GhaReviewRequest, run: GhaRun): boolean {
 const normalize = (ref: string) => ref.replace(/^refs\/(?:heads|tags)\//, "");
 const [path, ref] = run.path.split("@");
 return run.workflow_id === request.workflow.id && path === request.workflow.path && (!ref || normalize(ref) === normalize(request.workflow.ref))
  && run.head_sha === request.workflow.sha && normalize(run.head_branch) === normalize(request.workflow.ref)
  && run.event === "workflow_dispatch" && run.display_title === reviewRunName(request) && run.repository.full_name.toLowerCase() === request.repo
  && Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) >= Date.parse(request.createdAfter);
}
export function selectCorrelatedReviewRun(input: unknown, candidates: unknown): { status: "found"; run: GhaRun } | { status: "unknown"; reason: "missing" | "ambiguous" | "invalid" } {
 try {
  const request = checkedGhaRequest(input);
  if (!Value.Check(Type.Array(GhaRunSchema, { maxItems: 1000 }), candidates)) return { status: "unknown", reason: "invalid" };
  const matching = candidates.filter(run => run.display_title === reviewRunName(request));
  if (matching.length !== 1) return { status: "unknown", reason: matching.length ? "ambiguous" : "missing" };
  const run = matching[0]; if (!run || !runIdentity(request, run)) return { status: "unknown", reason: "invalid" };
  return { status: "found", run };
 } catch { return { status: "unknown", reason: "invalid" }; }
}
const CurrentSubjectSchema = Type.Object({ repo: Type.String(), pr: Type.Integer(), headSha: Type.String(), baseSha: Type.String() }, { additionalProperties: false });
export function validateGhaReview(input: unknown, observedRun: unknown, raw: unknown, current: unknown): GhaReviewResult {
 try {
  const request = checkedGhaRequest(input);
  if (!Value.Check(GhaRunSchema, observedRun) || !runIdentity(request, observedRun) || observedRun.status !== "completed" || observedRun.conclusion !== "success") return unknown("Run/workflow/ref no confirmado o no exitoso");
  if (!Value.Check(CurrentSubjectSchema, current) || current.repo !== request.repo || current.pr !== request.pr || current.headSha !== request.headSha || current.baseSha !== request.baseSha) return unknown("HEAD/base/PR cambiaron; el recibo no acredita contenido actual");
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return unknown("Falta el artefacto de review");
  if (Buffer.byteLength(raw) > MAX_REVIEW_ARTIFACT_BYTES) return unknown("Artefacto demasiado grande/incompleto");
  const value: unknown = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!Value.Check(GhaReviewArtifactSchema, value)) return unknown("Contrato omi-review-v1 incompleto/futuro");
  if (value.repo !== request.repo || value.pr !== request.pr || value.headSha !== request.headSha || value.baseSha !== request.baseSha || value.correlationId !== request.correlationId
   || value.workflowSha !== request.workflow.sha || value.runId !== observedRun.id || value.runAttempt !== observedRun.run_attempt) return unknown("Identidad del artefacto ajena al run/attempt/PR/SHA/correlación");
  const receipt = structuredClone(value); const findings = uniqueReviewFindings(receipt.findings);
  if (!findings.valid || !receipt.materialComplete || receipt.state !== "complete" || receipt.verdict === "unknown" || receipt.verdict === "findings" && !receipt.findings.length) return unknown("Review incompleta/error/desconocida; no hay fallback local", receipt);
  receipt.findings = findings.findings;
  return { status: receipt.findings.length ? "findings" : "pass", receipt, reason: "" };
 } catch { return unknown("No se pudo validar el artefacto; no acredita revisión"); }
}
export interface GhaReviewPorts {
 runner?: Runner; timeoutSeconds: number; now: () => number; wait: (milliseconds: number, signal: AbortSignal) => Promise<void>; signal: AbortSignal;
 beforeDispatch?: (request: GhaReviewRequest) => Promise<void>;
 recordRequest?: (request: GhaReviewRequest) => Promise<void>;
 listRuns: (signal: AbortSignal) => Promise<unknown>; loadArtifact: (run: GhaRun, request: GhaReviewRequest, signal: AbortSignal) => Promise<unknown>; currentSubject: (signal: AbortSignal) => Promise<unknown>;
}
/** Sólo lecturas y polling. No consume una reserva por consulta ni redispacha tras resultados inciertos. */
export async function observeGhaReview(input: unknown, ports: GhaReviewPorts): Promise<GhaReviewResult> {
 const controller = new AbortController(); let signal = ports.signal; let deadline = Infinity;
 try {
  const request = checkedGhaRequest(input);
  if (!Number.isInteger(ports.timeoutSeconds) || ports.timeoutSeconds < 60 || ports.timeoutSeconds > 7200) return unknown("Timeout de review inválido");
  deadline = ports.now() + ports.timeoutSeconds * 1000;
  signal = AbortSignal.any([ports.signal, controller.signal, AbortSignal.timeout(ports.timeoutSeconds * 1000)]);
  const withinDeadline = () => { if (ports.now() >= deadline) controller.abort(); signal.throwIfAborted(); };
  while (ports.now() < deadline) {
   withinDeadline(); const candidates = await ports.listRuns(signal); withinDeadline();
   const selected = selectCorrelatedReviewRun(request, candidates);
   if (selected.status === "unknown" && selected.reason !== "missing") return unknown("Correlación duplicada, truncada o de workflow/ref ajeno");
   if (selected.status === "found" && selected.run.status === "completed") {
    const artifact = await ports.loadArtifact(selected.run, request, signal); withinDeadline();
    const current = await ports.currentSubject(signal); withinDeadline();
    const result = validateGhaReview(request, selected.run, artifact, current); withinDeadline(); return result;
   }
   await ports.wait(Math.min(1000, deadline - ports.now()), signal); withinDeadline();
  }
  return unknown("Timeout esperando correlación/artefacto; observar, no redisparar");
 } catch { return unknown(signal.aborted || ports.now() >= deadline ? "Timeout/cancelación de review; observar, no redisparar" : "Lectura GHA incompleta/cancelada; no acredita revisión ni permite replay"); }
 finally { controller.abort(); }
}
/** Sólo desde el callback vivo que obtuvo pending en el store. No es una acción declarativa del modelo. */
export async function startGhaReview(original: unknown, input: unknown, ports: GhaReviewPorts): Promise<GhaReviewResult> {
 const state = parseWorkflow(JSON.stringify(original)); const request = checkedGhaRequest(input);
 lifecycleAssert(state.lifecycle.status === "enabled" && state.status === "active" && state.lifecycle.stage === "review", "no hay review activa");
 const lifecycle = state.lifecycle;
 const op = lifecycle.operations.find(o => o.kind === "review" && o.correlationId === request.correlationId);
 lifecycleAssert(op?.status === "pending" && op.subjectId === lifecycle.currentSubject && op.configHash === lifecycle.pinHash, "falta reserva pending vigente");
 lifecycleAssert(!op.providerRequest, "request ya reservado/fijado; sólo observar la correlación, nunca redispatch");
 const pin = lifecycle.pins.find(p => p.accepted.blockHash === lifecycle.pinHash); const provider = pin?.accepted.block.review.provider;
 lifecycleAssert(pin && provider?.kind === "gha" && provider.workflow.replace(/^\.github\/workflows\//, "") === request.workflow.path.split("/").at(-1) && provider.ref === request.workflow.ref && request.repo === lifecycle.root.repo, "workflow/ref/repo no configurado para esta operación");
 const decision = lifecycle.decisions.find(d => d.id === op.decisionId);
 lifecycleAssert(decision, "falta decisión host");
 // Restricción inalterable de ESTE repo; ni recipe:auto ni review:auto conceden este permiso.
 lifecycleAssert(request.repo !== "chichex/omi-code" || decision.source === "person", "omi-code exige confirmación humana/persona para dispatch");
 lifecycleAssert(typeof ports.beforeDispatch === "function", "falta gate host vivo antes del dispatch");
 await ports.beforeDispatch(request); ports.signal.throwIfAborted();
 lifecycleAssert(Number.isInteger(ports.timeoutSeconds) && ports.timeoutSeconds >= 60 && ports.timeoutSeconds <= 7200, "timeout de review inválido antes de dispatch");
 const scoped = { ...ports, signal: AbortSignal.any([ports.signal, AbortSignal.timeout(Math.min(ports.timeoutSeconds, pin.accepted.block.review.timeoutSeconds) * 1000)]) };
 const current = await scoped.currentSubject(scoped.signal); scoped.signal.throwIfAborted();
 lifecycleAssert(Value.Check(CurrentSubjectSchema, current) && current.repo === request.repo && current.pr === request.pr && current.headSha === request.headSha && current.baseSha === request.baseSha, "cambió el PR antes de dispatch");
 const subject = lifecycle.subjects.find(s => s.id === op.subjectId);
 lifecycleAssert(subject?.number === request.pr && subject.headSha === request.headSha && subject.baseSha === request.baseSha, "sujeto ajeno al dispatch");
 lifecycleAssert(typeof ports.recordRequest === "function", "falta persistencia host del request antes de dispatch");
 await ports.recordRequest(request); scoped.signal.throwIfAborted();
 try {
  await (ports.runner ?? boundedGitHubRunner).run("gh", ["workflow", "run", String(request.workflow.id), "--repo", request.repo, "--ref", request.workflow.ref,
   "-f", `pr=${request.pr}`, "-f", `expected_head_sha=${request.headSha}`, "-f", `correlation_id=${request.correlationId}`], { cwd: state.checkout.root, signal: scoped.signal, env: { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
 } catch { /* Pudo dispararse: no se repite ni se pierde la correlación de la reserva. */ }
 return observeGhaReview(request, { ...scoped, timeoutSeconds: Math.min(ports.timeoutSeconds, pin.accepted.block.review.timeoutSeconds) });
}
