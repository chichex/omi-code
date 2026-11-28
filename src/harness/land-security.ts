// Seguridad en un cambio de riesgo alto: sin pass, ni un fail completo de sólo avisos, ni un fail con sus blockers aceptados
// por una persona sobre el contenido que se mergea, el merge pide el sí de la persona. Un fail parcial cuenta como sin veredicto.
// No bloquea Verificar, el PR draft ni Land: sólo saca el auto-Land y pone el motivo primero.
import type { Workflow } from "./model.ts";
import type { LandRisk } from "./land-schema.ts";
import { lensReview } from "./lenses.ts";
import { riskAccepted, unacceptedBlockers } from "./security-blockers.ts";

export const SECURITY_HOLD = "Seguridad sin veredicto en un cambio de riesgo alto: el merge pide tu sí";
const SECURITY_FAILED_HOLD = "Seguridad en fail en un cambio de riesgo alto: el merge pide tu sí";

/** El motivo por el que el merge pide el sí humano, o undefined. Riesgo alto si lo dice la receta o el testigo de
 * Land. Vale sólo el lente de Seguridad del contenido que se mergea: uno de otro contenido no se arrastra. */
export function landSecurityHold(state: Workflow, risk: LandRisk, contentHash: string): string | undefined {
	if (state.recipe?.classification.risk !== "high" && risk.risk !== "high") return undefined;
	const review = lensReview(state.reviews, "security", contentHash)?.review;
	// Un fail parcial (alguna parte sin juicio) de sólo avisos no tiene veredicto completo, salvo que una persona aceptó.
	const pending = review ? unacceptedBlockers(state, review).length : 0;
	if (review?.verdict === "fail" && review.partial && !pending && !riskAccepted(state, review)) return SECURITY_HOLD;
	if (review?.verdict === "pass" || (review?.verdict === "fail" && !pending)) return undefined;
	return review?.verdict === "fail" ? SECURITY_FAILED_HOLD : SECURITY_HOLD;
}
