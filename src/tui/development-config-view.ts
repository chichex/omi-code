// Configuración de la sesión para la pestaña OMI, que vive en otra extensión: Foundations leído, lifecycle,
// continuidad y lo que falta. El harness la calcula (development-config-state.ts) y avisa por pi.events; la pestaña
// sólo la lee, sin I/O en el render. Sin imports runtime de Pi ni del harness pesado: lo importa el workspace.
import { resolve } from "node:path";
import { diagnoseConfig, type ConfigDiagnosis } from "../harness/config-doctor.ts";
import type { TrustInspection, TrustKey } from "../harness/foundations-trust.ts";
import type { LifecycleDetection } from "../harness/lifecycle-detect.ts";
import type { LifecycleReading } from "../harness/lifecycle-kb.ts";
import { lifecycleOnboardingStatus, type LifecycleOnboardingState } from "../harness/lifecycle-onboarding.ts";
import type { LifecycleTrustReading } from "../harness/lifecycle-trust.ts";
import type { FoundationsReading } from "./development-foundations.ts";

/** El harness publicó otra vista para `{ sessionFile }`: la pestaña se redibuja. */
export const CONFIG_EVENT = "omi:config";
/** La pestaña pide releer (r) para `{ sessionFile }`. */
export const CONFIG_REFRESH_EVENT = "omi:config:refresh";
const MAX_SESSIONS = 50;

export interface LifecycleSnapshot { reading: LifecycleReading; local: LifecycleTrustReading; state: LifecycleOnboardingState }
/** `lifecycle` null: sin repo de GitHub con producto en la KB, o el trabajo es de otro repo. `allowed`: prefijos de «no volver a preguntar». */
export interface ConfigSnapshot {
	reading: FoundationsReading; local: TrustInspection; lifecycle: LifecycleSnapshot | null; allowed?: readonly string[];
	detection: LifecycleDetection | undefined; key: TrustKey | null; diagnosis: ConfigDiagnosis;
}
/** `refreshing`: hay una lectura nueva en curso. `error`: la última falló y se muestra la anterior. */
export type ConfigView =
	| { status: "reading" }
	| { status: "failed"; reason: string }
	| { status: "ready"; snapshot: ConfigSnapshot; at: number; refreshing: boolean; error: string | null };

export function lifecycleSnapshot(reading: LifecycleReading, local: LifecycleTrustReading, detection: LifecycleDetection | undefined): LifecycleSnapshot {
	return { reading, local, state: lifecycleOnboardingStatus(reading, local, detection) };
}
/** Puro: el diagnóstico sale de las mismas lecturas que se muestran. */
export function assembleConfigSnapshot(parts: Omit<ConfigSnapshot, "diagnosis" | "key">): ConfigSnapshot {
	const { reading, local, lifecycle, detection } = parts;
	const diagnosis = diagnoseConfig({ foundations: { reading, local }, lifecycle: lifecycle && { state: lifecycle.state, local: lifecycle.local }, omi: detection?.omi });
	return { ...parts, key: reading.kind === "none" ? null : reading.key, diagnosis };
}

const views = new Map<string, ConfigView>();
/** Lo último que el harness publicó para esa sesión. Sin I/O ni efectos. */
export function sessionConfigView(sessionFile: string): ConfigView | undefined { return views.get(resolve(sessionFile)); }
/** Guarda sin avisar: el harness emite CONFIG_EVENT después. */
export function storeConfigView(sessionFile: string, view: ConfigView): void {
	const file = resolve(sessionFile);
	views.delete(file); views.set(file, view);
	for (const oldest of views.keys()) { if (views.size <= MAX_SESSIONS) break; views.delete(oldest); }
}
