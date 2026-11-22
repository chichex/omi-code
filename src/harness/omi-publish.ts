// Publicación del commit integrado desde checkout privado; jamás HEAD móvil ni secretos en recibos.
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { enforce } from "../guardrails/policy.ts";
import { readSecretValue } from "../tools/secrets.ts";
import { CI_REGISTRY_SECRET } from "../protocol/constants.ts";
import { publishByTag, publishDirect } from "../publish/modes.ts";
import { registryProvenance, assertRegistryIdentity } from "../publish/registry-provenance.ts";
import { assertVersion, tagFor } from "../publish/version.ts";
import { assertCleanTree, assertServiceContract, assertWorkflow, runChecked } from "../publish/preflight.ts";
import { omiShipContext, omiRequest, type OmiShipDeps } from "./omi-ship-context.ts";
import { assertOmiPending, claimOmi } from "./omi-operation.ts";
import { publicationCheckout } from "./publication-checkout.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { dataHash } from "./lifecycle-value.ts";
import type { PublicationFact } from "./omi-ship-schema.ts";
import type { Runner } from "../core/exec.ts";
async function inside(root: string, path: string): Promise<string> {
 const resolved = await realpath(path), rel = relative(await realpath(root), resolved);
 lifecycleAssert(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"), "ruta de publicación escapa del checkout fijado"); return resolved;
}
function boundedRunner(runner: Runner, signal: AbortSignal): Runner {
 return { run: async (command, args, options = {}) => {
  lifecycleAssert(["git", "docker", "regctl"].includes(command), "comando fuera del transporte fijo de publicación"); signal.throwIfAborted();
  const result = await runner.run(command, args, { ...options, signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]), maxOutputBytes: 1048576, env: { ...options.env, ...(command === "git" ? { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_TERMINAL_PROMPT: "0" } : {}) } });
  lifecycleAssert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1048576, "salida de publicación incompleta/excesiva"); return result;
 } };
}
export async function publishOmiVersion(original: unknown, operationId: string, deps: OmiShipDeps): Promise<{ state: "published" | "unknown"; receipt: PublicationFact | null; reason: string }> {
 assertVersion(deps.version); const c = await omiShipContext(original, operationId, deps); assertOmiPending(c, "publish");
 lifecycleAssert(c.provider.mode === "direct" || c.provider.mode === "tag", "mecanismo de publicación OMI no configurado");
 lifecycleAssert(!c.view.versions.some(v => v.tag === deps.version), "no sobrescribir versión OMI existente");
 const request = omiRequest(c, c.provider.mode === "tag" ? "publish-tag" : "publish-direct", deps.version);
 const kit = c.view.kit;
 assertRegistryIdentity(kit); lifecycleAssert(!!kit.push_username, "registry sin usuario identificado");
 await enforce({ operation: "publish", summary: `Publicar ${c.service.name} ${deps.version} desde merge ${c.integratedSha}`, diff: `${c.scope.link.organizationSlug}/${c.scope.link.projectSlug} · ${c.provider.mode} · checkout separado` }, deps.runtime.guard);
 await deps.beforeMutation(request); c.signal.throwIfAborted();
 const fresh = await omiShipContext(original, operationId, { ...deps, signal: c.signal }); lifecycleAssert(dataHash(fresh.destination) === dataHash(c.destination) && dataHash(fresh.view.kit) === dataHash(c.view.kit) && !fresh.view.versions.some(v => v.tag === deps.version), "destino/kit/versión cambió durante permiso");
 await claimOmi(original, operationId, request, deps);
 const runner = boundedRunner(deps.runtime.runner, c.signal); let fixed: Awaited<ReturnType<typeof publicationCheckout>> | undefined;
 try {
  fixed = await (deps.fixedCheckout ? deps.fixedCheckout(c.integratedSha, c.signal) : publicationCheckout(c.state, c.integratedSha, runner, c.signal));
  lifecycleAssert(fixed.commitSha === c.integratedSha && await realpath(fixed.root) !== await realpath(deps.runtime.io.cwd), "no publicar worktree original ni SHA móvil");
  // El vínculo local puede ser ignorado por Git; si el snapshot trae otro, no se adopta por inferencia.
  try { const linkPath = await inside(fixed.root, join(fixed.root, ".omi/project.json")); const link: unknown = JSON.parse(await readFile(linkPath, "utf8")); lifecycleAssert(dataHash(link) === c.destination.linkHash, "snapshot cambia vínculo OMI"); } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  await inside(fixed.root, join(fixed.root, c.service.path)); await inside(fixed.root, join(fixed.root, c.service.path, c.service.dockerfile));
  await assertCleanTree(fixed.root, runner); await assertServiceContract(fixed.root, c.service, runner);
  lifecycleAssert((await runChecked(runner, "git", ["rev-parse", "HEAD"], { cwd: fixed.root })).stdout.trim() === c.integratedSha, "snapshot cambió de SHA");
  const fromEnv = deps.runtime.io.env[CI_REGISTRY_SECRET] === undefined ? undefined : CI_REGISTRY_SECRET;
  const password = await readSecretValue(CI_REGISTRY_SECRET, fromEnv, deps.runtime);
  let published: { version: string; commitSha: string; image: string; digest: string };
  if (c.provider.mode === "direct") published = await publishDirect({ root: fixed.root, service: c.service, version: deps.version, kit, password, runner, signal: c.signal, captureProvenance: true, expectedCommit: c.integratedSha, beforeImport: () => deps.beforeMutation(request) });
  else {
   await assertWorkflow(fixed.root, c.service); await publishByTag(fixed.root, tagFor(c.service.name, deps.version, c.scope.link.services.length > 1), runner, c.integratedSha);
   const home = await mkdtemp(join(tmpdir(), "omi-publication-observe-"));
   try {
    const env = { HOME: home };
    await runChecked(runner, "regctl", ["registry", "login", kit.registry_hostname, "--user", kit.push_username, "--pass-stdin"], { env, input: password });
    // CI puede no haber publicado aún: sólo repetir lecturas, nunca tag/push/build.
    for (;;) { try { published = await registryProvenance(kit, deps.version, c.integratedSha, runner, env, c.signal); break; } catch { c.signal.throwIfAborted(); await c.scope.client.wait(c.signal, 5000); } }
   } finally { await rm(home, { recursive: true, force: true }); }
  }
  const receipt: PublicationFact = { version: published.version, commitSha: published.commitSha, image: published.image, digest: published.digest, id: `publication:${c.op.id}`, operationId: c.op.id, subjectId: c.sub.id, targetId: c.target.id, configHash: c.op.configHash, destination: c.destination, via: c.provider.mode, at: new Date().toISOString() };
  return { state: "published", receipt, reason: "Registry digest y labels OCI del SHA integrado observados; aún no entrega/deploy" };
 } catch { return { state: "unknown", receipt: null, reason: "Publicación incierta/incompleta: conservar request/recibos; observar sin repetir tag/build/import" }; }
 finally { await fixed?.release(); }
}
