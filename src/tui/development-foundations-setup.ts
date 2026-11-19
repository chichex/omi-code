// Armar Foundations para un repo que no lo tiene: detecta comandos, los pregunta en tandas y los guarda en la KB
// sólo con el sí. El harness ya no lo ofrece solo al arrancar: sin Foundations nada pregunta. Comparte la
// persistencia con el permiso permanente de comandos.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FoundationsBlock } from "../harness/foundations.ts";
import { detectFoundationsCandidates } from "../harness/foundations-detect.ts";
import { foundationsDir, readTrust, writeTrust, type TrustRecord } from "../harness/foundations-trust.ts";
import type { FoundationsPin } from "./development-foundations.ts";
import { chooseFoundationsOffer, composeFoundations, confirmFoundationsSave, type Ask } from "./development-foundations-wizard.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { KbClient } from "./kb-client.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "./development-foundations-save.ts";
import { askQuestions } from "./questions/ask.ts";

export { FOUNDATIONS_OFFER } from "./development-foundations-wizard.ts";
const SAVE_TIMEOUT_MS = 30_000;
// Una vez por sesión, en memoria del proceso como el pin: /reload no vuelve a ofrecer.
const offered = new Set<string>();

/** Sólo si la KB respondió, el producto existe, no hay bloque, nada aceptado, la persona no lo descartó y hay TUI interactiva. */
export function shouldOfferFoundations(pin: FoundationsPin | undefined, record: TrustRecord | undefined, hasUI: boolean): boolean {
	return hasUI && pin?.reading.kind === "missing" && pin.origin === "default" && !record?.accepted && !record?.offerDeclined;
}

/** Cada tanda del creador, con el progreso en espera como cualquier otra decisión del harness. */
function asker(ctx: ExtensionContext, session: DevelopmentSession): Ask {
	return async (batch) => {
		session.checkContext(ctx);
		session.emit(`Esperando respuesta · ${batch.title}`, true);
		try { return await askQuestions(ctx, batch, { signal: session.lifecycle.signal }); }
		finally { session.emit(); }
	};
}
const saveSignal = (session: DevelopmentSession) => AbortSignal.any([session.lifecycle.signal, AbortSignal.timeout(SAVE_TIMEOUT_MS)]);

/** En la sesión del worktree, con un trabajo activo. Un no o un error nunca guardan nada en la KB. */
export async function offerFoundations(ctx: ExtensionContext, session: DevelopmentSession, kb: KbClient | undefined): Promise<void> {
	const file = ctx.sessionManager.getSessionFile();
	if (!kb || !file || offered.has(file) || !session.state) return;
	const pin = await session.foundations.pin(ctx);
	if (pin.reading.kind !== "missing") return;
	const key = pin.reading.key; const trustDir = foundationsDir(session.io.homeDir);
	// Las tandas son un componente de la TUI: en RPC no hay dónde mostrarlas.
	if (!shouldOfferFoundations(pin, await readTrust(trustDir, key), ctx.hasUI && ctx.mode === "tui")) return;
	offered.add(file);
	const ask = asker(ctx, session);
	const choice = await chooseFoundationsOffer(ask, key);
	if (choice === "never") {
		const record = await readTrust(trustDir, key) ?? { version: 1 as const, ...key, accepted: null, offerDeclined: false };
		await writeTrust(trustDir, { ...record, offerDeclined: true }); return;
	}
	if (choice !== "build") return;
	const detected = await detectFoundationsCandidates(session.state.checkout.root);
	try {
		// «Cambiar respuestas» vuelve a las preguntas con lo elegido; cancelar en cualquier tanda no guarda nada.
		for (let previous: FoundationsBlock | undefined; ;) {
			const block = await composeFoundations(ask, { repo: key.repo, detected, ...(previous ? { previous } : {}) });
			if (!block) return;
			// Cada tramo con la KB tiene su propio tope: lo que tarde la persona en el resumen no lo consume.
			const prepared = await prepareFoundationsSave(kb, key, block, saveSignal(session));
			const where = `Se guarda en la KB, producto ${key.product}, como una revisión nueva de las perillas${prepared.previous ? "" : " (documento nuevo)"}. Se conserva el resto del documento. Con el sí, también queda aceptada para este repo.`;
			const decision = await confirmFoundationsSave(ask, block, { product: key.product, kbUrl: key.kbUrl, where });
			if (decision === "change") { previous = block; continue; }
			if (decision === "cancel") return;
			const next = await commitFoundationsSave(kb, key, block, prepared, { trustDir, now: session.now, signal: saveSignal(session) });
			session.foundations.replace(ctx, next); session.emit();
			ctx.ui.notify(`Foundations guardado en la KB (perillas ${next.docId?.slice(0, 8)}) y aceptado para esta sesión.${next.notice ? ` ${next.notice}` : ""}`, "info");
			return;
		}
	} catch (error) { ctx.ui.notify(`No se pudo completar Foundations: ${error instanceof Error ? error.message : "error"}`, "warning"); }
}
