// Adaptador del workflow fuerte. Se ejecuta desde el checkout confiable, nunca desde el árbol del PR.
import { constants } from "node:fs";
import { mkdir, open, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ReviewMetadataSchema, buildReviewArtifact, parseReviewDispatchInputs, type GhaReviewArtifact } from "../src/harness/gha-review-contract.ts";
import { GitHubReadClient } from "../src/harness/lifecycle-github-read.ts";
import { PullSchema, githubChecked } from "../src/harness/lifecycle-github-schema.ts";
import { lifecycleRef } from "../src/harness/lifecycle-config.ts";
import { runReadonlyGhaReview } from "./review-runner.ts";
import { fixedReviewMaterial, readReviewGit as git, MAX_REVIEW_MATERIAL_BYTES } from "../src/harness/review-material.ts";
export { MAX_REVIEW_MATERIAL_BYTES } from "../src/harness/review-material.ts";
const { baseSha: _base, diffBaseSha: _diff, materialHash: _hash, materialComplete: _complete, fileCount: _count, ...ContextFields } = ReviewMetadataSchema.properties;
const ContextSchema = Type.Object(ContextFields, { additionalProperties: false });
const InspectionSchema = Type.Object({ ...ContextFields, baseSha: ReviewMetadataSchema.properties.baseSha, headBranch: Type.String({ minLength: 1, maxLength: 128 }), baseBranch: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
export type ReviewInspection = Static<typeof InspectionSchema>;
function fail(message: string): never { throw new Error(message); }
export async function inspectReviewSubject(context: unknown, readPull: () => Promise<unknown>): Promise<ReviewInspection> {
 if (!Value.Check(ContextSchema, context)) fail("Metadata de workflow inválida");
 const pull = githubChecked(PullSchema, await readPull());
 if (pull.number !== context.pr || pull.head.sha !== context.headSha || pull.base.repo.full_name.toLowerCase() !== context.repo || pull.state !== "open" || pull.merged || !lifecycleRef(pull.head.ref) || !lifecycleRef(pull.base.ref)) fail("PR/HEAD/base ajenos o no vigentes");
 return { ...context, baseSha: pull.base.sha, headBranch: pull.head.ref, baseBranch: pull.base.ref };
}
export async function prepareReviewMaterial(options: { trustedRoot: string; prRoot: string; inspection: unknown }): Promise<{ metadata: Static<typeof ReviewMetadataSchema>; prompt: string }> {
 if (!isAbsolute(options.trustedRoot) || !isAbsolute(options.prRoot) || resolve(options.trustedRoot) === resolve(options.prRoot) || !Value.Check(InspectionSchema, options.inspection)) fail("Checkouts/inspección de review inválidos");
 const inspection = options.inspection;
 if ((await git(options.trustedRoot, ["rev-parse", "HEAD"])).trim() !== inspection.workflowSha || (await git(options.prRoot, ["rev-parse", "HEAD"])).trim() !== inspection.headSha) fail("Checkout confiable o PR cambió de SHA");
 const material = await fixedReviewMaterial(options.prRoot, { repo: inspection.repo, pr: inspection.pr, headSha: inspection.headSha, baseSha: inspection.baseSha, correlationId: inspection.correlationId });
 const { headBranch: _headBranch, baseBranch: _baseBranch, ...metadata } = inspection;
 return { metadata: { ...metadata, diffBaseSha: material.diffBaseSha, materialHash: material.materialHash, materialComplete: material.complete, fileCount: material.fileCount }, prompt: material.prompt };
}
async function privateJson(path: string, value: unknown): Promise<void> {
 const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
 try { const entry = await file.stat(); if (!entry.isFile() || entry.nlink !== 1) fail("Archivo de review inseguro"); await file.chmod(0o600); await file.truncate(0); await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
async function readJson(path: string): Promise<unknown> {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try { const entry = await file.stat(); if (!entry.isFile() || entry.nlink !== 1 || entry.size > 8 * 1024 * 1024) fail("Archivo de review inseguro/grande"); return JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
}
async function main(): Promise<void> {
 const env = process.env; const trustedRoot = process.cwd(); const prRoot = join(trustedRoot, ".omi-review-pr");
 const inputs = parseReviewDispatchInputs({ pr: env.PR ?? "", expected_head_sha: env.EXPECTED_HEAD_SHA ?? "", correlation_id: env.CORRELATION_ID ?? "", model: env.REVIEW_MODEL ?? "claude-opus-5-5", effort: env.REVIEW_EFFORT ?? "xhigh" });
 if (inputs.kind !== "strong") fail("Este adaptador sólo produce evidencia fuerte; legacy usa su ruta manual");
 const directory = env.REVIEW_DIRECTORY; if (!directory || !isAbsolute(directory)) fail("Falta directorio privado de review");
 await mkdir(directory, { recursive: true, mode: 0o700 });
 const inspectionPath = join(directory, "inspection.json"), metadataPath = join(directory, "metadata.json"), promptPath = join(directory, "prompt.json"), resultPath = join(directory, "result.json");
 const client = new GitHubReadClient({ repo: (env.GITHUB_REPOSITORY ?? "").toLowerCase(), cwd: trustedRoot }); const signal = AbortSignal.timeout(1200000);
 const readPull = () => client.json(`repos/${client.repo}/pulls/${inputs.pr}`, signal);
 const mode = process.argv[2];
 if (mode === "inspect") {
  const context = { repo: client.repo, pr: inputs.pr, headSha: inputs.headSha, correlationId: inputs.correlationId, workflowSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
  if (!Value.Check(ContextSchema, context) || (await git(trustedRoot, ["rev-parse", "HEAD"])).trim() !== context.workflowSha) fail("Producer no pertenece al SHA del workflow");
  await privateJson(inspectionPath, await inspectReviewSubject(context, readPull));
 } else if (mode === "prepare") {
  const material = await prepareReviewMaterial({ trustedRoot, prRoot, inspection: await readJson(inspectionPath) });
  await privateJson(metadataPath, material.metadata);
  if (material.metadata.materialComplete) await writeFile(promptPath, material.prompt, { mode: 0o600, flag: "wx" });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `complete=${material.metadata.materialComplete}\n`);
 } else if (mode === "review") {
  const metadata = await readJson(metadataPath); if (!Value.Check(ReviewMetadataSchema, metadata) || !metadata.materialComplete) fail("Material no revisable íntegramente");
  const file = await open(promptPath, constants.O_RDONLY | constants.O_NOFOLLOW); let material: string;
  try { const entry = await file.stat(); if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_REVIEW_MATERIAL_BYTES) fail("Prompt inseguro o grande"); material = await file.readFile("utf8"); } finally { await file.close(); }
  if (createHash("sha256").update(material).digest("hex") !== metadata.materialHash) fail("Cambió el material preparado");
  const effort = env.REVIEW_EFFORT ?? "xhigh"; if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) fail("Effort inválido");
  const result = await runReadonlyGhaReview({ material, cwd: trustedRoot, model: env.REVIEW_MODEL ?? "claude-opus-5-5", effort: effort === "low" || effort === "medium" || effort === "high" || effort === "max" ? effort : "xhigh", env, signal });
  await privateJson(resultPath, result); if (result.conclusion !== "success") process.exitCode = 1;
 } else if (mode === "finish") {
  const metadata = await readJson(metadataPath); if (!Value.Check(ReviewMetadataSchema, metadata)) fail("No se pudo confirmar metadata completa");
  let result: unknown; try { result = await readJson(resultPath); } catch { result = null; }
  const ResultSchema = Type.Object({ conclusion: Type.Enum(["success", "failure"]), structuredOutput: Type.String() });
  let conclusion = Value.Check(ResultSchema, result) ? result.conclusion : "failure";
  try {
   const pull = githubChecked(PullSchema, await readPull());
   if (pull.head.sha !== metadata.headSha || pull.base.sha !== metadata.baseSha || pull.number !== metadata.pr || pull.base.repo.full_name.toLowerCase() !== metadata.repo || pull.state !== "open" || pull.merged
    || (await git(trustedRoot, ["rev-parse", "HEAD"])).trim() !== metadata.workflowSha || (await git(prRoot, ["rev-parse", "HEAD"])).trim() !== metadata.headSha) conclusion = "failure";
  } catch { conclusion = "failure"; }
  const receipt: GhaReviewArtifact = buildReviewArtifact(metadata, Value.Check(ResultSchema, result) ? result.structuredOutput : "", conclusion);
  await privateJson(join(directory, "review.json"), receipt); if (receipt.state !== "complete") process.exitCode = 1;
 } else fail("Modo de review desconocido");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Review fuerte incompleta: no acredita aprobación. Revisar metadata/run sin repetir efectos."); process.exitCode = 1; });
