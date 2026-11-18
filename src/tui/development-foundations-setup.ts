// Sin Foundations para el repo, el harness ofrece armarlo: detecta comandos, los pregunta en tandas y los
// guarda en la KB sólo con el sí. Es la única escritura en la KB y conserva el resto del documento de perillas.
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composePerillas, foundationsHash, type FoundationsBlock } from "../harness/foundations.ts";
import { detectFoundationsCandidates } from "../harness/foundations-detect.ts";
import { foundationsDir, readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { FoundationsPin } from "./development-foundations.ts";
import { composeFoundations, confirmFoundationsSave, type Ask } from "./development-foundations-wizard.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { KbClient, KbDoc } from "./kb-client.ts";
import { askQuestions } from "./questions/ask.ts";

export const FOUNDATIONS_OFFER = ["Armar Foundations", "Ahora no", "No ofrecer más para este repo"] as const;
const SAVE_TIMEOUT_MS = 30_000;
// Una vez por sesión, en memoria del proceso como el pin: /reload no vuelve a ofrecer.
const offered = new Set<string>();

/** Sólo si la KB respondió, el producto existe, no hay bloque, nada aceptado, la persona no lo descartó y hay TUI interactiva. */
export function shouldOfferFoundations(pin: FoundationsPin | undefined, record: TrustRecord | undefined, hasUI: boolean): boolean {
	return hasUI && pin?.reading.kind === "missing" && pin.origin === "strict" && !record?.accepted && !record?.offerDeclined;
}

export interface PreparedSave { previous: KbDoc | null; body: string; clave: string }
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** Lee las perillas vigentes y compone el cuerpo nuevo. Falla si hay un bloque inválido: hay que corregirlo en la KB. */
export async function prepareFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, signal: AbortSignal): Promise<PreparedSave> {
	const previous = await kb.currentPerillas(key.product, signal);
	const body = composePerillas(previous?.cuerpo, key.product, key.repo, block);
	return { previous, body, clave: `omi-foundations|${key.repo.slice(0, 80)}|${previous?.id ?? "none"}|${sha256(body).slice(0, 40)}` };
}

/** Guarda sin pisar a otro: se relee el vigente y se verifica lo guardado. La clave determinista recupera una respuesta perdida. */
export async function commitFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, prepared: PreparedSave, deps: { trustDir: string; now: () => string; signal: AbortSignal }): Promise<FoundationsPin> {
	const current = await kb.currentPerillas(key.product, deps.signal);
	if ((current?.id ?? null) !== (prepared.previous?.id ?? null)) throw new Error("Las perillas cambiaron en la KB mientras armabas Foundations; no se guardó nada. Volvé a intentarlo en otra sesión.");
	const input = { product: key.product, titulo: prepared.previous?.titulo || `Perillas de ${key.product}`, cuerpo: prepared.body, clave: prepared.clave };
	// Una respuesta perdida puede haber guardado: la misma clave recupera el original en lugar de duplicarlo.
	const saved = await kb.save(input, deps.signal).catch(() => kb.save(input, deps.signal));
	const stored = await kb.read(saved.id, deps.signal);
	if (stored.cuerpo !== prepared.body || stored.producto !== key.product) throw new Error("La KB guardó otro contenido; revisá las perillas antes de seguir.");
	const latest = await kb.currentPerillas(key.product, deps.signal);
	const hash = foundationsHash(block);
	const record: TrustRecord = await readTrust(deps.trustDir, key) ?? { version: 1, ...key, accepted: null, offerDeclined: false };
	await writeTrust(deps.trustDir, { ...record, accepted: { docId: stored.id, blockHash: hash, block, author: stored.autor ?? "", date: stored.fecha ?? "", acceptedAt: deps.now() } });
	return {
		origin: "kb", block, hash, docId: stored.id, author: stored.autor ?? "", date: stored.fecha ?? "",
		notice: latest?.id === stored.id ? "" : "La KB guardó Foundations, pero ya hay perillas más nuevas: la próxima sesión muestra la diferencia.",
		reading: { kind: "valid", key, block, hash, perillas: stored },
	};
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

/** En la sesión del worktree, al empezar el harness. Un no o un error nunca guardan nada en la KB. */
export async function offerFoundations(ctx: ExtensionContext, session: DevelopmentSession, kb: KbClient | undefined): Promise<void> {
	const file = ctx.sessionManager.getSessionFile();
	if (!kb || !file || offered.has(file) || !session.state) return;
	const pin = await session.foundations.pin(ctx);
	if (pin.reading.kind !== "missing") return;
	const key = pin.reading.key; const trustDir = foundationsDir(session.io.homeDir);
	// Las tandas son un componente de la TUI: en RPC no hay dónde mostrarlas.
	if (!shouldOfferFoundations(pin, await readTrust(trustDir, key), ctx.hasUI && ctx.mode === "tui")) return;
	offered.add(file);
	const choice = await ctx.ui.select(`Foundations para ${key.repo}: comandos que corren sin preguntar y qué puntos piden un sí, en las perillas de ${key.product}`, [...FOUNDATIONS_OFFER]);
	if (choice === FOUNDATIONS_OFFER[2]) {
		const record = await readTrust(trustDir, key) ?? { version: 1 as const, ...key, accepted: null, offerDeclined: false };
		await writeTrust(trustDir, { ...record, offerDeclined: true }); return;
	}
	if (choice !== FOUNDATIONS_OFFER[0]) return;
	const detected = await detectFoundationsCandidates(session.state.checkout.root);
	const ask = asker(ctx, session);
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
	} catch (error) { ctx.ui.notify(`Foundations no se guardó: ${error instanceof Error ? error.message : "error"}`, "warning"); }
}
