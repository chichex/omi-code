// Revalida el artefacto de una publicación anterior en el registry actual del mismo service.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretValue } from "../tools/secrets.ts";
import { CI_REGISTRY_SECRET } from "../protocol/constants.ts";
import { registryProvenance, assertRegistryIdentity } from "../publish/registry-provenance.ts";
import { runChecked } from "../publish/preflight.ts";
import type { Runner } from "../core/exec.ts";
import type { PublicationFact } from "./omi-ship-schema.ts";
import type { OmiShipContext, OmiShipDeps } from "./omi-ship-context.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
export async function revalidateOmiPublication(c: OmiShipContext, deps: OmiShipDeps, publication: PublicationFact): Promise<void> {
 lifecycleAssert(publication.image === c.view.kit.image && publication.destination.apiOrigin === c.destination.apiOrigin && publication.destination.projectPath === c.destination.projectPath && publication.destination.service === c.service.name && publication.version === deps.version && publication.commitSha === c.integratedSha, "publication de otra imagen/destino/SHA");
 assertRegistryIdentity(c.view.kit);
 const home = await mkdtemp(join(tmpdir(), "omi-registry-read-"));
 const runner: Runner = { run: async (command, args, options = {}) => {
  lifecycleAssert(command === "regctl", "sólo lectura OCI y login efímero");
  const result = await deps.runtime.runner.run(command, args, { ...options, signal: c.signal, maxOutputBytes: 1048576 }); lifecycleAssert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1048576, "registry salida incompleta"); return result;
 } };
 try {
  const fromEnv = deps.runtime.io.env[CI_REGISTRY_SECRET] === undefined ? undefined : CI_REGISTRY_SECRET;
  const password = await readSecretValue(CI_REGISTRY_SECRET, fromEnv, deps.runtime), env = { HOME: home };
  await runChecked(runner, "regctl", ["registry", "login", c.view.kit.registry_hostname, "--user", c.view.kit.push_username, "--pass-stdin"], { env, input: password });
  const actual = await registryProvenance(c.view.kit, publication.version, publication.commitSha, runner, env, c.signal);
  lifecycleAssert(actual.digest === publication.digest, "el tag de versión ya no resuelve al digest publicado");
 } finally { await rm(home, { recursive: true, force: true }); }
}
