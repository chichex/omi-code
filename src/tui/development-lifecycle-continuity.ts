// Continuidad sólo en fronteras explícitas del host; cargar/restaurar jamás llama este ejecutor.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import { lifecycleHash } from "../harness/lifecycle-config.ts";
import { selectLifecycleContinuation } from "../harness/lifecycle-continuity.ts";
import type { LifecycleConfig } from "../harness/lifecycle-schema.ts";
import { acceptedPin, adoptLifecycle, freshPin, landLifecycle, LifecycleDeclined, reviewLifecycle, type ObservedLifecycleReview } from "./development-lifecycle.ts";
import { shipLifecycle } from "./development-lifecycle-ship.ts";
import { fixLifecycle } from "./development-lifecycle-fix.ts";
import type { DevelopmentSession } from "./development-session.ts";

/** Un cerrojo por sesión, sin timers, callbacks de onChange ni reconstrucción de hechos desde recibos. */
export class LifecycleContinuityHost {
 private running = false;
 private readonly session: DevelopmentSession;
 constructor(session: DevelopmentSession) { this.session = session; }
 async publication(ctx: ExtensionContext): Promise<void> {
  const state = this.session.current(ctx);
  if (state.version !== 2 || state.publication.status !== "opened" || state.lifecycle.status !== "disabled") return;
  // Capturado en la misma llamada a publish, nunca obtenido de un evento restore.
  const publication = { head: state.publication.head, number: state.publication.number, revision: state.revision };
  await this.run(ctx, "publication-confirmed", null, publication);
 }
 async advance(ctx: ExtensionContext, observed: ObservedLifecycleReview | null = null): Promise<void> {
  await this.run(ctx, "advance", observed);
 }
 private async pause(ctx: ExtensionContext, reason: string): Promise<void> {
  this.session.turnYielded = true;
  const activity = `Continuidad en pausa: ${reason}`.slice(0, 1000);
  await this.session.update(ctx, saved => ({ ...saved, activity }));
  ctx.ui.notify(activity, "info");
 }
 private async run(ctx: ExtensionContext, trigger: "publication-confirmed" | "advance", observed: ObservedLifecycleReview | null,
  publication?: { head: string; number: number; revision: number }): Promise<void> {
  if (this.running) return;
  this.running = true;
  const origin = this.session.observationOrigin();
  const signal = this.session.lifecycle.signal;
  const assertCurrent = () => {
   signal.throwIfAborted(); ctx.signal?.throwIfAborted();
   const current = this.session.observationOrigin();
   if (!origin || current?.epoch !== origin.epoch || current.id !== origin.id) throw new Error("La sesión cambió; continuidad pendiente descartada.");
  };
  try {
   let config: LifecycleConfig | null = null;
   let state = this.session.current(ctx);
   if (state.version !== 2) return;
   if (state.lifecycle.status === "disabled") {
    if (!publication || this.session.offline) return;
    // Una configuración ausente, pendiente o caída conserva el final legacy en draft.
    try { config = (await acceptedPin(this.session, state)).accepted.block; }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Continuidad no disponible", "info"); return; }
   } else config = currentLifecyclePin(state.lifecycle).accepted.block;
   if (!config?.continuity) return;
   const actions = new Set<string>();
   for (;;) {
    signal.throwIfAborted(); ctx.signal?.throwIfAborted();
    const currentOrigin = this.session.observationOrigin();
    if (!origin || currentOrigin?.epoch !== origin.epoch || currentOrigin.id !== origin.id) return;
    state = this.session.current(ctx);
    if (state.version === 2 && state.lifecycle.status === "enabled") {
     await freshPin(this.session, ctx);
     state = this.session.current(ctx);
    }
    assertCurrent();
    const selection = selectLifecycleContinuation({ workflow: state, config, trigger, reviewObserved: observed });
    if (selection.kind === "complete" || selection.kind === "yield") return;
    if (selection.kind === "pause") { await this.pause(ctx, `${selection.reason}${selection.stage ? ` · ${selection.stage}` : ""}`); return; }
    const key = `${selection.action}:${state.version === 2 && state.lifecycle.status === "enabled" ? state.lifecycle.currentSubject : publication?.head}`;
    if (actions.has(key)) { await this.pause(ctx, "sin progreso confirmado; no se repite el efecto"); return; }
    actions.add(key);
    if (selection.mode === "ask") {
     const approved = await this.session.confirm(ctx, `Continuidad · ${selection.stage}`, `Continuar con ${selection.action}. Esto no autoriza sus efectos: conservan sus permisos independientes.`);
     if (!approved) { await this.pause(ctx, "rechazada por la persona"); return; }
     await this.session.assertUnchanged(state, ctx);
    }
    assertCurrent();
    if (selection.action === "adopt") {
     if (!publication || !config || !(await adoptLifecycle(this.session, ctx, { ...publication, pinHash: lifecycleHash(config) }))) { await this.pause(ctx, "adopción rechazada"); return; }
    } else if (selection.action === "fix") {
     if (await fixLifecycle(this.session, ctx, { source: "chain" })) return; // El turno del modelo hace TDD y todos los D.
    } else if (selection.action === "review") observed = await reviewLifecycle(this.session, ctx);
    else if (selection.action === "land") {
     if (!(await landLifecycle(this.session, ctx))) { await this.pause(ctx, "merge rechazado por la persona"); return; }
    } else await shipLifecycle(this.session, ctx);
    trigger = "advance";
   }
  } catch (error) {
   // Nunca reintentar: incluso un error puede representar un efecto remoto incierto.
   if (!signal.aborted && this.session.observationOrigin()?.epoch === origin?.epoch) {
    await this.pause(ctx, error instanceof LifecycleDeclined ? error.message : error instanceof Error ? error.message : "operación interrumpida o incierta");
   }
  } finally { this.running = false; }
 }
}
