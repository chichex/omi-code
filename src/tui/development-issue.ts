// La sección del harness en el issue documenta el trabajo, no lo autoriza: si no se puede escribir,
// se avisa y el trabajo sigue. El estado local es la fuente de verdad.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncIssueSection } from "../harness/github.ts";
import type { DevelopmentSession } from "./development-session.ts";

// Devuelve el aviso, si lo hubo, para que la tool se lo informe también al agente.
export async function updateIssueSection(session: DevelopmentSession, ctx: ExtensionContext): Promise<string> {
	const state = session.state;
	if (!state) return "";
	if (session.offline) return "Sin conexión: la sección del issue se actualiza en el próximo punto de control.";
	// Una aprobación autoriza la sección. Sin receta aprobada (por ejemplo, tras un acuerdo que la rehace)
	// sólo se mantiene la que ya existe; antes del primer sí no se escribe nada en el issue.
	try { await syncIssueSection(state, session.runner, session.lifecycle.signal, { onlyIfPresent: !state.approval }); return ""; }
	catch (error) {
		const warning = `No se actualizó la sección del harness en el issue #${state.source.number}: ${error instanceof Error ? error.message : "error de GitHub"}. El trabajo sigue.`;
		ctx.ui.notify(warning, "warning"); return warning;
	}
}
