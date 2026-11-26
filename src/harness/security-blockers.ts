// Qué hallazgo de seguridad frena Verificar. Un solo lugar: reducer, Land, post-PR, tool, progreso, issue y PR lo
// leen de acá. Falla cerrado: sin severidad, con una inválida o con la lista desalineada, el hallazgo es blocker.
import type { Review, Severity } from "./model.ts";

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
