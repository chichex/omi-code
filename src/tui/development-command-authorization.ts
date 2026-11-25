// Un sí explícito concede sólo el comando exacto al trabajo/pedido. Editar reglas nunca continúa la ejecución.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { grantKey } from "../harness/authorization.ts";
import { visibleText } from "../harness/foundations.ts";
import type { Workflow } from "../harness/model.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { editFoundations } from "./development-foundations-setup.ts";

const CHOICES = ["Sí", "No", "Editar reglas"];
export async function authorizeProjectCommand(session: DevelopmentSession, ctx: ExtensionContext, request: { state: Workflow; command: string; kind: string; signal: AbortSignal }): Promise<Workflow> {
	const { state, command, kind, signal } = request;
	signal.throwIfAborted();
	// Leer metadata del pin existente no inicia otra aceptación al abrir/editar reglas.
	const pin = session.foundations.current(ctx);
	const key = pin && pin.reading.kind !== "none" ? pin.reading.key : undefined;
	const where = key ? visibleText(`repo ${key.repo} · KB ${key.kbUrl} · producto ${key.product} · perillas`) : visibleText(`Foundations no disponible: ${pin?.notice ?? "sin configuración"}`);
	const title = [
		"Autorizar comando del proyecto", visibleText(`${kind} · ${state.checkout.root}`), "", visibleText(command), "",
		"Ejecuta código del proyecto con permisos de tu usuario. No es sólo lectura ni un sandbox.",
		"Sí: el permiso del comando exacto queda guardado para este trabajo y pedido, también al retomarlo; cambiar el pedido o refresh lo invalida. No cambia la KB ni autoriza variantes.",
		"No o cancelar: no ejecuta ni guarda permisos.",
		`Editar reglas: abre la guía de Foundations (${where}) sin aceptar, escribir ni autorizar nada al abrir. Sólo Guardar explícitamente cambia la configuración.`,
		"Al cerrar la guía, incluso si guardaste, este comando NO se ejecuta: hay que reintentarlo y volver a evaluar la política vigente. Guardar no crea un grant humano.",
		"Nunca habilita merge, tags, workflows, deploys ni secretos; no sustituye las confirmaciones obligatorias de OMI ni las prohibiciones del proyecto.",
	].join("\n");
	const choice = await session.select(ctx, title, CHOICES, signal);
	signal.throwIfAborted();
	if (choice !== CHOICES[0] && choice !== CHOICES[2]) throw new Error("Comando no autorizado; no se ejecutó");
	await session.assertUnchanged(state, ctx);
	signal.throwIfAborted();
	if (choice === CHOICES[0]) return session.apply({ type: "command_granted", key: grantKey(state, command), command }, ctx);
	await editFoundations(ctx, session, session.kb, signal);
	throw new Error("Edición de reglas finalizada; no se ejecutó el comando ni se concedió permiso. Reintentá el comando para evaluar la política vigente.");
}
