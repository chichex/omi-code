// Preferencias de continuidad del wizard: configurar no concede autoridad ni ejecuta etapas.
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "../tui/questions/batch.ts";
import type { LifecycleConfig } from "./lifecycle-config.ts";

const KEEP = "Mantener continuidad actual", CONFIGURE = "Configurar continuidad", DISABLE = "Detener en draft (legacy)";
const MODES = { "Preguntar antes (ask)": "ask", "Automático (auto)": "auto", "Manual (comando explícito)": "manual" } as const;
const STAGES = ["entry", "review", "fix", "land", "ship"] as const;
const NAMES = { entry: "Entrada tras draft", review: "Review", fix: "Fix", land: "Land", ship: "Ship" };
export const CONTINUITY_NOTICE = "Continuidad no autoriza efectos: push conserva autoridad Foundations independiente; merge y dispatch siguen siendo humanos en omi-code. Guardar no inicia acciones; deshabilitar sólo afecta acciones futuras, no revierte efectos remotos.";
const choice = (answers: QuestionAnswer[], id: string) => answers.find(a => a.id === id)?.options[0];
function question(id: string, header: string, prompt: string, options: [string, string][]): Question {
 return { id, header, question: prompt, options: options.map(([label, description]) => ({ label, description })), multiSelect: false, recommended: true, freeText: false };
}
function stageQuestion(stage: typeof STAGES[number]): Question {
 return question(stage, stage === "entry" ? "Entrada" : NAMES[stage], `¿Cómo continuar con ${NAMES[stage]}?`, [
  ["Preguntar antes (ask)", "Pide confirmación de continuidad; los efectos conservan sus permisos"],
  ["Automático (auto)", "Continúa sólo con guardrails, alcance y presupuesto válidos"],
  ["Manual (comando explícito)", "Pausa y espera un comando de la persona"],
 ]);
}
function mode(answers: QuestionAnswer[], stage: typeof STAGES[number]): "ask" | "auto" | "manual" {
 const label = choice(answers, stage);
 if (label === undefined || !Object.hasOwn(MODES, label)) throw new Error("Modo de continuidad inválido; no se guardó nada");
 return MODES[label as keyof typeof MODES];
}
/** Omitir el opt-in conserva literalmente los campos previos, incluso ausencia legacy y hash. */
export async function configureLifecycleContinuity(block: LifecycleConfig, ask: (batch: QuestionBatch) => Promise<AskResult>): Promise<LifecycleConfig | null> {
 const options: [string, string][] = [[KEEP, block.continuity ? "Conserva las cinco palancas actuales" : "Legacy: se detiene en PR draft, sin encadenar"], [CONFIGURE, "Elegir auto/ask/manual para entrada, Review, Fix, Land y Ship"]];
 if (block.continuity) options.push([DISABLE, "Quita continuidad futura; no revierte efectos remotos"]);
 const first = await ask({ title: "Continuidad del lifecycle", questions: [{ ...question("continuity", "Continuar", "¿Configurar el avance entre etapas?", options), detail: CONTINUITY_NOTICE }] });
 if (first.status === "cancelled") return null;
 const selected = choice(first.answers, "continuity");
 if (selected === KEEP) return block;
 if (selected === DISABLE && block.continuity) { const next = structuredClone(block); delete next.continuity; return next; }
 if (selected !== CONFIGURE) throw new Error("Respuesta de continuidad inválida; no se guardó nada");
 const stages = await ask({ title: "Entrada, Review, Fix y Land", questions: STAGES.slice(0, 4).map(stageQuestion) });
 if (stages.status === "cancelled") return null;
 const ship = await ask({ title: "Continuidad de Ship", questions: [stageQuestion("ship")] });
 if (ship.status === "cancelled") return null;
 const answers = [...stages.answers, ...ship.answers];
 return { ...block, continuity: { entry: mode(answers, "entry"), review: mode(answers, "review"), fix: mode(answers, "fix"), land: mode(answers, "land"), ship: mode(answers, "ship") } };
}
