// API OMI no expone SHA en versiones/deployments: la prueba de origen viene del endpoint o publicación.
import { Value } from "typebox/value";
import { dataHash } from "./lifecycle-value.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { omiShipContext, type OmiShipDeps } from "./omi-ship-context.ts";
import { probeOmi } from "./omi-probes.ts";
import { revalidateOmiPublication } from "./omi-registry.ts";
import { OmiAttestationSchema, PublicationInputSchema, OmiOriginSchema } from "./omi-ship-schema.ts";
import { OmiShipProofSchema, type ShipVerification } from "./ship-schema.ts";
import { assertVersion } from "../publish/version.ts";
export async function verifyOmiShip(original: unknown, operationId: string, deps: OmiShipDeps): Promise<ShipVerification> {
 let checkpoint = "entrada/destino";
 try {
  assertVersion(deps.version); const c = await omiShipContext(original, operationId, deps); lifecycleAssert(c.op.kind === "ship" && c.target.evidence.kind === "omi", "sólo verificación Ship OMI");
  lifecycleAssert(c.environment.current_version === deps.version && c.view.versions.some(v => v.tag === deps.version), "current/versión publicada no coinciden");
  const deployment = c.environment.last_deployment;
  lifecycleAssert(deployment && deployment.service === c.service.name && deployment.environment === c.provider.environment && deployment.to_version === deps.version && deployment.status === "exitoso", "deployment ausente/fallido/rollback o de otro destino");
  checkpoint = "probes";
  const { probes, commit, hostname } = await probeOmi(c, deps);
  let origin: unknown;
  if (commit === c.integratedSha && c.target.evidence.version?.commitField) origin = { kind: "endpoint", commitSha: commit, field: c.target.evidence.version.commitField };
  else if (Value.Check(PublicationInputSchema, deps.publication) && deps.publication.kind === "publication") {
   const publication = deps.publication;
   const p = c.s.publications?.find(p => p.id === publication.id && p.version === deps.version && p.commitSha === c.integratedSha && p.destination.projectPath === c.destination.projectPath && p.destination.apiOrigin === c.destination.apiOrigin && p.destination.service === c.service.name);
   if (p) { await revalidateOmiPublication(c, deps, p); origin = { kind: "publication", commitSha: p.commitSha, publicationId: p.id, image: p.image, digest: p.digest }; }
  }
  if (!origin && Value.Check(OmiAttestationSchema, deps.attestation) && deps.attestation.subjectId === c.sub.id && deps.attestation.targetId === c.target.id && deps.attestation.integratedSha === c.integratedSha && deps.attestation.version === deps.version) origin = { kind: "attested", attestation: deps.attestation };
  checkpoint = "origen/atestiguación";
  lifecycleAssert(Value.Check(OmiOriginSchema, origin), "semver/deployment sin commit/provenance: requiere vínculo humano explícito, no origen demostrado");
  const proof = { kind: "omi", subjectId: c.sub.id, targetId: c.target.id, operationId: c.op.id, configHash: c.op.configHash, integratedSha: c.integratedSha, destination: c.destination, version: deps.version, deploymentId: deployment.id, hostnameHash: dataHash(hostname), origin, probes };
  checkpoint = "contrato de prueba";
  lifecycleAssert(Value.Check(OmiShipProofSchema, proof), "prueba OMI no comprobable");
  return { state: probes.health === "fail" || probes.version === "fail" ? "failed" : probes.health === "unknown" || probes.version === "unknown" ? "unknown" : "verified", proof, reason: origin.kind === "attested" ? "Vínculo humano atestiguado; no origen demostrado ni autonomía por SHA" : "Origen observado y health/version comprobados en destino identificado" };
 } catch { return { state: "unknown", proof: null, reason: `OMI ${checkpoint} incompleto; semver no prueba commit ni entrega` }; }
}
