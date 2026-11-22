// Configurar Foundations es una acción humana: abrir no acepta, guarda ni concede un grant.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, visibleText, type FoundationsBlock } from "../harness/foundations.ts";
import { foundationsDir, readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { FoundationsPin, FoundationsReading } from "./development-foundations.ts";
import type { KbClient } from "./kb-client.ts";
import { chooseFoundationsOffer } from "./development-foundations-offer.ts";
import { showFoundationsPanel } from "./development-foundations-panel.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "./development-foundations-save.ts";
import { askQuestions } from "./questions/ask.ts";
export { FOUNDATIONS_OFFER } from "./development-foundations-offer.ts";

const SAVE_TIMEOUT_MS = 30_000;
const offered = new Set<string>();
const sameKey = (left: TrustKey, right: TrustKey) => left.kbUrl === right.kbUrl && left.product === right.product && left.repo === right.repo;
const issueRepo = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(url)?.[1]?.toLowerCase();
function editable(reading: FoundationsReading): asserts reading is Exclude<FoundationsReading, { kind: "none" | "unavailable" }> {
	if (reading.kind === "none" || reading.kind === "unavailable") throw new Error(`No se puede configurar Foundations en la KB: ${reading.reason}. No se guardó ni aceptó nada.`);
}
/** Sin arranque ni reanudación del harness; sirve también antes de crear un trabajo. */
export async function editFoundations(ctx: ExtensionContext, session: DevelopmentSession, kb: KbClient | undefined = session.kb, requested?: AbortSignal): Promise<boolean> {
	session.checkContext(ctx);
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Editar reglas de Foundations requiere la TUI interactiva de OMI.");
	if (!kb) throw new Error("No se puede guardar Foundations: KB no disponible. No se aceptó ninguna configuración sin guardar.");
	const signal = AbortSignal.any([session.lifecycle.signal, ...(requested ? [requested] : [])]);
	const ioSignal = () => AbortSignal.any([signal, AbortSignal.timeout(SAVE_TIMEOUT_MS)]);
	const state = session.state; const file = ctx.sessionManager.getSessionFile();
	const assertCurrent = async () => {
		signal.throwIfAborted(); session.checkContext(ctx);
		if (ctx.sessionManager.getSessionFile() !== file) throw new Error("Cambió la sesión durante la edición de Foundations.");
		if (state) await session.assertUnchanged(state, ctx);
	};
	await assertCurrent();
	const reading = await session.foundations.read(ctx, ioSignal()); editable(reading);
	if (state && issueRepo(state.source.url) !== reading.key.repo) throw new Error("El repo de origin no coincide con el issue; no se cambió Foundations.");
	const key = reading.key; const trustDir = foundationsDir(session.io.homeDir);
	const record = await readTrust(trustDir, key);
	const notice = reading.kind === "invalid" ? `Configuración inválida u obsoleta: ${reading.reason}. Borrador nuevo, sin heredar permisos.` : "Abrir no acepta ni escribe. Sólo Guardar explícitamente aplica esta revisión.";
	session.emit("Editando Foundations", true);
	let block: FoundationsBlock | undefined;
	try {
		block = await showFoundationsPanel(ctx, { repo: key.repo, product: key.product, kbUrl: key.kbUrl,
			...(reading.kind === "valid" ? { initial: reading.block } : {}), ...(record?.accepted ? { previousAccepted: record.accepted.block } : {}), notice }, signal);
	} finally { session.emit(); }
	if (!block) return false;
	await assertCurrent();
	const checked = checkBlock(block);
	if ("reason" in checked || block.repo !== key.repo) throw new Error("El borrador de Foundations es inválido o pertenece a otro repo.");
	const fresh = await session.foundations.read(ctx, ioSignal()); editable(fresh);
	if (!sameKey(key, fresh.key)) throw new Error("Cambió la identidad de origin/KB/producto/repo; no se guardó Foundations.");
	const expectation = reading.kind === "valid" ? reading.hash : reading.kind === "missing" ? null : undefined;
	const prepared = await prepareFoundationsSave(kb, key, block, ioSignal(), expectation);
	// Un v1 no es ausencia ni una política operativa: sólo se reemplaza el documento inequívoco que se abrió.
	if (reading.kind === "invalid" && (prepared.previous?.id !== reading.perillas.id || prepared.previous.cuerpo !== reading.perillas.cuerpo)) throw new Error("Las perillas cambiaron durante la edición; revisá su contenido antes de guardar.");
	await assertCurrent();
	await commitFoundationsSave(kb, key, block, prepared, { trustDir, now: session.now, signal: ioSignal(),
		beforeAccept: assertCurrent, onAccepted: (pin) => { session.foundations.replace(ctx, pin); session.emit(); } });
	ctx.ui.notify("Foundations v2 guardado en la KB y aceptado localmente. No se ejecutó ningún comando ni se concedió un grant; reintentá cualquier comando pendiente.", "info");
	return true;
}
export function shouldOfferFoundations(pin: FoundationsPin | undefined, record: TrustRecord | undefined, hasUI: boolean): boolean {
	return hasUI && pin?.reading.kind === "missing" && pin.origin === "strict" && !record?.accepted && !record?.offerDeclined;
}
/** Oferta inicial una vez por sesión. No reabre el editor al iniciar/reload ni hereda sugerencias de v1. */
export async function offerFoundations(ctx: ExtensionContext, session: DevelopmentSession, kb: KbClient | undefined): Promise<void> {
	const file = ctx.sessionManager.getSessionFile();
	if (!kb || !file || offered.has(file) || !session.state) return;
	const pin = session.foundations.current(ctx);
	if (pin?.reading.kind !== "missing") return;
	const key = pin.reading.key; const trustDir = foundationsDir(session.io.homeDir);
	if (!shouldOfferFoundations(pin, await readTrust(trustDir, key), ctx.hasUI && ctx.mode === "tui")) return;
	offered.add(file);
	const choice = await chooseFoundationsOffer(async (batch) => {
		session.checkContext(ctx); session.emit("Esperando respuesta · Foundations", true);
		try { return await askQuestions(ctx, batch, { signal: session.lifecycle.signal }); } finally { session.emit(); }
	}, key);
	if (choice === "never") {
		const existing = await readTrust(trustDir, key);
		const record = existing ?? { version: 2 as const, ...key, accepted: null, offerDeclined: false };
		// El descarte de una oferta tampoco puede borrar una aceptación guardada concurrentemente.
		await writeTrust(trustDir, { ...record, offerDeclined: true }, { expected: existing ?? null });
	} else if (choice === "build") {
		try { await editFoundations(ctx, session, kb); }
		catch (error) { ctx.ui.notify(visibleText(`No se pudo completar Foundations: ${error instanceof Error ? error.message : "error"}`), "warning"); }
	}
}
