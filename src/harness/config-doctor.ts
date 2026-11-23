// Diagnóstico de lo que falta configurar para el harness: Foundations, lifecycle y proyecto OMI.
// Puro y sin I/O: recibe lo que la sesión ya leyó. Decide qué parte del setup corre, nunca la corre.
// Una KB caída u offline es «no disponible», nunca «falta»: sin lectura no se ofrece nada.
import type { FoundationsReading } from "../tui/development-foundations.ts";
import type { TrustInspection } from "./foundations-trust.ts";
import type { LifecycleDetection } from "./lifecycle-detect.ts";
import { shouldOfferLifecycleOnboarding, type LifecycleOnboardingState } from "./lifecycle-onboarding.ts";
import type { LifecycleTrustReading } from "./lifecycle-trust.ts";

export type ConfigStatus = "ok" | "falta" | "formato-anterior" | "pendiente" | "invalido" | "no-disponible" | "postergado" | "no-aplica";
export type ConfigArea = "foundations" | "lifecycle" | "omi-project";
export interface ConfigItem { id: "foundations" | "lifecycle" | "lifecycle-continuity" | "lifecycle-review" | "omi-project"; area: ConfigArea; status: ConfigStatus; message: string; resolve: string }
/** `run`: el setup la ofrece solo. `deferred`: la persona dijo «Más adelante» a esa revisión; sólo /omi-setup la corre. */
export type SetupPart = { kind: "run" | "deferred"; revision: string } | { kind: "none" };
export interface ConfigDiagnosis { items: ConfigItem[]; foundations: SetupPart; lifecycle: SetupPart }
export interface ConfigDoctorInput {
	foundations: { reading: FoundationsReading; local: TrustInspection };
	/** null: sin repo de GitHub con producto en la KB, no hay lifecycle que configurar. */
	lifecycle: { state: LifecycleOnboardingState; local: LifecycleTrustReading } | null;
	/** El vínculo `.omi/project.json` del detector; undefined si no se pudo leer. */
	omi: LifecycleDetection["omi"] | undefined;
}
export const FORMATO_ANTERIOR = "Tu configuración de Foundations es de un formato anterior que ya no se usa: configurala de nuevo.";
const NONE: SetupPart = { kind: "none" };
const LATER = " Postergado para esta revisión.";
// Estados que el setup resuelve corriendo su parte; el resto informa.
const RESOLVABLE: readonly ConfigStatus[] = ["falta", "formato-anterior", "pendiente", "invalido"];

type FoundationsItem = Omit<ConfigItem, "id" | "area">;
/** Sin bloque v2 aceptado (ni en la KB ni el último local) es lo que falta; la revisión identifica qué vio la persona. */
function foundationsStatus(reading: FoundationsReading, local: TrustInspection): { item: FoundationsItem; revision: string | null } {
	if (reading.kind === "none") return { item: { status: "no-aplica", message: `Foundations no aplica: ${reading.reason}.`, resolve: "Hace falta un origin en github.com cuyo nombre sea un producto tuyo en la KB." }, revision: null };
	if (reading.kind === "unavailable") return { item: { status: "no-disponible", message: `No se pudo leer Foundations: ${reading.reason}.`, resolve: "Revisá el login de la KB en /mcp o la red, y volvé con /omi-setup." }, revision: null };
	if (reading.kind === "valid") return { item: { status: "ok", message: `Foundations en la KB · revisión ${reading.hash.slice(0, 8)}.`, resolve: "Para cambiarlo: /omi-foundations." }, revision: null };
	const accepted = local.kind === "valid" && local.record.accepted !== null;
	if (reading.kind === "invalid" && !reading.legacy) {
		return { item: { status: "invalido", message: `El bloque de Foundations de la KB es inválido (${reading.reason}). ${accepted ? "Vale la última revisión aceptada." : "Rige el default: nada pregunta."}`, resolve: "Configuralo de nuevo con /omi-setup: empieza de cero, sin heredar permisos." }, revision: `foundations:invalid:${reading.reason}` };
	}
	const revision = reading.kind === "invalid" ? "foundations:legacy" : "foundations:missing";
	if (accepted) return { item: { status: "ok", message: `La KB no tiene Foundations para ${reading.key.repo}: vale la última revisión aceptada en esta máquina.`, resolve: "Para guardarla en la KB: /omi-foundations." }, revision: null };
	if (reading.kind === "invalid" || local.kind === "legacy") return { item: { status: "formato-anterior", message: FORMATO_ANTERIOR, resolve: "Con /omi-setup: empieza de cero, sin heredar comandos ni políticas." }, revision };
	if (local.kind === "invalid") return { item: { status: "invalido", message: "El registro local de Foundations no se puede leer y la KB no tiene Foundations: rige el default, nada pregunta.", resolve: "Configuralo con /omi-setup." }, revision };
	return { item: { status: "falta", message: `Sin Foundations para ${reading.key.repo}: rige el default, nada pregunta.`, resolve: "Con /omi-setup armás las reglas y políticas; sólo Guardar escribe." }, revision };
}
function foundationsPart(input: ConfigDoctorInput["foundations"]): { item: ConfigItem; part: SetupPart } {
	const { item, revision } = foundationsStatus(input.reading, input.local);
	const base: ConfigItem = { id: "foundations", area: "foundations", ...item };
	if (!revision || !RESOLVABLE.includes(item.status)) return { item: base, part: NONE };
	const deferred = input.local.kind === "valid" && input.local.record.deferred?.revision === revision;
	return deferred ? { item: { ...base, status: "postergado", message: `${base.message}${LATER}` }, part: { kind: "deferred", revision } } : { item: base, part: { kind: "run", revision } };
}

const LIFECYCLE_RESOLVE = "/omi-setup u omi init --development.";
function lifecycleItems(state: LifecycleOnboardingState): ConfigItem[] {
	const item = (status: ConfigStatus, message: string, resolve: string): ConfigItem => ({ id: "lifecycle", area: "lifecycle", status, message, resolve });
	switch (state.status) {
		case "unavailable": return [item("no-disponible", `No se pudo leer el lifecycle: ${state.reason}.`, "Revisá el login de la KB en /mcp o la red.")];
		case "invalid": return [item("invalido", `${state.reason}.`, "Revisá el bloque lifecycle de las perillas en la KB o corré omi init --development en una terminal.")];
		case "unconfigured": return [item("falta", "Sin lifecycle: el trabajo termina en el PR draft, sin Review, Land ni Ship.", LIFECYCLE_RESOLVE)];
		case "pending": return [item("pendiente", "La KB tiene una revisión del lifecycle sin aceptar en esta máquina.", "/omi-setup muestra el resumen y pide el sí.")];
		case "configured": case "manual": case "not-applicable": return [item("ok", `Lifecycle aceptado · Ship ${state.status}.`, `Para cambiarlo: ${LIFECYCLE_RESOLVE}`)];
		default: { const unknown: never = state.status; throw new Error(`Estado lifecycle desconocido: ${String(unknown)}`); }
	}
}
function recommendationItems(state: LifecycleOnboardingState): ConfigItem[] {
	return state.recommendations.flatMap((recommendation): ConfigItem[] => {
		switch (recommendation.kind) {
			// Sin lifecycle, la continuidad es parte del mismo «falta».
			case "continuity": return state.status === "unconfigured" ? [] : [{ id: "lifecycle-continuity", area: "lifecycle", status: "falta", message: `${recommendation.message}.`, resolve: "/omi-setup configura la entrada y cada etapa de la continuidad." }];
			case "review-gha": return [{ id: "lifecycle-review", area: "lifecycle", status: "pendiente", message: `${recommendation.message}.`, resolve: "/omi-setup propone pasar la Review a GitHub Actions." }];
			default: { const unknown: never = recommendation; throw new Error(`Recomendación desconocida: ${JSON.stringify(unknown)}`); }
		}
	});
}
function lifecyclePart(input: ConfigDoctorInput["lifecycle"]): { items: ConfigItem[]; part: SetupPart } {
	if (!input) return { items: [{ id: "lifecycle", area: "lifecycle", status: "no-aplica", message: "Lifecycle no aplica: hace falta un repo de GitHub con producto en la KB.", resolve: "" }], part: NONE };
	const { state, local } = input;
	const items = [...lifecycleItems(state), ...recommendationItems(state)];
	const wanted = state.revision !== null && items.some((i) => RESOLVABLE.includes(i.status)) && state.status !== "invalid";
	if (!wanted || !state.revision) return { items, part: NONE };
	if (shouldOfferLifecycleOnboarding("harness", state, local)) return { items, part: { kind: "run", revision: state.revision } };
	// Lo único que frena una revisión que haría falta es su «Más adelante».
	return { items: items.map((i) => RESOLVABLE.includes(i.status) ? { ...i, status: "postergado", message: `${i.message}${LATER}` } : i), part: { kind: "deferred", revision: state.revision } };
}
function omiItem(omi: ConfigDoctorInput["omi"]): ConfigItem {
	const item = (status: ConfigStatus, message: string, resolve: string): ConfigItem => ({ id: "omi-project", area: "omi-project", status, message, resolve });
	if (omi === undefined) return item("no-disponible", "No se pudo leer .omi/project.json.", "Se vuelve a leer al abrir la sesión.");
	// Vincular crea recursos en omi-api: sólo se informa, nunca se corre solo.
	if (omi === null) return item("falta", "Sin proyecto OMI vinculado: Ship no propone destinos OMI.", "omi init en una terminal lo vincula y crea recursos en OMI: no se corre solo.");
	if (omi === "invalid") return item("invalido", ".omi/project.json no es válido: Ship no propone destinos OMI.", "Revisalo o volvé a correr omi init en una terminal.");
	return item("ok", `Proyecto OMI ${omi.organization}/${omi.project} · ${omi.services.join(", ") || "sin servicios"}.`, "");
}

export function diagnoseConfig(input: ConfigDoctorInput): ConfigDiagnosis {
	const foundations = foundationsPart(input.foundations), lifecycle = lifecyclePart(input.lifecycle);
	return { items: [foundations.item, ...lifecycle.items, omiItem(input.omi)], foundations: foundations.part, lifecycle: lifecycle.part };
}

const AREAS: Record<ConfigArea, string> = { foundations: "Foundations", lifecycle: "Lifecycle", "omi-project": "Proyecto OMI" };
const LABELS: Record<ConfigStatus, string> = { ok: "ok", falta: "falta", "formato-anterior": "formato anterior", pendiente: "pendiente", invalido: "inválido", "no-disponible": "no disponible", postergado: "postergado", "no-aplica": "no aplica" };
const MARKS: Record<ConfigStatus, string> = { ok: "✓", falta: "✗", "formato-anterior": "✗", pendiente: "△", invalido: "✗", "no-disponible": "?", postergado: "…", "no-aplica": "·" };
/** Vertical, una línea por ítem y su cómo resolver debajo: para /omi-setup cuando no hay nada que correr. */
export function configLines(diagnosis: ConfigDiagnosis): string[] {
	return ["Configuración de OMI:", ...diagnosis.items.flatMap((i) => [`${MARKS[i.status]} ${AREAS[i.area]} · ${LABELS[i.status]}: ${i.message}`, ...(i.status !== "ok" && i.resolve ? [`  ${i.resolve}`] : [])])];
}
