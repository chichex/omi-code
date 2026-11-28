// Qué hallazgo de seguridad frena Verificar. Un solo lugar: reducer, Land, post-PR, tool, progreso, issue y PR lo
// leen de acá. Falla cerrado: sin severidad, con una inválida o con la lista desalineada, el hallazgo es blocker.
// Un blocker deja de frenar sólo si una persona lo aceptó desde la TUI para ese contenido y con ese texto exacto.
import { MAX_ACCEPTED_RISKS, type AcceptedRisk, type Review, type Severity, type Workflow, type WorkflowV2 } from "./model.ts";

export const FAIL_WITHOUT_FINDINGS = "El lente de seguridad falló sin detallar hallazgos";

/** La severidad de cada hallazgo: aviso sólo si la lista está alineada y lo dice; si no, blocker. */
export function severitiesOf(r: Pick<Review, "findings" | "severities">): Severity[] {
 return r.findings.map((_, i) => r.severities?.length === r.findings.length && r.severities[i] === "aviso" ? "aviso" : "blocker");
}
const failedSecurity = (r: Review): boolean => r.lens === "security" && r.verdict === "fail";
/** Los hallazgos que bloquean: sólo de un fail de security. Un fail sin hallazgos bloquea igual. */
export function securityBlockers(r?: Review): string[] {
 if (!r || !failedSecurity(r)) return [];
 if (!r.findings.length) return [FAIL_WITHOUT_FINDINGS];
 const severities = severitiesOf(r);
 return r.findings.filter((_, i) => severities[i] === "blocker");
}
export const securityBlocks = (r?: Review): boolean => securityBlockers(r).length > 0;
/** Los hallazgos como se muestran: los de un fail de security llevan su severidad adelante. */
export function reviewFindings(r: Review): string[] {
 if (!failedSecurity(r)) return r.findings;
 const severities = severitiesOf(r);
 return r.findings.map((f, i) => `${severities[i]} · ${f}`);
}

/** Lo que una persona aceptó en esta vuelta; un estado V1 no tiene aceptaciones. */
export const acceptedRisksOf = (state: Workflow): AcceptedRisk[] => state.version === 2 ? state.acceptedRisks ?? [] : [];
/** Los blockers de esa revisión que ninguna persona aceptó para su mismo contenido. */
export function unacceptedBlockers(state: Workflow, r?: Review): string[] {
 const accepted = new Set(acceptedRisksOf(state).filter(a => a.fingerprint === r?.fingerprint).flatMap(a => a.findings));
 return securityBlockers(r).filter(f => !accepted.has(f));
}
/** Había blockers y una persona los aceptó todos para este contenido. */
export const riskAccepted = (state: Workflow, r?: Review): boolean => securityBlockers(r).length > 0 && !unacceptedBlockers(state, r).length;
export const latestSecurity = (reviews: readonly Review[], fingerprint: string): Review | undefined => reviews.findLast(r => r.lens === "security" && r.fingerprint === fingerprint);
/** El último security de este contenido tiene un blocker sin aceptar. */
export const contentSecurityBlocks = (state: Workflow, reviews: readonly Review[], fingerprint: string): boolean => unacceptedBlockers(state, latestSecurity(reviews, fingerprint)).length > 0;
function reject(message: string): never { throw new Error(`Harness: ${message}`); }
/** Por qué no entra otra aceptación, o "" si entra. Con el PR adoptado no hay retry ni refresh: el texto da la salida real. */
export function acceptedRiskCap(state: Workflow): string {
 if (acceptedRisksOf(state).length < MAX_ACCEPTED_RISKS) return "";
 return state.version === 2 && state.pullRequest?.ownership === "adopted"
  ? `se llegó al tope de ${MAX_ACCEPTED_RISKS} riesgos aceptados; con el PR adoptado no hay retry, refresh ni extra-round: salí con /omi-work stop y seguí el PR a mano`
  : `se llegó al tope de ${MAX_ACCEPTED_RISKS} riesgos aceptados en esta vuelta; usá retry o /omi-work refresh`;
}
/** Registra la aceptación: tienen que ser exactamente los blockers sin aceptar del último security de ese contenido. */
export function recordAcceptedRisk(state: WorkflowV2, reviews: readonly Review[], risk: { fingerprint: string; findings: string[]; reason: string }, at: string): void {
 const pending = unacceptedBlockers(state, latestSecurity(reviews, risk.fingerprint));
 if (!pending.length) reject("no hay hallazgos de seguridad sin aceptar sobre este contenido");
 if (JSON.stringify(pending) !== JSON.stringify(risk.findings)) reject("los hallazgos aceptados no son los que bloquean este contenido; revisalos otra vez");
 const reason = risk.reason.trim();
 if (!reason) reject("falta el motivo");
 if (reason.length > 2000) reject("el motivo es demasiado largo");
 const cap = acceptedRiskCap(state);
 if (cap) reject(cap);
 state.acceptedRisks = [...acceptedRisksOf(state), { fingerprint: risk.fingerprint, findings: [...risk.findings], reason, at }];
}
