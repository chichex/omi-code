// Recomendaciones del onboarding lifecycle: qué falta o qué conviene según la config y lo detectado.
// Puras y sin efectos: recomendar no cambia la config ni concede permisos; sólo motiva ofrecer el wizard.
import { REVIEW_CONTRACT } from "./gha-review-contract.ts";
import type { LifecycleConfig } from "./lifecycle-config.ts";
import type { LifecycleDetection } from "./lifecycle-detect.ts";

export type LifecycleRecommendation =
 | { kind: "continuity"; message: string }
 | { kind: "review-gha"; workflows: string[]; message: string };
export const CONTINUITY_MISSING = "Continuidad sin configurar: el trabajo para en el PR draft";
const MAX_REVIEW_WORKFLOWS = 4;

/** Workflows que declaran omi-review-v1, en el orden del detector y acotados para una tanda. */
export function reviewWorkflows(detection: LifecycleDetection | undefined): string[] {
 return (detection?.workflows ?? []).filter(w => w.contract === REVIEW_CONTRACT).map(w => w.file).slice(0, MAX_REVIEW_WORKFLOWS);
}
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
