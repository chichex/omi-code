// Detector del lifecycle en la TUI: lee el repo en segundo plano al abrir la sesión, sin modales, red ni escrituras.
// El setup (development-config-setup.ts) usa lo detectado para ofrecer el wizard compartido con `omi init --development`.
import { detectLifecycle, type LifecycleDetection } from "../harness/lifecycle-detect.ts";
import type { DevelopmentSession } from "./development-session.ts";

export class LifecycleOnboarding {
	private detection: Promise<LifecycleDetection | undefined> | undefined;
	private root: string | undefined;
	private readonly session: DevelopmentSession;
	constructor(session: DevelopmentSession) { this.session = session; }
	/** Al abrir la sesión: sólo lectura acotada del checkout. */
	detect(root: string): void {
		if (this.root === root && this.detection) return;
		this.root = root; this.detection = detectLifecycle(root, this.session.lifecycle.signal).catch(() => undefined);
	}
	/** Lo detectado en este checkout: reutiliza la lectura de la sesión y la reintenta una vez si falló. */
	async detected(root: string): Promise<LifecycleDetection | undefined> {
		this.detect(root);
		return await this.detection ?? await detectLifecycle(root, this.session.lifecycle.signal).catch(() => undefined);
	}
}
