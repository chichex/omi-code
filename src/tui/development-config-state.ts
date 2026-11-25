// Publica la configuración de la sesión para la pestaña OMI: al abrir la sesión con la lectura que ya hizo, cuando la
// pestaña pide r (relee la KB) y después de configurar. Sin modales ni escrituras; sólo con la TUI interactiva.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { foundationsDir, inspectTrust } from "../harness/foundations-trust.ts";
import { commandAllowDir, readAllowedPrefixes } from "../harness/command-allow-store.ts";
import { lifecycleFromPerillas, readLifecycle, type LifecycleReading } from "../harness/lifecycle-kb.ts";
import { lifecycleKeyValid, lifecycleTrustDir, readLifecycleTrust } from "../harness/lifecycle-trust.ts";
import { canAsk } from "./questions/ask.ts";
import { assembleConfigSnapshot, CONFIG_EVENT, CONFIG_REFRESH_EVENT, lifecycleSnapshot, sessionConfigView, storeConfigView, type ConfigSnapshot, type ConfigView } from "./development-config-view.ts";
import type { FoundationsReading } from "./development-foundations.ts";
import { lifecycleRepo } from "./development-lifecycle.ts";
import type { LifecycleOnboarding } from "./development-lifecycle-onboarding.ts";
import type { DevelopmentSession } from "./development-session.ts";

const READ_TIMEOUT_MS = 30_000;
/** `session`: la lectura de Foundations de la sesión. `fresh`: relee la KB (sin KB u offline, como `session`). `reading`: una ya hecha. */
export type ConfigSource = { kind: "session" } | { kind: "fresh" } | { kind: "reading"; reading: FoundationsReading };
const sessionFileOf = (event: unknown): string | undefined => event && typeof event === "object" && "sessionFile" in event && typeof event.sessionFile === "string" ? event.sessionFile : undefined;

export class ConfigState {
	private generation = 0;
	private context: ExtensionContext | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly pi: ExtensionAPI;
	private readonly session: DevelopmentSession;
	private readonly onboarding: LifecycleOnboarding;
	private readonly background: (work: Promise<void>) => void;
	constructor(pi: ExtensionAPI, session: DevelopmentSession, onboarding: LifecycleOnboarding, background: (work: Promise<void>) => void) {
		this.pi = pi; this.session = session; this.onboarding = onboarding; this.background = background;
	}
	/** Al abrir la sesión: calcula en segundo plano con lo que ya se leyó y atiende los pedidos de la pestaña. */
	observe(ctx: ExtensionContext): void {
		this.context = ctx;
		this.unsubscribe ??= this.pi.events.on?.(CONFIG_REFRESH_EVENT, (event: unknown) => {
			const context = this.context, file = context?.sessionManager.getSessionFile();
			if (context && file && sessionFileOf(event) === file) this.update(context, { kind: "fresh" });
		});
		this.update(ctx, { kind: "session" });
	}
	shutdown(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.context = undefined; this.generation++; }
	/** En segundo plano: un fallo nunca frena el comando que lo pidió. */
	update(ctx: ExtensionContext, source: ConfigSource): void { this.background(this.refresh(ctx, source)); }
	/** Sin modales: la aceptación local, el lifecycle de esas perillas (o releído) y lo detectado. */
	async snapshot(ctx: ExtensionContext, reading: FoundationsReading, freshLifecycle: boolean): Promise<ConfigSnapshot> {
		const session = this.session, home = session.io.homeDir, detection = await this.onboarding.detected(ctx.cwd);
		if (reading.kind === "none") return assembleConfigSnapshot({ reading, local: { kind: "missing" }, lifecycle: null, detection });
		const key = reading.key, local = await inspectTrust(foundationsDir(home), key), state = session.state, allowed = await readAllowedPrefixes(commandAllowDir(home), key);
		const sameRepo = !state || state.version === 2 && lifecycleRepo(state) === key.repo;
		if (!sameRepo || !lifecycleKeyValid(key)) return assembleConfigSnapshot({ reading, local, lifecycle: null, detection, allowed });
		const lifecycleLocal = await readLifecycleTrust(lifecycleTrustDir(home), key);
		const lifecycleReading: LifecycleReading = reading.kind === "unavailable" ? { kind: "unavailable", key, reason: reading.reason }
			: freshLifecycle ? await readLifecycle(session.kb, key, ctx.cwd, session.lifecycle.signal) : lifecycleFromPerillas(key, reading.perillas);
		return assembleConfigSnapshot({ reading, local, lifecycle: lifecycleSnapshot(lifecycleReading, lifecycleLocal, detection), detection, allowed });
	}
	/** Un snapshot ya calculado (por ejemplo, el del setup): se muestra sin volver a leer. */
	show(ctx: ExtensionContext, snapshot: ConfigSnapshot): void {
		const file = this.file(ctx);
		if (!file) return;
		this.generation++; this.publish(file, { status: "ready", snapshot, at: Date.now(), refreshing: false, error: null });
	}
	/** La más nueva gana: una lectura que terminó tarde no pisa a otra posterior. */
	async refresh(ctx: ExtensionContext, source: ConfigSource): Promise<void> {
		const file = this.file(ctx);
		if (!file) return;
		const generation = ++this.generation, session = this.session, previous = sessionConfigView(file);
		const current = () => generation === this.generation && !session.lifecycle.signal.aborted;
		this.publish(file, previous?.status === "ready" ? { ...previous, refreshing: true } : { status: "reading" });
		try {
			const fresh = source.kind === "fresh" && session.kb && !session.offline;
			const reading = source.kind === "reading" ? source.reading
				: fresh ? await session.foundations.read(ctx, AbortSignal.any([session.lifecycle.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]))
				: await session.foundations.loaded(ctx);
			if (!reading) throw new Error("sin lectura de Foundations en esta sesión");
			const snapshot = await this.snapshot(ctx, reading, false);
			if (current()) this.publish(file, { status: "ready", snapshot, at: Date.now(), refreshing: false, error: null });
		} catch (error) {
			if (!current()) return;
			const reason = error instanceof Error ? error.message : "falló la lectura", last = sessionConfigView(file);
			this.publish(file, last?.status === "ready" ? { ...last, refreshing: false, error: reason } : { status: "failed", reason });
		}
	}
	/** Sólo la TUI interactiva tiene la pestaña; sin sesión persistente no hay dónde guardarlo. */
	private file(ctx: ExtensionContext): string | undefined { return canAsk(ctx) ? ctx.sessionManager.getSessionFile() : undefined; }
	private publish(file: string, view: ConfigView): void {
		storeConfigView(file, view);
		void Promise.resolve(this.pi.events.emit(CONFIG_EVENT, { sessionFile: file })).catch(() => {});
	}
}
