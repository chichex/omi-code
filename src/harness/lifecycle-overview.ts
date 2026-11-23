// Qué dice la configuración del lifecycle, en líneas para la pantalla OMI: estado, Review, correcciones, Land, Ship,
// presupuesto y continuidad. Puro: no lee la KB, no acepta nada ni decide permisos.
import type { LifecycleReading } from "./lifecycle-kb.ts";
import { lifecycleMissing, type LifecycleOnboardingState } from "./lifecycle-onboarding.ts";
import { reviewProviderText } from "./lifecycle-review-wizard.ts";
import type { ContinuityMode, LifecycleConfig, LifecycleContinuity, LifecycleTarget } from "./lifecycle-schema.ts";
import type { LifecycleTrustReading } from "./lifecycle-trust.ts";

export interface LifecycleOverview { state: LifecycleOnboardingState; reading: LifecycleReading; local: LifecycleTrustReading }
type Shown = { block: LifecycleConfig; hash: string; source: "kb" | "local" };

const STATUS: Record<LifecycleOnboardingState["status"], string> = {
	unconfigured: "sin configurar", pending: "pendiente de aceptar", configured: "configurado", manual: "configurado",
	"not-applicable": "configurado", invalid: "inválido", unavailable: "no disponible",
};
const MODES = "Modos: ask pide tu sí antes del efecto; auto no pregunta, pero respeta guardrails y permisos.";
const DISABLED = "Deshabilitada: el trabajo para en el PR draft.";
const STAGES: readonly [keyof LifecycleContinuity, string, string][] = [
	["entry", "Entrada tras el PR draft", "/omi-work adopt"], ["review", "Review", "/omi-work review"], ["fix", "Fix", "/omi-work fix"],
	["land", "Land", "/omi-work land"], ["ship", "Ship", "/omi-work ship"],
];
const MEANING: Record<Exclude<ContinuityMode, "manual">, string> = { ask: "pregunta antes de seguir", auto: "sigue sola si los guardrails lo permiten" };

const duration = (seconds: number) => seconds % 60 ? `${seconds} s` : `${seconds / 60} min`;
const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
/** El de la KB si se pudo leer; si no, la última aceptación local, que sólo sirve para observar. */
function shown({ reading, local }: LifecycleOverview): Shown | undefined {
	if (reading.kind === "valid") return { block: reading.block, hash: reading.hash, source: "kb" };
	const accepted = local.kind === "valid" ? local.record.accepted : null;
	return accepted ? { block: accepted.block, hash: accepted.blockHash, source: "local" } : undefined;
}
function statusLine({ state, reading, local }: LifecycleOverview, view: Shown | undefined): string {
	const revision = view?.source === "kb" ? ` · revisión ${view.hash.slice(0, 8)}` : "";
	let detail: string;
	switch (state.status) {
		// Sin bloque, termina en el draft; un bloque aceptado sin Ship corre Review y Land.
		case "unconfigured": detail = lifecycleMissing(state) ? " · el trabajo termina en el PR draft, sin Review, Land ni Ship" : `${revision} · aceptada en esta máquina · Ship sin configurar`; break;
		case "pending": detail = `${revision} · la KB tiene una revisión sin aceptar en esta máquina`; break;
		case "configured": case "manual": case "not-applicable": detail = `${revision} · aceptada en esta máquina`; break;
		// El estado resume «requiere revisión humana»; el bloque inválido de la KB dice qué le falta.
		case "invalid": detail = ` · ${reading.kind === "invalid" ? reading.reason : state.reason}`; break;
		case "unavailable": detail = ` · ${state.reason}`; break;
		default: { const unknown: never = state.status; throw new Error(`Estado lifecycle desconocido: ${String(unknown)}`); }
	}
	const deferred = local.kind === "valid" && state.revision !== null && local.record.deferred?.revision === state.revision;
	const label = state.status === "unconfigured" && !lifecycleMissing(state) ? STATUS.configured : STATUS[state.status];
	return `Estado: ${label}${detail}${deferred ? " · postergado (Más adelante)" : ""}`;
}
function targetText(target: LifecycleTarget): string {
	const provider = target.provider;
	const where = provider.kind === "gha"
		? `GitHub Actions · ${provider.workflow}@${provider.ref} · ${provider.mode} · ${provider.contract === "github-release" ? "release de GitHub" : "recibo omi-ship-v1"}`
		: `OMI · ${provider.service} · ${provider.environment} · ${provider.mode}`;
	return `${target.id} · ${where} · ${target.mode} · si falla: ${target.onFailure.action}`;
}
function shipLines(ship: LifecycleConfig["ship"]): string[] {
	switch (ship.status) {
		case "configured": return ["Ship: configurado", ...ship.targets.map((target) => `  ${targetText(target)}`)];
		case "manual": return ["Ship: manual (sin destino verificable)"];
		case "not-applicable": return ["Ship: no aplica"];
		case "unconfigured": return ["Ship: sin configurar"];
		default: { const unknown: never = ship; throw new Error(`Ship desconocido: ${JSON.stringify(unknown)}`); }
	}
}
function configLines({ review, corrections, land, ship, budget }: LifecycleConfig): string[] {
	return [
		MODES,
		`Review: ${review.mode} · ${reviewProviderText(review.provider)} · espera hasta ${duration(review.timeoutSeconds)}`,
		`Correcciones: ${corrections.mode} · hasta ${count(corrections.maxRounds, "ronda", "rondas")}`,
		`Land: ${land.mode} · base ${land.base} · ${land.method} · riesgo máximo ${land.maxRisk}`,
		...(land.requiredChecks.length ? ["Checks requeridos:", ...land.requiredChecks.map((check) => `  ${check.context} · app ${check.appId}`)] : ["Checks requeridos: ninguno"]),
		...shipLines(ship),
		`Presupuesto: ${count(budget.maxAttempts, "intento", "intentos")} · ${duration(budget.activeSeconds)} activos · ${budget.maxFixForwardPRs} PR fix-forward`,
	];
}
/** null: no hay lifecycle que configurar en este checkout. */
export function lifecycleOverviewLines(input: LifecycleOverview | null): string[] {
	if (!input) return ["No aplica: hace falta un repo de GitHub con producto en la KB."];
	const view = shown(input);
	if (!view) return [statusLine(input, view)];
	return [statusLine(input, view), ...(view.source === "local" ? ["Última aceptada en esta máquina: sólo para observar, no inicia efectos."] : []), ...configLines(view.block)];
}
/** Las cinco palancas con lo que hace cada modo, o la parada en el PR draft si no hay continuidad. */
export function continuityOverviewLines(input: LifecycleOverview | null): string[] {
	if (!input) return ["No aplica."];
	const view = shown(input);
	if (!view) return [input.state.status === "unconfigured" ? DISABLED : "Sin datos: no se pudo leer el lifecycle."];
	const continuity = view.block.continuity;
	if (!continuity) return [DISABLED, "Para seguir con un PR draft: /omi-work adopt. Para configurarla: /omi-setup."];
	return [...STAGES.map(([stage, name, command]) => {
		const mode = continuity[stage];
		return `${name}: ${mode} · ${mode === "manual" ? `espera tu comando: ${command}` : MEANING[mode]}`;
	}), "Continuar no autoriza efectos: cada uno conserva su permiso."];
}
