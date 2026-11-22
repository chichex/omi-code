// Coordinación interna host: actividad durable → autorización → reserva → una invocación → recibo.
// No se registra como tool ni acepta ejecutores desde las perillas o desde el modelo.
import { Value } from "typebox/value";
import { readWorkflow, updateWorkflow } from "./store.ts";
import type { Workflow, WorkflowV2 } from "./model.ts";
import { IntentSchema, type LifecycleIntent } from "./lifecycle-state-schema.ts";
import { reserveLifecycleOperation, beginLifecycleActivity, checkpointLifecycleActivity, confirmLifecycleOperation, markLifecycleUnknown } from "./lifecycle-state.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
export interface LifecycleActivityControls { setMode: (mode: "active" | "human-wait") => Promise<void> }
export interface LifecycleOperationDeps {
 checkout: Workflow["checkout"]; issue: number; owner: string; now: () => string; monotonic: () => number; signal?: AbortSignal;
 /** Relee configuración, HEAD y reglas/permisos. Persiste human-wait antes de preguntar. */
 authorize: (state: WorkflowV2, intent: LifecycleIntent, activity: LifecycleActivityControls) => Promise<unknown>;
 /** Proveedor acotado a kind/sujeto/destino, nunca shell ni tool arbitraria. */
 execute: (state: WorkflowV2, intent: LifecycleIntent, activity: LifecycleActivityControls) => Promise<unknown>;
 persist?: typeof updateWorkflow;
}
export async function performLifecycleOperation(deps: LifecycleOperationDeps, input: unknown): Promise<WorkflowV2> {
 lifecycleAssert(Value.Check(IntentSchema, input), "intención host inválida"); const intent = structuredClone(input);
 const persist = deps.persist ?? updateWorkflow; deps.signal?.throwIfAborted();
 const start = deps.monotonic(); lifecycleAssert(Number.isFinite(start), "reloj monotónico inválido");
 const elapsed = () => Math.floor(deps.monotonic() - start);
 const initial = await readWorkflow(deps.checkout, deps.issue);
 lifecycleAssert(initial?.lifecycle.status === "enabled" && initial.status === "active", "trabajo/lifecycle no activo");
 const workflowId = initial.id;
 const segmentId = `operation:${intent.id}`;
 // La autorización también trabaja. Aún no reserva un intento ni concede permiso de ejecutar.
 const started = await persist(deps.checkout, deps.issue, initial.revision, saved => {
  lifecycleAssert(saved?.version === 2 && saved.id === initial.id && saved.status === "active", "cambió el trabajo antes de autorizar");
  const lifecycle = checkpointLifecycleActivity(beginLifecycleActivity(saved.lifecycle, segmentId, deps.owner), segmentId, deps.owner, elapsed(), "active");
  return { ...saved, revision: saved.revision + 1, lifecycle };
 });
 lifecycleAssert(started.version === 2, "actividad no confirmada");
 let updates = Promise.resolve(); let activityFailed = false;
 function patch(mode?: "active" | "human-wait" | "closed"): Promise<WorkflowV2> {
  const update = updates.then(async () => {
   const current = await readWorkflow(deps.checkout, deps.issue);
   lifecycleAssert(current?.id === workflowId, "cambió el trabajo durante la actividad");
   const changed = await persist(deps.checkout, deps.issue, current.revision, saved => {
    lifecycleAssert(saved?.version === 2 && saved.id === workflowId && saved.lifecycle.status === "enabled", "cambió la actividad");
    const segment = saved.lifecycle.segments.find(s => s.id === segmentId); lifecycleAssert(segment, "actividad perdida");
    if (mode !== "closed") lifecycleAssert(saved.status === "active", "trabajo pausado durante la actividad");
    if (mode === undefined) lifecycleAssert(segment.mode === "active", "espera humana sin salida explícita");
    const lifecycle = checkpointLifecycleActivity(saved.lifecycle, segmentId, deps.owner, elapsed(), mode ?? "active");
    return { ...saved, revision: saved.revision + 1, lifecycle };
   });
   lifecycleAssert(changed.version === 2, "actividad incompatible"); return changed;
  });
  updates = update.then(() => {}, () => { activityFailed = true; }); return update;
 }
 const activity: LifecycleActivityControls = { async setMode(mode) { await patch(mode); } };
 let reserved: Workflow;
 try {
  const decision = await deps.authorize(started, intent, activity); await updates; deps.signal?.throwIfAborted();
  lifecycleAssert(!activityFailed, "no se confirmó la contabilidad de autorización");
  const authorized = await patch();
  // El presupuesto ya incluye las lecturas activas de autorización, sin cobrar espera humana.
  reserved = await persist(deps.checkout, deps.issue, authorized.revision, saved => {
   lifecycleAssert(saved?.version === 2 && saved.status === "active" && saved.id === initial.id, "el trabajo cambió durante la autorización");
   const lifecycle = reserveLifecycleOperation(saved.lifecycle, intent, decision, deps.owner, deps.now());
   return { ...saved, revision: saved.revision + 1, lifecycle };
  });
  deps.signal?.throwIfAborted();
 } catch (error) {
  // Puede existir un pending si persist alcanzó rename y falló después. Jamás lo ejecuta al recuperar.
  await patch("closed").catch(() => {}); throw error;
 }
 lifecycleAssert(reserved.version === 2 && reserved.lifecycle.status === "enabled", "reserva no confirmada");
 let observed: unknown; let uncertain = false;
 try { observed = await deps.execute(reserved, intent, activity); } catch { uncertain = true; }
 await updates; uncertain ||= activityFailed;
 // Releer tras callbacks/esperas para conservar hechos/config concurrentes; no repetir la operación.
 const current = await readWorkflow(deps.checkout, deps.issue); lifecycleAssert(current?.id === initial.id, "trabajo perdido antes del recibo");
 const completed = await persist(deps.checkout, deps.issue, current.revision, saved => {
  lifecycleAssert(saved?.version === 2 && saved.id === initial.id && saved.lifecycle.status === "enabled", "cambió el trabajo antes del recibo");
  let lifecycle = saved.lifecycle;
  try { lifecycle = confirmLifecycleOperation(lifecycle, observed); }
  catch {
   uncertain = true;
   if (lifecycle.operations.find(o => o.id === intent.id)?.status !== "confirmed") lifecycle = markLifecycleUnknown(lifecycle, intent.id, "Resultado incompleto o incierto: reconciliar antes de repetir", deps.now());
  }
  const segment = lifecycle.segments.find(s => s.id === segmentId); const duration = elapsed();
  if (segment?.mode !== "closed" && Number.isSafeInteger(duration) && duration >= (segment?.elapsedMilliseconds ?? 0)) lifecycle = checkpointLifecycleActivity(lifecycle, segmentId, deps.owner, duration, "closed");
  else if (!segment || segment.mode !== "closed") uncertain = true; // No se regala duración desconocida.
  return { ...saved, revision: saved.revision + 1, lifecycle };
 });
 if (uncertain) throw new Error(`Resultado o tiempo activo incierto de ${intent.id}; observar/reconciliar, no reejecutar`);
 lifecycleAssert(completed.version === 2, "estado incompatible después del recibo"); return completed;
}
