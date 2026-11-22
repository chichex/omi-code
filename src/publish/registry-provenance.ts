// Prueba observable del registry: fija digest antes de leer labels, no infiere SHA desde semver.
import type { Runner } from "../core/exec.ts";
import type { PublishKit } from "../project/kit.ts";
import { LABEL_REVISION, LABEL_VERSION } from "../protocol/constants.ts";
import { OmiError } from "../core/errors.ts";
import { runChecked } from "./preflight.ts";
export function assertRegistryIdentity(kit: PublishKit): void {
 const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(kit.registry_hostname);
 const validHost = match && match[1]!.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && (!match[2] || Number(match[2]) > 0 && Number(match[2]) <= 65535);
 const prefix = `${kit.registry_hostname}/`, path = kit.image.startsWith(prefix) ? kit.image.slice(prefix.length) : "";
 if (!validHost || !path || !path.split("/").every(part => /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/.test(part))) throw new OmiError("registry_identity_changed", "registry hostname no corresponde a la imagen identificada");
}
export async function registryProvenance(kit: PublishKit, version: string, expectedCommit: string, runner: Runner, env: Record<string, string>, signal?: AbortSignal) {
 assertRegistryIdentity(kit);
 const options = { env, ...(signal ? { signal } : {}) };
 const digest = (await runChecked(runner, "regctl", ["image", "digest", `${kit.image}:${version}`], options)).stdout.trim();
 if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new OmiError("publication_unverified", "registry no informó digest íntegro");
 const raw: unknown = JSON.parse((await runChecked(runner, "regctl", ["image", "config", `${kit.image}@${digest}`], options)).stdout);
 if (!raw || typeof raw !== "object" || !("config" in raw) || !raw.config || typeof raw.config !== "object" || !("Labels" in raw.config) || !raw.config.Labels || typeof raw.config.Labels !== "object") throw new OmiError("publication_unverified", "registry sin labels OCI verificables");
 if (Reflect.get(raw.config.Labels, LABEL_REVISION) !== expectedCommit || Reflect.get(raw.config.Labels, LABEL_VERSION) !== version) throw new OmiError("publication_unverified", "labels OCI no corresponden al commit/versión esperado");
 return { version, commitSha: expectedCommit, image: kit.image, digest };
}
