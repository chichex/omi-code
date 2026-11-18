// La sección del harness en el issue documenta el trabajo, no lo autoriza: si no se puede escribir,
// se avisa y el trabajo sigue. El estado local es la fuente de verdad.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncIssueSection } from "../harness/github.ts";
import type { DevelopmentSession } from "./development-session.ts";

// Devuelve el aviso, si lo hubo, para que la tool se lo informe también al agente.
export async function updateIssueSection(session: DevelopmentSession, ctx: ExtensionContext): Promise<string> {
	const state = session.state;
	// Antes del sí a una receta no se escribe en el issue: la aprobación es la que lo autoriza.
	if (!state?.approval) return "";
	if (session.offline) return "Sin conexión: la sección del issue se actualiza en el próximo punto de control.";
	try { await syncIssueSection(state, session.runner, session.lifecycle.signal); return ""; }
	catch (error) {
		const warning = `No se actualizó la sección del harness en el issue #${state.source.number}: ${error instanceof Error ? error.message : "error de GitHub"}. El trabajo sigue.`;
		ctx.ui.notify(warning, "warning"); return warning;
	}
}
