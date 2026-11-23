// Onboarding del lifecycle en la TUI: el detector lee el repo en segundo plano al abrir la sesión y el wizard
// compartido con `omi init --development` se ofrece al entrar al harness, nunca en consultas simples ni needs-info.
// Esc cancela sin escribir ni desactivar nada; «Más adelante» posterga sólo esa revisión.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectLifecycle, type LifecycleDetection } from "../harness/lifecycle-detect.ts";
import { lifecycleFromPerillas } from "../harness/lifecycle-kb.ts";
import { lifecycleOnboardingStatus, runLifecycleOnboarding, shouldOfferLifecycleOnboarding } from "../harness/lifecycle-onboarding.ts";
import { lifecycleKeyValid, lifecycleTrustDir, readLifecycleTrust, type LifecycleKey } from "../harness/lifecycle-trust.ts";
import { askQuestions, canAsk } from "./questions/ask.ts";
import { HARNESS_KB_URL } from "./defaults.ts";
import { lifecycleRepo } from "./development-lifecycle.ts";
import type { DevelopmentSession } from "./development-session.ts";

const MESSAGES = { saved: "Lifecycle guardado en la KB y aceptado. No se ejecutó ningún workflow, merge ni deploy.", deferred: "Lifecycle postergado para esta revisión; volvé con omi init --development." } as const;
export class LifecycleOnboarding {
	private detection: Promise<LifecycleDetection | undefined> | undefined;
	private root: string | undefined;
	private readonly offered = new Set<string>();
	private readonly session: DevelopmentSession;
	constructor(session: DevelopmentSession) { this.session = session; }
	/** Al abrir la sesión: sólo lectura acotada del checkout, sin modales, red ni escrituras. */
	detect(root: string): void {
		if (this.root === root && this.detection) return;
		this.root = root; this.detection = detectLifecycle(root, this.session.lifecycle.signal).catch(() => undefined);
	}
	/** Al entrar al harness. Una vez por revisión y sesión; un fallo nunca frena el trabajo. */
	async offer(ctx: ExtensionContext): Promise<void> {
		const session = this.session, state = session.state, kb = session.kb, signal = session.lifecycle.signal;
		if (!state || state.version !== 2 || !kb || session.offline || !canAsk(ctx)) return;
		try {
			const repo = lifecycleRepo(state), key: LifecycleKey = { kbUrl: kb.url ?? HARNESS_KB_URL, product: repo.split("/")[1] ?? "", repo };
			if (!lifecycleKeyValid(key)) return;
			// Decidir la oferta con las perillas que Foundations ya leyó al arrancar: entrar al harness no relee la KB.
			const reading = session.foundations.current(ctx)?.reading;
			if (!reading || !["valid", "missing", "invalid"].includes(reading.kind) || !("key" in reading) || reading.key.repo !== repo || reading.key.kbUrl !== key.kbUrl) return;
			const trustDir = lifecycleTrustDir(session.io.homeDir), local = await readLifecycleTrust(trustDir, key);
			// Las recomendaciones de Review dependen de lo detectado: la lectura ya corre en segundo plano desde la sesión.
			this.detect(state.checkout.root);
			const detection = await this.detection ?? await detectLifecycle(state.checkout.root, signal);
			const status = lifecycleOnboardingStatus(lifecycleFromPerillas(key, "perillas" in reading ? reading.perillas : null), local, detection);
			if (!shouldOfferLifecycleOnboarding("harness", status, local) || !status.revision || this.offered.has(status.revision)) return;
			this.offered.add(status.revision);
			const base = await session.runner.run("git", ["-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: state.checkout.root, signal });
			const branch = base.code === 0 ? base.stdout.trim().replace(/^origin\//, "") : "";
			if (!branch) return;
			const outcome = await runLifecycleOnboarding({ kb, key, cwd: state.checkout.root, base: branch, trustDir, detection, ask: batch => askQuestions(ctx, batch, { signal }), now: session.now, signal });
			if (outcome.kind === "saved" || outcome.kind === "deferred") ctx.ui.notify(MESSAGES[outcome.kind], "info");
		} catch { /* El onboarding es una oferta: si falla, el harness sigue igual y nada queda aceptado. */ }
	}
}
