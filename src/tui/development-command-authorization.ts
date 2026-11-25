// Un sí explícito concede sólo el comando exacto al trabajo/pedido. «Sí, y no volver a preguntar» guarda el prefijo
// del comando simple para el repo, en esta máquina. Editar reglas nunca continúa la ejecución.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { grantKey } from "../harness/authorization.ts";
import { commandPrefix, prefixLabel } from "../harness/command-allow.ts";
import { visibleText } from "../harness/foundations.ts";
import type { Workflow } from "../harness/model.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { editFoundations } from "./development-foundations-setup.ts";

const YES = "Sí", NO = "No", EDIT = "Editar reglas";
const always = (prefix: string) => `Sí, y no volver a preguntar por «${prefixLabel(prefix)}» en este repo`;
export async function authorizeProjectCommand(session: DevelopmentSession, ctx: ExtensionContext, request: { state: Workflow; command: string; kind: string; signal: AbortSignal }): Promise<Workflow> {
	const { state, command, kind, signal } = request;
	signal.throwIfAborted();
	// Leer metadata del pin existente no inicia otra aceptación al abrir/editar reglas.
	const pin = session.foundations.current(ctx);
	const key = pin && pin.reading.kind !== "none" ? pin.reading.key : undefined;
	const where = key ? visibleText(`repo ${key.repo} · KB ${key.kbUrl} · producto ${key.product} · perillas`) : visibleText(`Foundations no disponible: ${pin?.notice ?? "sin configuración"}`);
	// Sólo un comando simple tiene un prefijo que se pueda permitir: lo compuesto no se separa en partes.
	const prefix = key ? commandPrefix(command) : undefined;
	const title = [
		"Autorizar comando del proyecto", visibleText(`${kind} · ${state.checkout.root}`), "", visibleText(command), "",
		"Ejecuta código del proyecto con permisos de tu usuario. No es sólo lectura ni un sandbox.",
		"Sí: el permiso del comando exacto queda guardado para este trabajo y pedido, también al retomarlo; cambiar el pedido o refresh lo invalida. No cambia la KB ni autoriza variantes.",
		...(prefix ? [visibleText(`Sí, y no volver a preguntar: en esta máquina, los comandos simples que empiezan con «${prefix}» corren sin preguntar en ${key!.repo}, también en otros trabajos y aunque coincidan con una regla. No cubre comandos compuestos. Se ven en la pestaña OMI y se quitan con /omi-permitidos.`)] : []),
		"No o cancelar: no ejecuta ni guarda permisos.",
		`Editar reglas: abre la guía de Foundations (${where}) sin aceptar, escribir ni autorizar nada al abrir. Sólo Guardar explícitamente cambia la configuración.`,
		"Al cerrar la guía, incluso si guardaste, este comando NO se ejecuta: hay que reintentarlo y volver a evaluar la política vigente. Guardar no crea un grant humano.",
		"Nunca habilita merge, tags, workflows, deploys ni secretos; no sustituye las confirmaciones obligatorias de OMI ni las prohibiciones del proyecto.",
	].join("\n");
	const choices = [YES, ...(prefix ? [always(prefix)] : []), NO, EDIT];
	const choice = await session.select(ctx, title, choices, signal);
	signal.throwIfAborted();
	const remember = prefix !== undefined && choice === always(prefix);
	if (choice !== YES && choice !== EDIT && !remember) throw new Error("Comando no autorizado; no se ejecutó");
	await session.assertUnchanged(state, ctx);
	signal.throwIfAborted();
	if (choice === YES) return session.apply({ type: "command_granted", key: grantKey(state, command), command }, ctx);
	if (remember) {
		await session.foundations.allow(ctx, prefix);
		ctx.ui.notify(visibleText(`No vuelve a preguntar por «${prefixLabel(prefix)}» en ${key!.repo}. Se quita con /omi-permitidos.`), "info");
		return state;
	}
	await editFoundations(ctx, session, session.kb, signal);
	throw new Error("Edición de reglas finalizada; no se ejecutó el comando ni se concedió permiso. Reintentá el comando para evaluar la política vigente.");
}
