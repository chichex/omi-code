// /omi-work accept-risk: una persona acepta, en la TUI, los blockers de security que no aplican al contenido actual.
// Ninguna tool lo expone: ni el agente, ni el chat, ni un cliente RPC aceptan un riesgo. Retry, refresh y replan lo borran;
// con el PR adoptado, una ronda de corrección conserva sólo lo aceptado sobre el HEAD del que parte.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Review, Workflow } from "../harness/model.ts";
import { executionReviews } from "../harness/execution-scope.ts";
import { inspectCheckout } from "../harness/git.ts";
import { acceptedRiskCap, latestSecurity, reviewFindings, securityBlockers, unacceptedBlockers } from "../harness/security-blockers.ts";
import type { ApprovalDocument, ApprovalLine } from "./development-approval.ts";
import { showApprovalReview } from "./development-approval-view.ts";
import { updateIssueSection } from "./development-issue.ts";
import type { DevelopmentSession } from "./development-session.ts";

const TITLE = "Aceptar riesgo de seguridad";
const MAX_REASON = 2000;
const line = (text: string): ApprovalLine => ({ kind: "text", text });

// Una revisión parcial no juzgó alguna parte y security no se repite sobre este contenido: aceptar la deja sin revisar.
function partialSection(review: Review | undefined): ApprovalDocument["sections"] {
	if (!review?.partial) return [];
	const blockers = new Set(securityBlockers(review));
	const avisos = reviewFindings(review).filter((_, i) => !blockers.has(review.findings[i]!));
	return [{ id: "partial", title: "Revisión parcial", lines: [
		line("Seguridad no juzgó todas las partes del cambio: alguna quedó sin resultado o unknown. Aceptar no las revisa, y sobre este contenido seguridad no se vuelve a correr. Para que se revisen, no aceptes: el agente usa retry."),
		...avisos.map((f) => line(`• ${f}`))] }];
}
/** Lo que la persona revisa antes de aceptar: los hallazgos, si la revisión fue parcial, qué implica y el contenido exacto. */
export function acceptRiskDocument(state: Workflow, head: string, fingerprint: string, findings: string[], review?: Review): ApprovalDocument {
	return { title: TITLE, sections: [
		{ id: "findings", title: "Hallazgos que bloquean", lines: findings.map((f) => line(`• ${f}`)) },
		...partialSection(review),
		{ id: "meaning", title: "Qué implica", lines: [
			line("Deja de frenar Verificar y Land (también el merge automático) para este contenido. Si un amend no toca su archivo y seguridad repite el mismo texto, sigue sin frenar, salvo un secreto o una exfiltración. Si su archivo cambia, o después de un retry, seguridad lo vuelve a evaluar."),
			line("Con el PR adoptado, se descarta cuando una ronda de corrección parte de otro HEAD."),
			line("No corrige nada ni autoriza push, merge, comandos ni workflows."),
			line("Queda en el estado del trabajo, en la sección del issue y en el PR draft."),
			line("Después de Ctrl+S se pide el motivo. Esc o un motivo vacío no aceptan nada.")] },
		{ id: "content", title: "Contenido", lines: [line(`Issue #${state.source.number} · ${state.source.title}`), line(`HEAD: ${head}`), line(`Huella: ${fingerprint}`)] },
	] };
}
/** true sólo si la persona aceptó: Esc, un motivo vacío o un trabajo pausado no relanzan al agente. */
export async function acceptRisk(session: DevelopmentSession, ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`${TITLE}: requiere la TUI interactiva de OMI; lo decide una persona, no el agente ni un cliente RPC.`);
	// Adopta el estado vigente aunque el vínculo de esta sesión esté atrasado, como resume, pero no reanuda nada.
	await session.restore(ctx, true);
	const state = session.current(ctx);
	if (state.phase !== "verify") throw new Error(`${TITLE}: sólo en Verificar; el trabajo está en ${state.phase}.`);
	// Como extra-round: el tope se dice antes de la revisión, no después de que la persona escribió el motivo.
	const cap = acceptedRiskCap(state);
	if (cap) throw new Error(`${TITLE}: ${cap}.`);
	const snapshot = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal);
	if (!snapshot.clean) throw new Error(`${TITLE}: hay cambios sin commitear; el riesgo se acepta sobre el contenido commiteado.`);
	const review = latestSecurity(executionReviews(state), snapshot.fingerprint), findings = unacceptedBlockers(state, review);
	if (!findings.length) throw new Error("No hay hallazgos de seguridad sin aceptar sobre el contenido actual.");
	const cancellation = AbortSignal.any([session.lifecycle.signal, ...(ctx.signal ? [ctx.signal] : [])]);
	session.emit(`Esperando revisión · ${TITLE}`, true);
	let reason: string | undefined;
	try {
		if (!(await showApprovalReview(ctx, acceptRiskDocument(state, snapshot.head, snapshot.fingerprint, findings, review), cancellation))) return false;
		reason = (await ctx.ui.input(`${TITLE} · motivo`, "Por qué es aceptable (por ejemplo: preexistente en main, se sigue en #N)", { signal: cancellation }))?.trim();
	} finally { session.emit(); }
	if (!reason) return false;
	if (reason.length > MAX_REASON) throw new Error(`El motivo es demasiado largo (más de ${MAX_REASON} caracteres); resumilo y volvé a aceptar.`);
	// Una revisión larga no acepta un trabajo que avanzó en otra ventana ni un código que cambió mientras tanto.
	await session.assertUnchanged(state, ctx);
	const again = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal);
	if (!again.clean || again.fingerprint !== snapshot.fingerprint) throw new Error("El código cambió durante la revisión; no se aceptó nada.");
	cancellation.throwIfAborted();
	const accepted = await session.apply({ type: "risk_accepted", fingerprint: snapshot.fingerprint, findings, reason }, ctx);
	await updateIssueSection(session, ctx);
	ctx.ui.notify(`Riesgo aceptado sobre ${snapshot.fingerprint.slice(0, 12)}: ${findings.length} hallazgo(s) dejan de frenar Verificar y Land para este contenido y, repetidos tras un amend que no toca su archivo, para el siguiente.${accepted.status === "paused" ? " Seguí con /omi-work resume." : ""}`, "info");
	return true;
}
