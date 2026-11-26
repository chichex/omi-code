// /omi-work extra-round: con 0 retry, una persona suma una vuelta en la TUI, con motivo. Ninguna tool lo expone.
// Conserva receta, aprobación, pasos y evidencia: es la salida para un problema real en la última vuelta.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_ROUNDS } from "../harness/model.ts";
import type { DevelopmentSession } from "./development-session.ts";

const TITLE = "Sumar una vuelta";
const MAX_REASON = 2000;

/** true sólo si la persona sumó la vuelta: un No, un motivo vacío o un trabajo pausado no relanzan al agente. */
export async function extraRound(session: DevelopmentSession, ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`${TITLE}: requiere la TUI interactiva de OMI; lo decide una persona, no el agente ni un cliente RPC.`);
	// Adopta el estado vigente aunque el vínculo de esta sesión esté atrasado, como resume, pero no reanuda nada.
	await session.restore(ctx, true);
	const state = session.current(ctx);
	if (state.version === 2 && state.pullRequest?.ownership === "adopted") throw new Error(`${TITLE}: el PR es del lifecycle y corrige por su cuenta; no suma vueltas.`);
	if (!["implement", "verify", "pr"].includes(state.phase)) throw new Error(`${TITLE}: sólo en Implementar, Verificar o PR draft; el trabajo está en ${state.phase}.`);
	if (state.round < state.maxRounds) throw new Error(`${TITLE}: todavía quedan ${state.maxRounds - state.round} retry: no hace falta otra vuelta.`);
	if (state.maxRounds >= MAX_ROUNDS) throw new Error(`${TITLE}: el tope es de ${MAX_ROUNDS} vueltas; para seguir, /omi-work refresh.`);
	const next = state.maxRounds + 1;
	if (!(await session.confirm(ctx, TITLE, `Vuelta ${state.round} de ${state.maxRounds} → de ${next}: suma 1 retry. No borra evidencia, pasos ni aprobación; no acepta riesgos ni corrige nada. Tope: ${MAX_ROUNDS} vueltas.`))) return false;
	session.emit(`Esperando motivo · ${TITLE}`, true);
	let reason: string | undefined;
	try { reason = (await ctx.ui.input(`${TITLE} · motivo`, "Por qué vale otra vuelta (por ejemplo: falta cerrar el destino del proveedor)", { signal: session.lifecycle.signal }))?.trim(); }
	finally { session.emit(); }
	if (!reason) return false;
	if (reason.length > MAX_REASON) throw new Error(`El motivo es demasiado largo (más de ${MAX_REASON} caracteres); resumilo y volvé a sumar la vuelta.`);
	await session.assertUnchanged(state, ctx);
	const added = await session.apply({ type: "round_added", reason }, ctx);
	ctx.ui.notify(`Vuelta sumada: vuelta ${added.round} de ${added.maxRounds}, queda ${added.maxRounds - added.round} retry.${added.status === "paused" ? " Seguí con /omi-work resume." : ""}`, "info");
	return true;
}
