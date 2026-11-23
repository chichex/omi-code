// Setup de lo que falta configurar: el panel de Foundations y después el wizard del lifecycle, cada uno con
// «Más adelante» por revisión. Corre con /omi-setup, al entrar al harness, al abrir una sesión interactiva nueva
// y al publicar el PR draft (sólo el lifecycle). Nunca offline, sin UI, con la KB no disponible, ni al restaurar,
// recargar, retomar o bifurcar una sesión. Esc corta el setup sin guardar nada; guardar no ejecuta ni adopta nada.
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { configLines, stopsAtDraft, type ConfigDiagnosis, type SetupPart } from "../harness/config-doctor.ts";
import { stackUnsupportedText } from "../harness/continuity-pause-text.ts";
import { foundationsDir, readTrust, writeTrust, type TrustKey } from "../harness/foundations-trust.ts";
import { detectLifecycle, type LifecycleDetection } from "../harness/lifecycle-detect.ts";
import { runLifecycleOnboarding, type LifecycleOnboardingOutcome } from "../harness/lifecycle-onboarding.ts";
import type { LifecycleConfig } from "../harness/lifecycle-schema.ts";
import { lifecycleTrustDir } from "../harness/lifecycle-trust.ts";
import { askQuestions, canAsk } from "./questions/ask.ts";
import type { ConfigState } from "./development-config-state.ts";
import type { ConfigSnapshot } from "./development-config-view.ts";
import { editFoundations } from "./development-foundations-setup.ts";
import type { DevelopmentSession } from "./development-session.ts";

export type SetupTrigger = "command" | "harness" | "session" | "publication";
/** `background`: dónde corre la oferta de una sesión nueva, que espera la lectura de la KB sin frenar el arranque. */
export interface ConfigSetupDeps { background?: (work: Promise<void>) => void }
type Parts = { foundations: SetupPart; lifecycle: SetupPart };

const READ_TIMEOUT_MS = 30_000;
const NOW = "Configurar ahora", LATER = "Más adelante";
const CANCELLED = "Configuración cancelada: no se guardó nada más. Volvé con /omi-setup.";
const BUSY = "Ya hay un setup abierto. Terminalo o cerralo con Esc, y volvé con /omi-setup. No se cambió nada.";
const LIFECYCLE: Record<Exclude<LifecycleOnboardingOutcome["kind"], "unavailable" | "invalid">, string> = {
	saved: "Lifecycle guardado en la KB y aceptado. No se ejecutó ningún workflow, merge ni deploy.",
	deferred: "Lifecycle postergado para esta revisión: no se vuelve a ofrecer solo hasta que cambie. Volvé con /omi-setup.",
	cancelled: CANCELLED,
	declined: "Lifecycle sin guardar: no se escribió nada.",
};
const revision = (part: SetupPart) => part.kind === "none" ? null : part.revision;
/** Una sesión con mensajes ya no es nueva: la charla empezó. */
const talking = (ctx: ExtensionContext) => ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
const typingNotice = (parts: Parts) => {
	const missing = [parts.foundations.kind !== "none" && "Foundations", parts.lifecycle.kind !== "none" && "el lifecycle"].filter(Boolean).join(" y ");
	return `Falta configurar ${missing}. No abrí el setup porque estabas escribiendo. Cuando quieras: /omi-setup.`;
};

export class ConfigSetup {
	private readonly offered = new Set<string>();
	/** Un setup a la vez: el modal de uno reemplazaría al del otro y la persona vería un «cancelado» que no eligió. */
	private busy = false;
	private readonly session: DevelopmentSession;
	private readonly config: ConfigState;
	private readonly background: (work: Promise<void>) => void;
	constructor(session: DevelopmentSession, config: ConfigState, deps: ConfigSetupDeps) {
		this.session = session; this.config = config;
		this.background = deps.background ?? ((work) => { void work.catch(() => {}); });
	}
	/** Sólo una sesión interactiva nueva (arranque o /new, sin mensajes); restore, reload, resume y fork nunca.
	 * `initialPrompt`: la CLI trae un prompt (`omi "…"`); ese arranque empieza con un turno, no con el setup. */
	sessionStarted(reason: SessionStartEvent["reason"] | undefined, ctx: ExtensionContext, initialPrompt = false): void {
		if (reason !== "startup" && reason !== "new" || reason === "startup" && initialPrompt) return;
		if (this.session.state || this.session.lockedReason || talking(ctx)) return;
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
			// La pestaña OMI ve lo mismo que decide el setup.
			const snapshot = await this.config.snapshot(ctx, reading, trigger === "publication"); this.config.show(ctx, snapshot);
			const { diagnosis } = snapshot;
			const fresh = (name: string, part: SetupPart) => part.kind === "run" && !this.offered.has(`${name}:${part.revision}`);
			const parts: Parts = {
				foundations: trigger !== "publication" && fresh("foundations", diagnosis.foundations) ? diagnosis.foundations : { kind: "none" },
				lifecycle: (trigger !== "publication" || stopsAtDraft(diagnosis)) && fresh("lifecycle", diagnosis.lifecycle) ? diagnosis.lifecycle : { kind: "none" },
			};
			// Sin rama base el wizard no puede correr: el aviso es de /omi-setup, no de cada sesión.
			if (parts.lifecycle.kind !== "none" && !await this.base(ctx)) parts.lifecycle = { kind: "none" };
			if (parts.foundations.kind === "none" && parts.lifecycle.kind === "none") return;
			// Si la persona ya abrió /omi-setup mientras se leía, manda ése.
			if (this.busy) return;
			// Al abrir una sesión, no interrumpe un turno que ya empezó, una charla que empezó mientras leía ni una sesión que cambió.
			if (trigger === "session" && (session.state || !ctx.isIdle() || ctx.hasPendingMessages() || talking(ctx))) return;
			// El modal toma el foco: lo que la persona tipea caería en sus opciones. Sólo se avisa.
			if (trigger === "session" && ctx.ui.getEditorText().trim()) { ctx.ui.notify(typingNotice(parts), "info"); return; }
			await this.exclusive(() => this.run(ctx, snapshot, parts, trigger));
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
		if (this.busy) throw new Error(BUSY);
		await this.exclusive(() => this.configure(ctx));
	}
	/** La lectura y el setup de /omi-setup, con el setup ya tomado. */
	private async configure(ctx: ExtensionContext): Promise<void> {
		const session = this.session;
		const reading = await session.loader(ctx, "Leyendo la configuración de la KB", (cancel) => session.foundations.read(ctx, AbortSignal.any([session.lifecycle.signal, cancel, AbortSignal.timeout(READ_TIMEOUT_MS)])));
		if (!reading) { ctx.ui.notify("Lectura cancelada: no se abrió nada ni se cambió nada.", "info"); return; }
		const snapshot = await this.config.snapshot(ctx, reading, false); this.config.show(ctx, snapshot);
		// La persona lo pidió: corre lo que falta y también lo postergado.
		const parts: Parts = { foundations: snapshot.diagnosis.foundations, lifecycle: snapshot.diagnosis.lifecycle };
		if (parts.foundations.kind === "none" && parts.lifecycle.kind === "none") { ctx.ui.notify([...configLines(snapshot.diagnosis), "Nada para configurar desde acá."].join("\n"), "info"); return; }
		await this.run(ctx, snapshot, parts, "command");
	}
	/** Toma el setup sin ceder el turno entre el chequeo de `busy` y la marca. */
	private async exclusive(work: () => Promise<void>): Promise<void> {
		this.busy = true;
		try { await work(); } finally { this.busy = false; }
	}
	/** En orden: Foundations y después el lifecycle. Esc en cualquiera corta el resto. Lo ofrecido no vuelve solo en esta sesión. */
	private async run(ctx: ExtensionContext, snapshot: ConfigSnapshot, parts: Parts, trigger: SetupTrigger): Promise<void> {
		const { key } = snapshot;
		if (!key) return;
		for (const [name, part] of Object.entries(parts)) { const value = revision(part); if (value) this.offered.add(`${name}:${value}`); }
		let saved = false;
		try {
			const foundations = parts.foundations.kind === "none" ? "skipped" : await this.foundations(ctx, key, snapshot.diagnosis, parts.foundations.revision);
			saved = foundations === "saved";
			if (foundations === "cancelled") { ctx.ui.notify(CANCELLED, "info"); return; }
			if (parts.lifecycle.kind !== "none") saved = await this.lifecycle(ctx, key, snapshot.detection, trigger) || saved;
		} finally {
			// Lo guardado se relee de la KB; un «Más adelante» sólo cambió la aceptación local.
			this.config.update(ctx, saved ? { kind: "fresh" } : { kind: "reading", reading: snapshot.reading });
		}
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
	/** true si guardó en la KB. */
	private async lifecycle(ctx: ExtensionContext, key: TrustKey, detection: LifecycleDetection | undefined, trigger: SetupTrigger): Promise<boolean> {
		const session = this.session, signal = session.lifecycle.signal, base = await this.base(ctx);
		if (!base) { ctx.ui.notify("Para configurar el lifecycle falta la rama base de origin: corré git remote set-head origin --auto y volvé con /omi-setup. No se guardó nada.", "warning"); return false; }
		const outcome = await runLifecycleOnboarding({ kb: session.kb, key, cwd: ctx.cwd, base, trustDir: lifecycleTrustDir(session.io.homeDir), detection: detection ?? await detectLifecycle(ctx.cwd, signal),
			ask: (batch) => askQuestions(ctx, batch, { signal }), now: session.now, signal });
		if (outcome.kind === "unavailable" || outcome.kind === "invalid") { ctx.ui.notify(`No se pudo configurar el lifecycle: ${outcome.reason}. No se guardó nada.`, "warning"); return false; }
		ctx.ui.notify(LIFECYCLE[outcome.kind], "info");
		if (outcome.kind === "saved" && trigger === "publication") this.adoptHint(ctx, outcome.pin.block);
		return outcome.kind === "saved";
	}
	/** La rama de origin/HEAD, o "" si el remoto no la tiene. */
	private async base(ctx: ExtensionContext): Promise<string> {
		const head = await this.session.runner.run("git", ["-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: ctx.cwd, signal: this.session.lifecycle.signal });
		return head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
	}
	/** Guardar no adopta el draft ya publicado: se dice cómo seguir, sin inventar efectos. */
	private adoptHint(ctx: ExtensionContext, block: LifecycleConfig): void {
		const state = this.session.state;
		if (state?.version !== 2 || state.publication.status !== "opened" || state.lifecycle.status !== "disabled") return;
		// El lifecycle no adopta stacks: el próximo paso es el mismo que da /omi-work adopt.
		if (state.publication.stack) { ctx.ui.notify(`Guardar no adoptó el stack. ${stackUnsupportedText(state.publication.stack.length)}`, "info"); return; }
		const entry = block.continuity?.entry, pr = `PR draft #${state.publication.number}`;
		ctx.ui.notify(entry === "auto" || entry === "ask"
			? `Guardar no adoptó el ${pr}: la entrada ${entry} de la continuidad vale desde la próxima publicación. Para seguir con este PR: /omi-work adopt.`
			: `El trabajo sigue en el ${pr}. Para seguir con Review, Land y Ship: /omi-work adopt.`, "info");
	}
}

const hosts = new WeakMap<DevelopmentSession, ConfigSetup>();
/** Registra /omi-setup; `after` reacomoda las tools si Guardar cambió Foundations. */
export function registerConfigSetup(pi: ExtensionAPI, session: DevelopmentSession, config: ConfigState, deps: ConfigSetupDeps, after: () => void): ConfigSetup {
	const setup = new ConfigSetup(session, config, deps);
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
