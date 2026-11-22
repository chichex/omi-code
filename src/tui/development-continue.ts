// Retoma el turno cuando el modelo corta con el trabajo abierto. Sin esto el harness quedaba quieto
// hasta que la persona escribiera: el #69 cortó en C12 diciendo «todavía no está terminado» y nada lo
// relanzó. Sólo en etapas que avanza el modelo, sin pausa ni espera, y con tope: dos vueltas sin que
// el estado durable avance y frena con un aviso.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PHASE_LABELS, type Phase } from "../harness/phases.ts";
import type { DevelopmentSession } from "./development-session.ts";

export const CONTINUE_MESSAGE = "omi-development-continue";
export const MAX_IDLE_CONTINUATIONS = 2;
// approve, review, land y ship esperan un sí o un comando de la persona; done, delivered y closed terminaron.
const MODEL_PHASES: ReadonlySet<Phase> = new Set(["explore", "decide", "recipe", "diagnose", "spec", "implement", "verify", "pr"]);

function message(issue: number, phase: Phase): string {
	return `El trabajo #${issue} sigue en «${PHASE_LABELS[phase]}» y nadie lo pausó: seguí con el próximo paso sin esperar a la persona. `
		+ "Si necesitás una decisión suya, preguntá con la tool de preguntas. Si estás bloqueado, pausá con omi_workflow action:pause y el motivo. "
		+ "No repitas lo que ya está hecho.";
}

export function continueDevelopment(pi: ExtensionAPI, session: DevelopmentSession): void {
	// Subagentes en background: su aviso relanza el turno, no hace falta empujar al modelo.
	const background = new Set<string>();
	let streak = 0; let revision: number | undefined; let warned = false;
	const reset = () => { streak = 0; warned = false; };
	const unsubscribe = pi.events.on?.("omi:subagents", (value: unknown) => {
		if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id.startsWith("bg-")) return;
		if ("phase" in value && value.phase === "start") background.add(value.id);
		else if ("phase" in value && value.phase === "end") background.delete(value.id);
	});
	pi.on("session_start", () => { background.clear(); reset(); revision = undefined; });
	pi.on("session_shutdown", () => { unsubscribe?.(); });
	pi.on("agent_start", () => { session.turnYielded = false; });
	pi.on("input", (event) => { if (event.source !== "extension") reset(); });
	pi.on("agent_before_settle", (event, ctx) => {
		// Pi ya sigue (otra extensión o mensajes en cola) o la corrida terminó por Esc o error: no cuenta.
		if (event.outcome !== "completed" || event.continue || event.context.pendingMessages.length) return;
		const state = session.state;
		if (!state || session.lockedReason || session.turnYielded || state.status !== "active" || !MODEL_PHASES.has(state.phase) || background.size) return;
		if (state.revision !== revision) { revision = state.revision; reset(); }
		if (streak >= MAX_IDLE_CONTINUATIONS) {
			if (!warned) ctx.ui.notify(`El modelo cortó dos veces sin avanzar el trabajo #${state.source.number}. Seguí vos con un mensaje, o /omi-work pause.`, "warning");
			warned = true; return;
		}
		streak++;
		return { entries: [...event.entries, { type: "custom_message" as const, customType: CONTINUE_MESSAGE, content: message(state.source.number, state.phase), display: true }], continue: true };
	});
}
