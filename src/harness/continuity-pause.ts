// Motivo durable de la pausa de la continuidad: un código cerrado, la etapa y el sujeto en que se tomó.
// Proyectarlo no reanuda la cadena ni concede efectos; el texto para la persona vive en continuity-pause-text.ts.
import { Type, type Static } from "typebox";
import { LifecycleContinuitySchema } from "./lifecycle-schema.ts";
import type { Workflow, WorkflowV2 } from "./model.ts";

/** Los elige el selector puro con el estado y la configuración vigentes. */
export const SELECTED_PAUSES = ["workflow-paused", "workflow-waiting", "workflow-blocked", "publication-required", "entry-trigger-required",
 "manual", "config-required", "subject-required", "lifecycle-paused", "operation-unsettled", "operation-failed", "budget-exhausted",
 "review-facts-required", "human-required", "rounds-exhausted", "correction-failed", "correction-facts-required", "ship-unconfigured",
 "ship-manual", "activity-unsettled", "stack-unsupported"] as const;
/** Los decide el host al ejecutar: un no, un error (su texto va como detalle) o la continuidad quitada a mitad de cadena. */
export const HOST_PAUSES = ["declined", "not-adopted", "no-progress", "continuity-disabled", "error"] as const;
export const CONTINUITY_PAUSES = [...SELECTED_PAUSES, ...HOST_PAUSES] as const;
export type SelectedPause = (typeof SELECTED_PAUSES)[number];
export type ContinuityPause = (typeof CONTINUITY_PAUSES)[number];

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
export const ContinuityPauseSchema = Type.Object({
 reason: Type.Enum(CONTINUITY_PAUSES),
 stage: Type.Optional(Type.KeyOf(LifecycleContinuitySchema)),
 /** Sujeto vigente al pausar: con lifecycle, el adoptado; antes de adoptar, el HEAD publicado. */
 subjectId: Type.Optional(text(256)),
 /** Última operación conocida al pausar. Una posterior es una operación en curso o ya hecha: la pausa quedó atrás. */
 lastOperationId: Type.Optional(text(256)),
 /** Texto libre de un rechazo o error del efecto. Acompaña al código; nunca lo reemplaza. */
 detail: Type.Optional(text(1000)),
 /** Sólo con stack-unsupported: cuántos PRs del stack hay que mergear en orden. El tope es MAX_STACK de model.ts,
  * que importa este módulo: no se importa de vuelta (un test los compara). */
 stackPulls: Type.Optional(Type.Integer({ minimum: 2, maximum: 10 })),
 at: text(100),
}, { additionalProperties: false });
export type ContinuityPauseRecord = Static<typeof ContinuityPauseSchema>;
export interface PauseCause { reason: ContinuityPause; stage?: ContinuityPauseRecord["stage"] | undefined; detail?: string | undefined }

function currentSubject(state: WorkflowV2): string | undefined {
 if (state.lifecycle.status === "enabled") return state.lifecycle.currentSubject ?? undefined;
 return state.publication.status === "opened" ? state.publication.head : undefined;
}
const lastOperation = (state: WorkflowV2): string | undefined => state.lifecycle.status === "enabled" ? state.lifecycle.operations.at(-1)?.id : undefined;

export function continuityPauseRecord(state: WorkflowV2, cause: PauseCause, at: string): ContinuityPauseRecord {
 const subjectId = currentSubject(state), lastOperationId = lastOperation(state), detail = cause.detail?.trim().slice(0, 1000);
 const stackPulls = cause.reason === "stack-unsupported" && state.publication.status === "opened" ? state.publication.stack?.length : undefined;
 return { reason: cause.reason, ...(cause.stage ? { stage: cause.stage } : {}), ...(subjectId ? { subjectId } : {}),
  ...(lastOperationId ? { lastOperationId } : {}), ...(detail ? { detail } : {}), ...(stackPulls ? { stackPulls } : {}), at };
}
/** Una pausa del trabajo deja de aplicar cuando el trabajo ya no está en esa condición (por ejemplo, al retomarlo). */
function stillApplies(pause: ContinuityPauseRecord, state: WorkflowV2): boolean {
 if (pause.reason === "workflow-paused") return state.status === "paused";
 if (pause.reason === "workflow-waiting") return state.status === "waiting";
 if (pause.reason === "workflow-blocked") return state.blockedReason !== "";
 return true;
}
/** La pausa guardada, sólo si sigue describiendo el estado: mismo sujeto y ninguna operación posterior. */
export function currentContinuityPause(state: Workflow): ContinuityPauseRecord | undefined {
 if (state.version !== 2 || !state.continuityPause) return undefined;
 const pause = state.continuityPause;
 if (pause.subjectId !== currentSubject(state) || pause.lastOperationId !== lastOperation(state)) return undefined;
 return stillApplies(pause, state) ? pause : undefined;
}
