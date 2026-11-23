// Recomendaciones del onboarding lifecycle: qué falta o qué conviene según la config y lo detectado.
// Puras y sin efectos: recomendar no cambia la config ni concede permisos; sólo motiva ofrecer el wizard.
import { REVIEW_CONTRACT } from "./gha-review-contract.ts";
import type { LifecycleConfig } from "./lifecycle-config.ts";
import type { LifecycleDetection, ReviewTuning } from "./lifecycle-detect.ts";

export type LifecycleRecommendation =
 | { kind: "continuity"; message: string }
 | { kind: "review-gha"; workflows: string[]; message: string };
export const CONTINUITY_MISSING = "Continuidad sin configurar: el trabajo para en el PR draft";
const MAX_REVIEW_WORKFLOWS = 4;

export interface ReviewCandidate { file: string; tuning: ReviewTuning }
/** Workflows que declaran omi-review-v1, con el model/effort que acepta cada uno, en el orden del detector y acotados para una tanda. */
export function reviewCandidates(detection: LifecycleDetection | undefined): ReviewCandidate[] {
 return (detection?.workflows ?? []).flatMap(w => w.contract === REVIEW_CONTRACT ? [{ file: w.file, tuning: w.tuning }] : []).slice(0, MAX_REVIEW_WORKFLOWS);
}
export const reviewWorkflows = (detection: LifecycleDetection | undefined): string[] => reviewCandidates(detection).map(w => w.file);
/** `block` null es sin configuración: Review local por defecto y sin continuidad. Sin detección no recomienda GHA. */
export function lifecycleRecommendations(block: LifecycleConfig | null, detection: LifecycleDetection | undefined): LifecycleRecommendation[] {
 const out: LifecycleRecommendation[] = [];
 if (!block?.continuity) out.push({ kind: "continuity", message: CONTINUITY_MISSING });
 const workflows = reviewWorkflows(detection);
 if (workflows.length && (!block || block.review.provider.kind === "local")) {
  out.push({ kind: "review-gha", workflows, message: `Review por GitHub Actions disponible: ${workflows.join(", ")} cumple ${REVIEW_CONTRACT}; hoy revisa el revisor local` });
 }
 return out;
}
