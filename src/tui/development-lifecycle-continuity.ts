// Continuidad sólo en fronteras explícitas del host; cargar/restaurar jamás llama este ejecutor.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import { lifecycleHash } from "../harness/lifecycle-config.ts";
import { selectLifecycleContinuation, type ContinuitySelection, type ContinuityStage } from "../harness/lifecycle-continuity.ts";
import { firstEffectGate } from "../harness/lifecycle-continuity-gates.ts";
import { continuityPauseRecord, type PauseCause } from "../harness/continuity-pause.ts";
import { continuityPauseLine } from "../harness/continuity-pause-text.ts";
import type { Workflow } from "../harness/model.ts";
import type { LifecycleConfig } from "../harness/lifecycle-schema.ts";
import { acceptedPin, adoptLifecycle, freshPin, githubClient, landLifecycle, lifecycleRepo, LifecycleDeclined, OWN_REPO, readPull, reviewLifecycle, type ObservedLifecycleReview } from "./development-lifecycle.ts";
import { shipLifecycle } from "./development-lifecycle-ship.ts";
import { fixLifecycle, pushLifecycleCorrection } from "./development-lifecycle-fix.ts";
import { ChainConsent } from "./development-lifecycle-chain.ts";
import { offerSetupAfterPublication } from "./development-config-setup.ts";
import type { DevelopmentSession } from "./development-session.ts";

/** Un «manual» con un pin vigente sin continuity no lo eligió nadie: la quitó el pin fresco a mitad de cadena. */
function selectedPause(selection: Extract<ContinuitySelection, { kind: "pause" }>, state: Workflow): PauseCause {
 const disabled = selection.reason === "manual" && state.version === 2 && state.lifecycle.status === "enabled" && !currentLifecyclePin(state.lifecycle).accepted.block.continuity;
 return { reason: disabled ? "continuity-disabled" : selection.reason, stage: selection.stage };
}
type Chosen = Extract<ContinuitySelection, { kind: "action" }>;
/** go sin chain: continuidad auto, que no pregunta ni concede permisos. */
type Consent = { kind: "go"; chain: ChainConsent | undefined } | { kind: "declined" };
/** Un cerrojo por sesión, sin timers, callbacks de onChange ni reconstrucción de hechos desde recibos. */
export class LifecycleContinuityHost {
 private running = false;
 /** La última Review que ingirió esta sesión, sin restaurar en el medio. Efímera: restaurar o reabrir no la recrea.
  * El selector igual la valida contra la última Review confirmada del HEAD actual; no es aprobación de Land. */
 private observed: { review: ObservedLifecycleReview; epoch: number; id: string } | undefined;
 private readonly session: DevelopmentSession;
 constructor(session: DevelopmentSession) { this.session = session; }
 async publication(ctx: ExtensionContext): Promise<void> {
  if (this.session.current(ctx).version !== 2) return;
  // Limpiar cambia la revisión: va antes de capturar la que valida la adopción por publicación.
  await this.clearPause(ctx);
  const state = this.session.current(ctx);
  if (state.version !== 2 || state.publication.status !== "opened" || state.lifecycle.status !== "disabled") return;
  // Capturado en la misma llamada a publish, nunca obtenido de un evento restore.
  const publication = { head: state.publication.head, number: state.publication.number, revision: state.revision };
  await this.run(ctx, "publication-confirmed", null, publication);
  await offerSetupAfterPublication(this.session, ctx); // Sin lifecycle, pendiente o sin continuidad: ofrece el wizard; nunca adopta.
 }
 /** Sin `observed`, usa la Review que esta misma sesión ya ingirió: «Ya corregidos» no la vuelve a pedir. */
 async advance(ctx: ExtensionContext, observed: ObservedLifecycleReview | null = null): Promise<void> {
  this.remember(observed);
  await this.run(ctx, "advance", observed ?? this.recall());
 }
 private remember(review: ObservedLifecycleReview | null): void {
  const origin = this.session.observationOrigin();
  if (review && origin) this.observed = { review, epoch: origin.epoch, id: origin.id };
 }
 private recall(): ObservedLifecycleReview | null {
  const origin = this.session.observationOrigin(), saved = this.observed;
  return saved && origin?.epoch === saved.epoch && origin.id === saved.id ? saved.review : null;
 }
 /** Una corrida o un comando lifecycle nuevos son el próximo paso: el motivo de la pausa anterior ya no rige. */
 async clearPause(ctx: ExtensionContext): Promise<void> {
  const state = this.session.current(ctx);
  if (state.version !== 2 || !state.continuityPause) return;
  await this.session.update(ctx, ({ continuityPause: _previous, ...saved }) => saved);
 }
 private async pause(ctx: ExtensionContext, cause: PauseCause): Promise<void> {
  this.session.turnYielded = true;
  const saved = await this.session.update(ctx, current => ({ ...current, continuityPause: continuityPauseRecord(current, cause, this.session.now()) }));
  if (saved.continuityPause) ctx.ui.notify(continuityPauseLine(saved.continuityPause), "info");
 }
 /** Continuidad ask: un solo sí por etapa. Si el primer efecto ya pregunta, viaja en ese diálogo; si no, se pide acá.
  * Si la predicción falla, la etapa la pide antes del primer efecto que no pregunte (ChainConsent.ensure). */
 private async consent(ctx: ExtensionContext, state: Workflow, selection: Chosen, config: LifecycleConfig, pr: number | undefined): Promise<Consent> {
  if (selection.mode !== "ask" || state.version !== 2) return { kind: "go", chain: undefined };
  const chain = new ChainConsent(this.session, ctx, selection.action, pr);
  const pushPolicy = selection.action === "push" ? (await this.session.foundations.policy(ctx, state)).politica.push_pr : undefined;
  // Land auto: si una persona ya sacó el PR de draft, el primer efecto es el merge y no ready. Leerlo no es un efecto.
  const read = selection.action === "land" && config.land.mode === "auto" && pr !== undefined && !this.session.offline
   ? await readPull(githubClient(this.session, state), pr, this.session.lifecycle.signal) : undefined;
  const pull = read && { draft: read.draft, merged: read.merged };
  const gate = firstEffectGate({ action: selection.action, lifecycle: state.lifecycle, config, ownRepo: lifecycleRepo(state) === OWN_REPO, pushPolicy, pull });
  if (gate === "human") return { kind: "go", chain };
  if (!(await chain.ask(gate))) return { kind: "declined" };
  await this.session.assertUnchanged(state, ctx);
  return { kind: "go", chain };
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
  let stage: ContinuityStage | undefined;
  try {
   await this.clearPause(ctx);
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
    stage = undefined; // Un error antes de elegir no es de la etapa anterior.
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
    if (selection.kind === "pause") { await this.pause(ctx, selectedPause(selection, state)); return; }
    stage = selection.stage;
    const enabled = state.version === 2 && state.lifecycle.status === "enabled" ? state.lifecycle : undefined;
    const key = `${selection.action}:${enabled ? enabled.currentSubject : publication?.head}`;
    if (actions.has(key)) { await this.pause(ctx, { reason: "no-progress", stage }); return; }
    actions.add(key);
    const pr = enabled ? enabled.subjects.find(subject => subject.id === enabled.currentSubject)?.number : publication?.number;
    const decision = await this.consent(ctx, state, selection, enabled ? currentLifecyclePin(enabled).accepted.block : config, pr);
    if (decision.kind === "declined") { await this.pause(ctx, { reason: "declined", stage }); return; }
    const consent = decision.chain;
    assertCurrent();
    switch (selection.action) {
     case "adopt":
      if (!publication || !(await adoptLifecycle(this.session, ctx, { ...publication, pinHash: lifecycleHash(config) }, consent))) { await this.pause(ctx, { reason: "not-adopted", stage }); return; }
      break;
     case "fix":
      if (await fixLifecycle(this.session, ctx, { source: "chain", chain: consent })) return; // El turno del modelo hace TDD y todos los D.
      break;
     case "push": await pushLifecycleCorrection(this.session, ctx, { source: "chain", chain: consent }); break;
     case "review": observed = await reviewLifecycle(this.session, ctx, consent); this.remember(observed); break;
     case "land":
      if (!(await landLifecycle(this.session, ctx, consent))) { await this.pause(ctx, { reason: "declined", stage }); return; }
      break;
     case "ship": await shipLifecycle(this.session, ctx, consent); break;
     default: { const unhandled: never = selection.action; throw new Error(`Acción de continuidad desconocida: ${String(unhandled)}`); }
    }
    trigger = "advance";
   }
  } catch (error) {
   // Nunca reintentar: incluso un error puede representar un efecto remoto incierto.
   if (!signal.aborted && this.session.observationOrigin()?.epoch === origin?.epoch) {
    // El texto libre del rechazo o del error va como detalle de un código genérico, nunca como el motivo.
    await this.pause(ctx, { reason: error instanceof LifecycleDeclined ? "declined" : "error", stage, ...(error instanceof Error ? { detail: error.message } : {}) });
   }
  } finally { this.running = false; }
 }
}
