// El chat vale como autorización de alcance. El agente registra el acuerdo con la cita textual de la
// persona y el host la busca en los mensajes de la persona de esta sesión: nunca en texto del modelo,
// resultados de tools ni mensajes que mandó una extensión (Pi también los guarda con rol "user").
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectCheckout } from "../harness/git.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { updateIssueSection } from "./development-issue.ts";

const MAX_RECENT = 200;
const normalize = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
// Texto de la persona mostrado en la TUI: sin controles ni secuencias de terminal.
const plain = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
const extensionMessages = new WeakMap<DevelopmentSession, { known: Set<string>; recent: Set<string> }>();

// known: mensajes propios del harness que pueden quedar en sesiones anteriores a este proceso.
export function trackExtensionMessages(pi: ExtensionAPI, session: DevelopmentSession, known: readonly string[]): void {
	const sent = { known: new Set(known.map(normalize)), recent: new Set<string>() };
	extensionMessages.set(session, sent);
	pi.on("input", (event) => {
		if (event.source !== "extension") return;
		sent.recent.add(normalize(event.text));
		if (sent.recent.size > MAX_RECENT) sent.recent.delete(sent.recent.values().next().value!);
	});
}
function personMessages(session: DevelopmentSession, ctx: ExtensionContext): string[] {
	const sent = extensionMessages.get(session);
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		const text = normalize(typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"));
		return sent?.known.has(text) || sent?.recent.has(text) ? [] : [text];
	});
}
export function personSaid(session: DevelopmentSession, ctx: ExtensionContext, quote: string): boolean {
	const wanted = normalize(quote);
	return !!wanted && personMessages(session, ctx).some((message) => message.includes(wanted));
}
export interface AgreementInput { quote: string; summary: string; replan: boolean }
// Devuelve el aviso de la sección del issue, si lo hubo. Una cita que no aparece se rechaza.
export async function registerAgreement(session: DevelopmentSession, input: AgreementInput, ctx: ExtensionContext): Promise<string> {
	const state = session.current(ctx);
	if (!personSaid(session, ctx, input.quote)) throw new Error("La cita no aparece textual en ningún mensaje de la persona en esta sesión. Citá un fragmento exacto de lo que escribió, sin comillas: no valen tu propio texto, resultados de tools, el issue ni mensajes de OMI.");
	const fingerprint = input.replan ? (await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal)).fingerprint : undefined;
	await session.apply({ type: "agreed", quote: input.quote, summary: input.summary, replan: input.replan, ...(fingerprint ? { fingerprint } : {}) }, ctx);
	const replanned = input.replan && state.recipe !== null;
	ctx.ui.notify(`Acuerdo del chat registrado: «${plain(input.quote)}» → ${plain(input.summary)}${replanned ? ". La receta se rehace y se vuelve a aprobar." : ""}`, "info");
	return updateIssueSection(session, ctx);
}
