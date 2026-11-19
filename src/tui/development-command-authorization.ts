// Decisión humana de un comando desconocido. El catálogo persistente sigue siendo Foundations, no los grants.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { grantKey } from "../harness/authorization.ts";
import { visibleText } from "../harness/foundations.ts";
import type { Workflow } from "../harness/model.ts";
import type { DevelopmentSession } from "./development-session.ts";

const CHOICES = ["Sí", "No", "Permitir siempre en este proyecto"];
const SAVE_TIMEOUT_MS = 30_000;
/** Devuelve el estado autorizado; un no, cancelación o fallo nunca se transforma en un permiso temporal. */
export async function authorizeProjectCommand(session: DevelopmentSession, ctx: ExtensionContext, request: { state: Workflow; command: string; kind: string; signal: AbortSignal }): Promise<Workflow> {
	const { state, command, kind, signal } = request;
	signal.throwIfAborted();
	const pin = await session.foundations.pin(ctx);
	const key = pin.reading.kind === "none" ? undefined : pin.reading.key;
	const where = key ? visibleText(`Foundations · repo ${key.repo} · KB ${key.kbUrl} · producto ${key.product} · perillas`) : visibleText(`Foundations no disponible: ${pin.notice}`);
	const title = [
		"Autorizar comando del proyecto", visibleText(`${kind} · ${state.checkout.root}`), "", visibleText(command), "",
		"Ejecuta código del proyecto con permisos de tu usuario. No es una operación de sólo lectura ni un sandbox.",
		"Sí: el permiso queda guardado para este trabajo, también al retomarlo, hasta que cambie el pedido. No cambia la KB.",
		"No o cancelar: no ejecuta ni guarda permisos.",
		`Permitir siempre en este proyecto: guarda sólo este comando exacto de inmediato en ${where}.`,
		"Vale para futuros trabajos y sesiones del mismo repo, no para otros repos. Si no se puede guardar y aceptar, no se ejecuta.",
		"Nunca habilita merge, tags, workflows, deploys ni secretos; no sustituye las confirmaciones obligatorias de OMI.",
	].join("\n");
	const choice = await session.select(ctx, title, CHOICES, signal);
	signal.throwIfAborted();
	if (choice !== CHOICES[0] && choice !== CHOICES[2]) throw new Error("Comando no autorizado; no se ejecutó");
	await session.assertUnchanged(state, ctx);
	signal.throwIfAborted();
	if (choice === CHOICES[0]) return session.apply({ type: "command_granted", key: grantKey(state, command), command }, ctx);
	const saving = AbortSignal.any([signal, session.lifecycle.signal, AbortSignal.timeout(SAVE_TIMEOUT_MS)]);
	const next = await session.foundations.saveCommand(ctx, state, command, saving, () => session.assertUnchanged(state, ctx));
	// Aunque ya se haya escrito en la KB, una ventana vieja o cancelada no ejecuta ni anuncia éxito.
	try {
		await session.assertUnchanged(state, ctx);
		saving.throwIfAborted();
	} catch (error) {
		const why = error instanceof Error ? error.message : "ejecución cancelada";
		throw new Error(`El permiso quedó guardado en la KB y aceptado localmente para futuras sesiones, pero no se ejecutó el comando. ${why}`, { cause: error });
	}
	session.foundations.replace(ctx, next); session.emit();
	ctx.ui.notify(`Comando guardado en Foundations de ${next.block?.repo} (KB, perillas ${next.docId?.slice(0, 8)}) y aceptado para esta sesión.`, "info");
	return state;
}
