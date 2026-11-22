// Recibos seleccionados del host: no persistir API bodies, errores, kit, entorno ni stdin.
import { Value } from "typebox/value";
import { parseWorkflow } from "./model.ts";
import { PublicationFactSchema } from "./omi-ship-schema.ts";
import { sameData } from "./lifecycle-value.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
import { confirmLifecycleOperation } from "./lifecycle-state.ts";
export function recordOmiPublication(original: unknown, operationId: string, receipt: unknown, at: string) {
 const state = parseWorkflow(JSON.stringify(original)); lifecycleAssert(state.lifecycle.status === "enabled" && Value.Check(PublicationFactSchema, receipt), "recibo de publicación inválido");
 const s = state.lifecycle, op = s.operations.find(o => o.id === operationId), req = op?.shipRequest;
 lifecycleAssert(op?.kind === "publish" && req?.kind === "omi" && receipt.operationId === op.id && receipt.subjectId === op.subjectId && receipt.targetId === op.targetId && receipt.configHash === op.configHash && receipt.commitSha === req.integratedSha && receipt.version === req.version && sameData(receipt.destination, req.destination), "recibo de otra publicación/versión/destino");
 const previous = s.publications?.find(p => p.operationId === op.id); if (previous) { lifecycleAssert(sameData(previous, receipt), "recibo publicado no se reemplaza"); return state; }
 const changed = confirmLifecycleOperation(s, { operationId: op.id, correlationId: op.correlationId, subjectId: op.subjectId, targetId: op.targetId, verifiedSubjectId: op.subjectId, externalId: `${receipt.image}@${receipt.digest}`, outcome: "succeeded", at });
 changed.publications = [...(changed.publications ?? []), structuredClone(receipt)]; state.lifecycle = changed; state.revision++; state.activity = "Publicación OMI con origen observado; pendiente deploy/verificación de entrega"; return parseWorkflow(JSON.stringify(state));
}
