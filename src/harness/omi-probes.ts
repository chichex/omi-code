// Probes relativos al hostname informado por OMI; sin Bearer API ni redirecciones a otros destinos.
import type { OmiShipContext, OmiShipDeps } from "./omi-ship-context.ts";
import type { ShipProbes } from "./ship-schema.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { withinSignal } from "./host-deadline.ts";
async function json(response: Response): Promise<unknown> {
 const reader = response.body?.getReader(); if (!reader) throw new Error("version sin body"); const parts: Uint8Array[] = []; let size = 0;
 try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error("version demasiado grande"); parts.push(part.value); } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); }
 finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function field(value: unknown, path: string): unknown {
 let current = value;
 for (const name of path.split(".")) { if (!current || typeof current !== "object" || !Object.hasOwn(current, name) || ["__proto__", "prototype", "constructor"].includes(name)) return undefined; current = Reflect.get(current, name); }
 return current;
}
export async function probeOmi(c: OmiShipContext, deps: OmiShipDeps) {
 const evidence = c.target.evidence; lifecycleAssert(evidence.kind === "omi", "evidencia OMI no configurada");
 const origin = new URL(`https://${c.environment.hostname}`); lifecycleAssert(origin.hostname && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "hostname OMI no identificado");
 const probe = async (path: string) => {
  lifecycleAssert(path.startsWith("/") && !path.startsWith("//") && !path.split("/").some(p => p === "." || p === ".."), "path probe no relativo al destino"); const url = new URL(path, origin);
  lifecycleAssert(url.origin === origin.origin && url.pathname === path, "probe fuera del destino identificado");
  c.signal.throwIfAborted(); return withinSignal((deps.fetch ?? fetch)(url, { method: "GET", redirect: "manual", signal: c.signal }), c.signal);
 };
 const probes: ShipProbes = { health: "not-configured", version: "not-configured" }; let commit: string | null = null, version: string | null = null;
 if (evidence.health) { try { const response = await probe(evidence.health.path); probes.health = response.status === evidence.health.status ? "pass" : response.status === 404 ? "unknown" : "fail"; void response.body?.cancel().catch(() => {}); } catch { probes.health = "unknown"; } }
 if (evidence.version) {
  try {
   const response = await probe(evidence.version.path); if (response.status !== 200) probes.version = response.status === 404 ? "unknown" : "fail";
   else { const body = await withinSignal(json(response), c.signal), actual = field(body, evidence.version.versionField), rev = evidence.version.commitField ? field(body, evidence.version.commitField) : undefined;
    version = typeof actual === "string" ? actual : null; commit = typeof rev === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(rev) ? rev : null;
    probes.version = version === null ? "unknown" : version !== deps.version ? "fail" : evidence.version.commitField && !commit ? "unknown" : commit && commit !== c.integratedSha ? "fail" : "pass";
   }
  } catch { probes.version = "unknown"; }
 }
 c.signal.throwIfAborted(); return { probes, commit, version, hostname: origin.hostname };
}
