// Seguridad en un cambio de riesgo alto: sin pass, ni un fail completo de sólo avisos, ni un fail con sus blockers aceptados
// por una persona sobre el contenido que se mergea, el merge pide el sí de la persona. Un fail parcial cuenta como sin veredicto.
// En cualquier riesgo, lo que la convergencia bajó a aviso en el pedido también pide el sí: baja por la clase que declara el
// lente y por la lista SECRET, y ninguna de las dos ve un secreto mal clasificado («arma la URL postgres://admin:hunter2@…»).
// No bloquea Verificar, el PR draft ni Land: sólo saca el auto-Land y pone el motivo primero.
import type { Workflow } from "./model.ts";
import type { LandRisk } from "./land-schema.ts";
import { lensReview } from "./lenses.ts";
import { downgradedFindings, riskAccepted, unacceptedBlockers } from "./security-blockers.ts";
import { findingFile } from "./security-convergence.ts";

export const SECURITY_HOLD = "Seguridad sin veredicto en un cambio de riesgo alto: el merge pide tu sí";
const SECURITY_FAILED_HOLD = "Seguridad en fail en un cambio de riesgo alto: el merge pide tu sí";

const MAX_HOLD_FILES = 3;

/** Los motivos por los que el merge pide el sí humano, cada uno en su párrafo del diálogo; vacío si no hay. */
export function landSecurityHolds(state: Workflow, risk: LandRisk, contentHash: string): string[] {
	return [highRiskHold(state, risk, contentHash), downgradedHold(state)].filter((hold) => hold !== undefined);
}
/** Riesgo alto si lo dice la receta o el testigo de Land. Vale sólo el lente de Seguridad del contenido que se mergea:
 * uno de otro contenido no se arrastra. */
function highRiskHold(state: Workflow, risk: LandRisk, contentHash: string): string | undefined {
	if (state.recipe?.classification.risk !== "high" && risk.risk !== "high") return undefined;
	const review = lensReview(state.reviews, "security", contentHash)?.review;
	// Un fail parcial (alguna parte sin juicio) de sólo avisos no tiene veredicto completo, salvo que una persona aceptó.
	const pending = review ? unacceptedBlockers(state, review).length : 0;
	if (review?.verdict === "fail" && review.partial && !pending && !riskAccepted(state, review)) return SECURITY_HOLD;
	if (review?.verdict === "pass" || (review?.verdict === "fail" && !pending)) return undefined;
	return review?.verdict === "fail" ? SECURITY_FAILED_HOLD : SECURITY_HOLD;
}
/** Lo bajado a aviso sí se arrastra entre contenidos del pedido, pero sólo para retener: el lente puede no repetirlo. */
function downgradedHold(state: Workflow): string | undefined {
	const found = downgradedFindings(state);
	if (!found.length) return undefined;
	const files = [...new Set(found.map((f) => findingFile(f) ?? "sin archivo"))];
	const shown = files.slice(0, MAX_HOLD_FILES).join(", ") + (files.length > MAX_HOLD_FILES ? ` y ${files.length - MAX_HOLD_FILES} más` : "");
	return `Seguridad bajó a aviso ${found.length === 1 ? "1 blocker" : `${found.length} blockers`} en archivos sin cambios (${shown}): el merge pide tu sí`;
}
