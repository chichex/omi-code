// Setup de lo que falta configurar: el panel de Foundations y después el wizard del lifecycle, cada uno con
// «Más adelante» por revisión. Corre con /omi-setup, al entrar al harness, al abrir una sesión interactiva nueva
// y al publicar el PR draft (sólo el lifecycle). Nunca offline, sin UI, con la KB no disponible, ni al restaurar,
// recargar, retomar o bifurcar una sesión. Esc corta el setup sin guardar nada; guardar no ejecuta ni adopta nada.
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { configLines, diagnoseConfig, stopsAtDraft, type ConfigDiagnosis, type SetupPart } from "../harness/config-doctor.ts";
import { foundationsDir, inspectTrust, readTrust, writeTrust, type TrustKey } from "../harness/foundations-trust.ts";
import { detectLifecycle, type LifecycleDetection } from "../harness/lifecycle-detect.ts";
import { lifecycleFromPerillas, readLifecycle, type LifecycleReading } from "../harness/lifecycle-kb.ts";
import { lifecycleOnboardingStatus, runLifecycleOnboarding, type LifecycleOnboardingOutcome } from "../harness/lifecycle-onboarding.ts";
import type { LifecycleConfig } from "../harness/lifecycle-schema.ts";
import { lifecycleKeyValid, lifecycleTrustDir, readLifecycleTrust } from "../harness/lifecycle-trust.ts";
import { askQuestions, canAsk } from "./questions/ask.ts";
import type { FoundationsReading } from "./development-foundations.ts";
import { editFoundations } from "./development-foundations-setup.ts";
import { lifecycleRepo } from "./development-lifecycle.ts";
import type { LifecycleOnboarding } from "./development-lifecycle-onboarding.ts";
import type { DevelopmentSession } from "./development-session.ts";

export type SetupTrigger = "command" | "harness" | "session" | "publication";
/** `background`: dónde corre la oferta de una sesión nueva, que espera la lectura de la KB sin frenar el arranque. */
export interface ConfigSetupDeps { background?: (work: Promise<void>) => void }
interface Snapshot { diagnosis: ConfigDiagnosis; key: TrustKey | null; detection: LifecycleDetection | undefined }
type Parts = { foundations: SetupPart; lifecycle: SetupPart };

const READ_TIMEOUT_MS = 30_000;
const NOW = "Configurar ahora", LATER = "Más adelante";
const CANCELLED = "Configuración cancelada: no se guardó nada más. Volvé con /omi-setup.";
const LIFECYCLE: Record<Exclude<LifecycleOnboardingOutcome["kind"], "unavailable" | "invalid">, string> = {
	saved: "Lifecycle guardado en la KB y aceptado. No se ejecutó ningún workflow, merge ni deploy.",
	deferred: "Lifecycle postergado para esta revisión: no se vuelve a ofrecer solo hasta que cambie. Volvé con /omi-setup.",
	cancelled: CANCELLED,
	declined: "Lifecycle sin guardar: no se escribió nada.",
};
const revision = (part: SetupPart) => part.kind === "none" ? null : part.revision;

export class ConfigSetup {
	private readonly offered = new Set<string>();
	private readonly session: DevelopmentSession;
	private readonly onboarding: LifecycleOnboarding;
	private readonly background: (work: Promise<void>) => void;
	constructor(session: DevelopmentSession, onboarding: LifecycleOnboarding, deps: ConfigSetupDeps) {
		this.session = session; this.onboarding = onboarding;
		this.background = deps.background ?? ((work) => { void work.catch(() => {}); });
	}
	/** Sólo una sesión interactiva nueva (arranque o /new, sin mensajes); restore, reload, resume y fork nunca. */
	sessionStarted(reason: SessionStartEvent["reason"] | undefined, ctx: ExtensionContext): void {
		if (reason !== "startup" && reason !== "new") return;
		if (this.session.state || this.session.lockedReason || ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
		this.background(this.offer(ctx, "session"));
	}
	/** Al publicar el PR draft, si la continuidad no lo adoptó: sólo el lifecycle. */
	async publication(ctx: ExtensionContext): Promise<void> {
		const state = this.session.state;
		if (state?.version !== 2 || state.publication.status !== "opened" || state.lifecycle.status !== "disabled") return;
		await this.offer(ctx, "publication");
	}
	/** Disparo automático: una vez por revisión y sesión, con la lectura que la sesión ya hizo. Un fallo nunca frena nada. */
	async offer(ctx: ExtensionContext, trigger: Exclude<SetupTrigger, "command">): Promise<void> {
		const session = this.session;
		if (session.offline || !session.kb || !canAsk(ctx)) return;
		try {
			const reading = await session.foundations.loaded(ctx);
			if (!reading || session.lifecycle.signal.aborted) return;
			const snapshot = await this.snapshot(ctx, reading, trigger === "publication");
			const { diagnosis } = snapshot;
			const fresh = (name: string, part: SetupPart) => part.kind === "run" && !this.offered.has(`${name}:${part.revision}`);
			const parts: Parts = {
				foundations: trigger !== "publication" && fresh("foundations", diagnosis.foundations) ? diagnosis.foundations : { kind: "none" },
				lifecycle: (trigger !== "publication" || stopsAtDraft(diagnosis)) && fresh("lifecycle", diagnosis.lifecycle) ? diagnosis.lifecycle : { kind: "none" },
			};
			if (parts.foundations.kind === "none" && parts.lifecycle.kind === "none") return;
			// Al abrir una sesión, no interrumpe un turno que ya empezó ni una sesión que cambió mientras leía.
			if (trigger === "session" && (session.state || !ctx.isIdle() || ctx.hasPendingMessages())) return;
			await this.run(ctx, snapshot, parts, trigger);
		} catch (error) {
			if (session.lifecycle.signal.aborted) return;
			try { ctx.ui.notify(`No se pudo ofrecer la configuración: ${error instanceof Error ? error.message : "falló la lectura"}. Volvé con /omi-setup.`, "warning"); } catch { /* La sesión ya no está. */ }
		}
	}
	/** /omi-setup: relee la KB y corre lo que falta, también lo postergado. Sin nada para correr, muestra el diagnóstico. */
	async command(ctx: ExtensionContext): Promise<void> {
		const session = this.session;
		if (!canAsk(ctx)) throw new Error("Configurar requiere la TUI interactiva de OMI.");
		if (session.offline) throw new Error("Sin red (--offline o PI_OFFLINE): no se puede leer ni guardar la configuración en la KB. No se cambió nada.");
		if (!session.kb) throw new Error("KB no disponible: no se puede leer ni guardar la configuración. No se cambió nada.");
		const reading = await session.loader(ctx, "Leyendo la configuración de la KB", (cancel) => session.foundations.read(ctx, AbortSignal.any([session.lifecycle.signal, cancel, AbortSignal.timeout(READ_TIMEOUT_MS)])));
		if (!reading) { ctx.ui.notify("Lectura cancelada: no se abrió nada ni se cambió nada.", "info"); return; }
		const snapshot = await this.snapshot(ctx, reading, false);
		// La persona lo pidió: corre lo que falta y también lo postergado.
		const parts: Parts = { foundations: snapshot.diagnosis.foundations, lifecycle: snapshot.diagnosis.lifecycle };
		if (parts.foundations.kind === "none" && parts.lifecycle.kind === "none") { ctx.ui.notify([...configLines(snapshot.diagnosis), "Nada para configurar desde acá."].join("\n"), "info"); return; }
		await this.run(ctx, snapshot, parts, "command");
	}
	/** Sin modales: la aceptación local, el lifecycle de esas perillas (o releído al publicar) y lo detectado. */
	private async snapshot(ctx: ExtensionContext, reading: FoundationsReading, freshLifecycle: boolean): Promise<Snapshot> {
		const home = this.session.io.homeDir, signal = this.session.lifecycle.signal, detection = await this.onboarding.detected(ctx.cwd);
		if (reading.kind === "none") return { diagnosis: diagnoseConfig({ foundations: { reading, local: { kind: "missing" } }, lifecycle: null, omi: detection?.omi }), key: null, detection };
		const key = reading.key, local = await inspectTrust(foundationsDir(home), key), state = this.session.state;
		const sameRepo = !state || state.version === 2 && lifecycleRepo(state) === key.repo;
		let lifecycle: Parameters<typeof diagnoseConfig>[0]["lifecycle"] = null;
		if (sameRepo && lifecycleKeyValid(key)) {
			const lifecycleLocal = await readLifecycleTrust(lifecycleTrustDir(home), key);
			const lifecycleReading: LifecycleReading = reading.kind === "unavailable" ? { kind: "unavailable", key, reason: reading.reason }
				: freshLifecycle ? await readLifecycle(this.session.kb, key, ctx.cwd, signal) : lifecycleFromPerillas(key, reading.perillas);
			lifecycle = { state: lifecycleOnboardingStatus(lifecycleReading, lifecycleLocal, detection), local: lifecycleLocal };
		}
		return { diagnosis: diagnoseConfig({ foundations: { reading, local }, lifecycle, omi: detection?.omi }), key, detection };
	}
	/** En orden: Foundations y después el lifecycle. Esc en cualquiera corta el resto. Lo ofrecido no vuelve solo en esta sesión. */
	private async run(ctx: ExtensionContext, snapshot: Snapshot, parts: Parts, trigger: SetupTrigger): Promise<void> {
		const { key } = snapshot;
		if (!key) return;
		for (const [name, part] of Object.entries(parts)) { const value = revision(part); if (value) this.offered.add(`${name}:${value}`); }
		if (parts.foundations.kind !== "none" && await this.foundations(ctx, key, snapshot.diagnosis, parts.foundations.revision) === "cancelled") { ctx.ui.notify(CANCELLED, "info"); return; }
		if (parts.lifecycle.kind !== "none") await this.lifecycle(ctx, key, snapshot.detection, trigger);
	}
	private async foundations(ctx: ExtensionContext, key: TrustKey, diagnosis: ConfigDiagnosis, deferral: string): Promise<"saved" | "deferred" | "cancelled" | "failed"> {
		const item = diagnosis.items.find((i) => i.id === "foundations");
		const answer = await askQuestions(ctx, { title: `Foundations de ${key.repo}`, questions: [{
			id: "foundations", header: "Foundations", question: "¿Configurás Foundations ahora?", ...(item ? { detail: `${item.message}\n${item.resolve}` } : {}),
			options: [{ label: NOW, description: "Abre el panel de reglas y políticas; sólo Guardar escribe" }, { label: LATER, description: "No se vuelve a ofrecer solo hasta que cambie; /omi-setup lo retoma" }],
			multiSelect: false, recommended: true, freeText: false,
		}] }, { signal: this.session.lifecycle.signal });
		if (answer.status === "cancelled") return "cancelled";
		const choice = answer.answers[0]?.options[0];
		if (choice === LATER) {
			const dir = foundationsDir(this.session.io.homeDir), record = await readTrust(dir, key);
			await writeTrust(dir, { ...(record ?? { version: 2, ...key, accepted: null, deferred: null }), deferred: { revision: deferral, at: this.session.now() } }, { expected: record ?? null });
			ctx.ui.notify("Foundations postergado para esta revisión: no se vuelve a ofrecer solo hasta que cambie. Volvé con /omi-setup.", "info");
			return "deferred";
		}
		if (choice !== NOW) throw new Error("Respuesta inválida del setup; no se guardó nada.");
		try { return await editFoundations(ctx, this.session, this.session.kb) ? "saved" : "cancelled"; }
		catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudo editar Foundations", "warning"); return "failed"; }
	}
	private async lifecycle(ctx: ExtensionContext, key: TrustKey, detection: LifecycleDetection | undefined, trigger: SetupTrigger): Promise<void> {
		const session = this.session, signal = session.lifecycle.signal;
		const head = await session.runner.run("git", ["-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: ctx.cwd, signal });
		const base = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
		if (!base) { ctx.ui.notify("Para configurar el lifecycle falta la rama base de origin: corré git remote set-head origin --auto y volvé con /omi-setup. No se guardó nada.", "warning"); return; }
		const outcome = await runLifecycleOnboarding({ kb: session.kb, key, cwd: ctx.cwd, base, trustDir: lifecycleTrustDir(session.io.homeDir), detection: detection ?? await detectLifecycle(ctx.cwd, signal),
			ask: (batch) => askQuestions(ctx, batch, { signal }), now: session.now, signal });
		if (outcome.kind === "unavailable" || outcome.kind === "invalid") { ctx.ui.notify(`No se pudo configurar el lifecycle: ${outcome.reason}. No se guardó nada.`, "warning"); return; }
		ctx.ui.notify(LIFECYCLE[outcome.kind], "info");
		if (outcome.kind === "saved" && trigger === "publication") this.adoptHint(ctx, outcome.pin.block);
	}
	/** Guardar no adopta el draft ya publicado: se dice cómo seguir, sin inventar efectos. */
	private adoptHint(ctx: ExtensionContext, block: LifecycleConfig): void {
		const state = this.session.state;
		if (state?.version !== 2 || state.publication.status !== "opened" || state.lifecycle.status !== "disabled") return;
		const entry = block.continuity?.entry, pr = `PR draft #${state.publication.number}`;
		ctx.ui.notify(entry === "auto" || entry === "ask"
			? `Guardar no adoptó el ${pr}: la entrada ${entry} de la continuidad vale desde la próxima publicación. Para seguir con este PR: /omi-work adopt.`
			: `El trabajo sigue en el ${pr}. Para seguir con Review, Land y Ship: /omi-work adopt.`, "info");
	}
}

const hosts = new WeakMap<DevelopmentSession, ConfigSetup>();
/** Registra /omi-setup; `after` reacomoda las tools si Guardar cambió Foundations. */
export function registerConfigSetup(pi: ExtensionAPI, session: DevelopmentSession, onboarding: LifecycleOnboarding, deps: ConfigSetupDeps, after: () => void): ConfigSetup {
	const setup = new ConfigSetup(session, onboarding, deps);
	hosts.set(session, setup);
	pi.registerCommand("omi-setup", {
		description: "Configurar lo que falta: Foundations y el lifecycle del repo (Review, Land, Ship y continuidad)",
		handler: async (_input, ctx) => {
			try {
				if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Esperá a que termine el turno antes de configurar.");
				await setup.command(ctx); after();
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudo configurar", "warning"); }
		},
	});
	return setup;
}
/** La continuidad lo llama al publicar el PR draft. Sin setup registrado para la sesión, no hace nada. */
export async function offerSetupAfterPublication(session: DevelopmentSession, ctx: ExtensionContext): Promise<void> {
	await hosts.get(session)?.publication(ctx);
}
