// El sí de continuidad (ask) de una etapa encadenada: una sola vez por etapa. Se pregunta aparte o viaja en el
// diálogo del primer efecto que ya pide un sí humano. Nunca reemplaza, saltea ni concede el sí de un efecto.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContinuityAction } from "../harness/lifecycle-continuity.ts";
import type { EffectGate } from "../harness/lifecycle-continuity-gates.ts";
import { LifecycleDeclined } from "./development-lifecycle.ts";
import type { DevelopmentSession } from "./development-session.ts";

const NAMES = { adopt: "la adopción del PR", review: "Review", fix: "la corrección", push: "el push de la corrección", land: "Land", ship: "Ship" } satisfies Record<ContinuityAction, string>;
/** Qué hace la etapa, con el PR: el título del diálogo aparte. */
function continuityStep(action: ContinuityAction, pr: number | undefined): string {
 const number = pr === undefined ? "" : ` #${pr}`;
 switch (action) {
  case "adopt": return `Adoptar el PR${number}`;
  case "review": return `Review del PR${number}`;
  case "fix": return `Corregir los hallazgos del PR${number}`;
  case "push": return `Publicar la corrección (push) en el PR${number}`;
  case "land": return `Land del PR${number}`;
  case "ship": return `Ship del PR${number}`;
  default: { const unhandled: never = action; throw new Error(`Acción de continuidad desconocida: ${String(unhandled)}`); }
 }
}
const TAIL = "La continuidad no concede permisos. Si decís que no, la cadena queda en pausa y no se ejecuta nada.";
function apart(action: ContinuityAction, gate: Exclude<EffectGate, "human">): string {
 const name = NAMES[action];
 const body = gate === "auto"
  ? `Al aceptar, la cadena sigue con ${name}. Su primer paso corre sin otro sí: su permiso está en auto o no hay efecto que autorizar. Los efectos que piden permiso lo siguen pidiendo.`
  : `Al aceptar, la cadena sigue con ${name}. Si un efecto necesita un sí, lo pide aparte.`;
 return `${body}\n\n${TAIL}`;
}
/** La línea que suma el diálogo de un efecto cuando su sí también continúa la cadena. */
function fused(action: ContinuityAction): string {
 const next = action === "adopt" ? "se adopta el PR y la cadena sigue con Review según continuity.review" : `la cadena sigue con ${NAMES[action]}`;
 return `Continuidad en ask: al aceptar, ${next}. Este sí no autoriza otros efectos: cada uno pide el suyo.`;
}

export class ChainConsent {
 readonly action: ContinuityAction;
 readonly step: string;
 private readonly session: DevelopmentSession;
 private readonly ctx: ExtensionContext;
 private resolved = false;
 constructor(session: DevelopmentSession, ctx: ExtensionContext, action: ContinuityAction, pr: number | undefined) {
  this.session = session; this.ctx = ctx; this.action = action; this.step = continuityStep(action, pr);
 }
 get pending(): boolean { return !this.resolved; }
 /** El diálogo aparte, antes de la etapa o antes de un efecto que resultó no preguntar. */
 async ask(gate: Exclude<EffectGate, "human">): Promise<boolean> {
  const approved = await this.session.confirm(this.ctx, `Continuidad · ${this.step}`, apart(this.action, gate));
  if (approved) this.resolved = true;
  return approved;
 }
 /** Antes de un efecto o un avance sin sí propio: si la continuidad sigue pendiente, la pregunta. Un no corta sin efectos. */
 async ensure(): Promise<void> {
  if (this.resolved) return;
  if (!(await this.ask("auto"))) throw new LifecycleDeclined(`Continuidad · ${this.step}: no. No se ejecutó nada.`);
 }
 /** El diálogo de un efecto humano. Mientras la continuidad siga pendiente, dice que el mismo sí la resuelve. */
 async confirmEffect(title: string, description: string): Promise<boolean> {
  const approved = await this.session.confirm(this.ctx, title, this.resolved ? description : `${description}\n\n${fused(this.action)}`);
  if (approved) this.resolved = true;
  return approved;
 }
}
