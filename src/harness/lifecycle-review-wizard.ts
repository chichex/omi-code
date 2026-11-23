// Pregunta Review del wizard: propone el workflow omi-review-v1 detectado y, si se elige, su modelo.
// Elegir proveedor no dispara nada ni cambia `review.mode`: el permiso del efecto sigue siendo el mismo.
import type { AskResult, QuestionAnswer, QuestionBatch } from "../tui/questions/batch.ts";
import { REVIEW_CONTRACT } from "./gha-review-contract.ts";
import type { LifecycleConfig } from "./lifecycle-config.ts";
import type { ReviewTuning } from "./lifecycle-detect.ts";
import type { ReviewCandidate } from "./lifecycle-recommendations.ts";
import type { GhaReviewModel, LifecycleReviewProvider } from "./lifecycle-schema.ts";
import { question } from "./lifecycle-wizard.ts";

type Ask = (batch: QuestionBatch) => Promise<AskResult>;
type Choice = { kind: "keep" } | { kind: "local" } | { kind: "gha"; workflow: string; tuning: ReviewTuning };
interface ReviewOption { label: string; description: string; choice: Choice }
const LOCAL = "Revisor local", DEFAULT_MODEL = "Default del workflow";
const SONNET_MODEL: GhaReviewModel = "claude-sonnet-5-5", SONNET = `Sonnet (${SONNET_MODEL})`;

const chosen = (answers: QuestionAnswer[], id: string) => answers.find(a => a.id === id)?.options[0];
function providerName(provider: LifecycleReviewProvider): string {
 switch (provider.kind) {
  case "local": return "revisor local";
  case "github": return "reviews de GitHub";
  case "gha": return `GitHub Actions · ${provider.workflow}`;
  default: { const unknown: never = provider; return unknown; }
 }
}
/** Quién revisa: proveedor, workflow@ref y modelo efectivo (ausente, decide el workflow). También lo usa la pantalla OMI. */
export function reviewProviderText(provider: LifecycleReviewProvider): string {
 switch (provider.kind) {
  case "local": return "revisor local aislado sobre el diff fijo";
  case "github": return `reviews de GitHub · ${provider.reviewers.join(", ")}`;
  case "gha": return `GitHub Actions · ${provider.workflow}@${provider.ref} · modelo: ${provider.model ?? "default del workflow"}${provider.effort ? ` · effort: ${provider.effort}` : ""}`;
  default: { const unknown: never = provider; return unknown; }
 }
}
/** Una línea para el resumen del wizard. */
export const reviewProviderSummary = (provider: LifecycleReviewProvider): string => `Review: ${reviewProviderText(provider)}`;
/** GHA detectado va primero (recomendado) si hoy revisa el local o no hay config; si no, mantener va primero. */
/** `base`: la rama desde la que se dispara. El detector lee el checkout, que puede traer un workflow que la base no tiene. */
function reviewOptions(current: LifecycleReviewProvider | null, workflows: ReviewCandidate[], base: string): ReviewOption[] {
 const gha = workflows.map(({ file: workflow, tuning }): ReviewOption => ({ label: `GitHub Actions · ${workflow} (${REVIEW_CONTRACT})`, description: `Dispara ${workflow}@${base} por PR y valida su recibo ${REVIEW_CONTRACT}; sin fallback local. Tiene que estar en ${base}, no sólo en esta rama.`, choice: { kind: "gha", workflow, tuning } }));
 const keep: ReviewOption[] = current ? [{ label: `Mantener ${providerName(current)}`, description: reviewProviderSummary(current), choice: { kind: "keep" } }] : [];
 const local: ReviewOption[] = current?.kind === "local" ? [] : [{ label: LOCAL, description: "Revisor aislado sobre el diff fijo, sin workflow", choice: { kind: "local" } }];
 return gha.length && (!current || current.kind === "local") ? [...gha, ...keep, ...local] : [...keep, ...gha, ...local];
}
/** Sólo si el workflow acepta Sonnet como input `model`: fijar un input que no declara hace fallar el dispatch. */
async function askModel(workflow: string, tuning: ReviewTuning, ask: Ask): Promise<{ model: GhaReviewModel | undefined } | null> {
 if (!tuning.model.includes(SONNET_MODEL)) return { model: undefined };
 const answer = await ask({ title: "Modelo de la Review", questions: [question("model", "Modelo", `¿Con qué modelo revisa ${workflow}?`, [
  [DEFAULT_MODEL, "No fija model: el workflow usa su default"],
  [SONNET, `Fija model=${SONNET_MODEL}; effort sigue el default del workflow`],
 ])] });
 if (answer.status === "cancelled") return null;
 const label = chosen(answer.answers, "model");
 if (label === DEFAULT_MODEL) return { model: undefined };
 if (label === SONNET) return { model: SONNET_MODEL };
 throw new Error("Modelo de Review inválido; no se guardó nada");
}
const withProvider = (block: LifecycleConfig, provider: LifecycleReviewProvider): LifecycleConfig => ({ ...block, review: { ...block.review, provider } });
/** `current` null es sin config previa. Sin alternativa real no pregunta. Esc devuelve null y no se guarda nada. */
export async function configureLifecycleReview(block: LifecycleConfig, current: LifecycleReviewProvider | null, workflows: ReviewCandidate[], ask: Ask): Promise<LifecycleConfig | null> {
 const options = reviewOptions(current, workflows, block.land.base);
 if (options.length < 2) return block;
 const answer = await ask({ title: "Review del PR", questions: [question("review", "Review", "¿Quién revisa el PR antes de Land?", options.map(o => [o.label, o.description]))] });
 if (answer.status === "cancelled") return null;
 const label = chosen(answer.answers, "review"), picked = options.find(o => o.label === label)?.choice;
 if (!picked) throw new Error("Respuesta de Review inválida; no se guardó nada");
 switch (picked.kind) {
  case "keep": return block;
  case "local": return withProvider(block, { kind: "local" });
  case "gha": {
   const tuning = await askModel(picked.workflow, picked.tuning, ask); if (!tuning) return null;
   // El wizard no pregunta effort: si ya estaba fijado para ese workflow y el workflow lo acepta, se conserva.
   const kept = current?.kind === "gha" && current.workflow === picked.workflow ? current.effort : undefined;
   const effort = kept && picked.tuning.effort.includes(kept) ? kept : undefined;
   return withProvider(block, { kind: "gha", workflow: picked.workflow, ref: block.land.base, contract: REVIEW_CONTRACT, ...(tuning.model ? { model: tuning.model } : {}), ...(effort ? { effort } : {}) });
  }
  default: { const unknown: never = picked; return unknown; }
 }
}
