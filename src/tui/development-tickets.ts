// Pedidos de arranque de un solo uso. Ni la tool del agente ni el panel conceden permisos: dejan
// un pedido que sólo consume el comando interno, donde la persona confirma. Viven en memoria del
// proceso: recargar o reabrir una sesión nunca vuelve a arrancar nada. Sin imports de Pi en tiempo
// de carga: el workspace lo importa antes de que launchTui fije PI_CODING_AGENT_DIR.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface BeginRequest { issue?: number; title?: string; body?: string; reason?: string }
export type DevelopmentTicket =
	| { kind: "request"; sessionFile: string; request: BeginRequest }
	| { kind: "start"; sessionFile: string; issue: number };
export const BEGIN_SUBCOMMAND = "begin";
const MAX_TICKETS = 20;
const tickets = new Map<string, DevelopmentTicket>();

export function issueDevelopmentTicket(ticket: DevelopmentTicket): string {
	const token = randomUUID();
	tickets.set(token, ticket);
	while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
	return token;
}
/** Se consume aunque no corresponda a la sesión: un token no se puede probar dos veces. */
export function takeDevelopmentTicket(token: string, sessionFile: string | undefined): DevelopmentTicket | undefined {
	const ticket = tickets.get(token);
	tickets.delete(token);
	return ticket && sessionFile && resolve(ticket.sessionFile) === resolve(sessionFile) ? ticket : undefined;
}
export const beginCommand = (token: string): string => `/omi-work ${BEGIN_SUBCOMMAND} ${token}`;
/** Entrada del panel de Issues y de la paleta: el mismo flujo y la misma confirmación que la tool. */
export function requestDevelopmentBegin(pi: Pick<ExtensionAPI, "sendUserMessage">, sessionFile: string, request: BeginRequest): void {
	pi.sendUserMessage(beginCommand(issueDevelopmentTicket({ kind: "request", sessionFile, request })), { expandPromptTemplates: true });
}
