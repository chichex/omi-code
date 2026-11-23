// Un solo PR cuando la entrada del lifecycle encadena: la cadena adopta el PR draft al publicarlo y no adopta stacks.
// Sólo lee la configuración aceptada. Si no se puede leer (KB caída, cambios sin aceptar, sin configurar u offline),
// vale lo de siempre: el stack se permite y, si se publica, la cadena pausa sin efectos.
import type { Workflow } from "../harness/model.ts";
import { acceptedPin } from "./development-lifecycle.ts";
import type { DevelopmentSession } from "./development-session.ts";

/** El error para el modelo al registrar una spec con stack: qué pasa y cómo seguir. */
export const SINGLE_PR_REJECTED = "Este repo encadena el lifecycle (entrada auto o ask): la cadena adopta un solo PR y no adopta stacks. Mandá specified otra vez sin stack, con los mismos pasos C; el trabajo sale en un solo PR draft.";

/** true sólo con un lifecycle aceptado cuya entrada sea auto o ask. */
export async function singlePrRequired(session: DevelopmentSession, state: Workflow): Promise<boolean> {
	if (state.version !== 2 || session.offline) return false;
	try {
		const entry = (await acceptedPin(session, state)).accepted.block.continuity?.entry;
		return entry === "auto" || entry === "ask";
	} catch { return false; }
}

const planning = new WeakMap<DevelopmentSession, { key: string; single: boolean }>();
/** Para la guía de la receta y de la spec: una lectura por revisión del trabajo, no una por turno. Afuera de esas etapas, no lee.
 * Es sólo la guía: el rechazo de specified vuelve a leer la configuración. */
export async function singlePrPlanning(session: DevelopmentSession, state: Workflow): Promise<boolean> {
	if (state.phase !== "recipe" && state.phase !== "spec") return false;
	const key = `${state.id}:${state.revision}`, cached = planning.get(session);
	if (cached?.key === key) return cached.single;
	const single = await singlePrRequired(session, state);
	planning.set(session, { key, single });
	return single;
}
