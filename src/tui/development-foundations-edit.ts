// Editar Foundations desde la pantalla OMI (/omi-foundations). Parte de la revisión vigente en la KB, muestra la
// diferencia contra lo que vale en la sesión y pide un único sí. Con el sí guarda (o sólo acepta, si la KB ya la
// tiene), registra la confianza local y la aplica en la sesión sin reiniciar. Cancelar no guarda nada. Un cambio
// externo nunca se pisa: se recarga y se vuelve a confirmar. Un guardado a medias deja la política anterior y
// ofrece reintentar, sin revertir la KB. Reusa el creador por preguntas y la persistencia del permiso permanente.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { foundationsHash, parseFoundations, type FoundationsBlock } from "../harness/foundations.ts";
import { detectFoundationsCandidates, type DetectedCommand } from "../harness/foundations-detect.ts";
import { foundationsDir, type TrustKey } from "../harness/foundations-trust.ts";
import { effectivePolicy, foundationsLines, readFoundations, type FoundationsPin } from "./development-foundations.ts";
import { acceptFoundations, commitFoundationsSave, FoundationsSaveError, prepareFoundationsSave } from "./development-foundations-save.ts";
import { asker, saveSignal } from "./development-foundations-setup.ts";
import { composeFoundations, confirmFoundationsRetry, confirmFoundationsSave, type Ask } from "./development-foundations-wizard.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { KbClient } from "./kb-client.ts";
import { canAsk } from "./questions/ask.ts";

const RELOADED = "Las perillas cambiaron en la KB mientras editabas: no se guardó nada. Ésta es la revisión más reciente; revisala y confirmá de nuevo.";
const CHANGED_AGAIN = "La KB volvió a cambiar antes de aceptar tu revisión: sigue valiendo la política anterior. Ésta es la revisión más reciente; revisala y confirmá de nuevo.";
const LIMITS = "Sólo cambia decisiones futuras: no deshace lo que ya corrió. Nunca habilita merge, tags, workflows, deploys ni secretos.";
const reason = (error: unknown) => error instanceof Error ? error.message : "error";

interface Editor { ctx: ExtensionContext; session: DevelopmentSession; kb: KbClient; active: FoundationsPin; ask: Ask; detected: readonly DetectedCommand[] }
type Outcome = { kind: "applied"; pin: FoundationsPin; saved: boolean } | { kind: "changed" } | { kind: "partial"; status: string };

/** Abre el editor. Los errores sin guardado (sin KB, bloque inválido, otra identidad) los informa quien llama. */
export async function editFoundations(ctx: ExtensionContext, session: DevelopmentSession, kb: KbClient | undefined): Promise<void> {
	if (!canAsk(ctx)) throw new Error("Editar Foundations necesita la TUI interactiva de OMI.");
	session.checkContext(ctx);
	if (!kb) throw new Error("No se puede editar Foundations: KB no disponible.");
	const active = await session.foundations.pin(ctx);
	const editor: Editor = { ctx, session, kb, active, ask: asker(ctx, session), detected: await detectFoundationsCandidates(session.state?.checkout.root ?? ctx.cwd) };
	for (let notice = ""; ;) {
		const next = await round(editor, notice);
		if (next === undefined) return;
		notice = next;
	}
}

/** Lo vigente en la sesión, de dónde sale y desde qué revisión se edita. */
function summary(active: FoundationsPin, base: string | null): string {
	const from = base === active.hash ? "" : base ? `Editás la revisión ${base.slice(0, 8)} de la KB, distinta de la vigente en esta sesión.` : "La KB no tiene Foundations para este repo: partís de lo vigente.";
	return [...foundationsLines(active), from].filter(Boolean).join("\n");
}
const startingBlock = (active: FoundationsPin, repo: string): FoundationsBlock => {
	const { politica, command } = effectivePolicy(active);
	return { version: 1, repo, comandos: [...command.catalog], politica: { ...politica } };
};

/** Una vuelta: relee la KB, edita y confirma. Devuelve el aviso con el que recargar, o `undefined` si terminó. */
async function round(e: Editor, notice: string): Promise<string | undefined> {
	const fresh = await readFoundations(e.kb, e.ctx.cwd, e.session.runner, saveSignal(e.session));
	if (fresh.kind === "none" || fresh.kind === "unavailable") throw new Error(`No se puede editar Foundations: ${fresh.reason}.`);
	if (fresh.kind === "invalid") throw new Error(`Foundations inválido en la KB (${fresh.reason}): corregilo en la KB antes de editarlo acá.`);
	const { key } = fresh; const was = e.active.reading.kind === "none" ? undefined : e.active.reading.key;
	if (was && (was.kbUrl !== key.kbUrl || was.product !== key.product || was.repo !== key.repo)) throw new Error("Cambió la identidad de origin/KB/producto/repo respecto de la sesión; no se editó nada.");
	const base = fresh.kind === "valid" ? fresh.hash : null;
	const done = (message: string) => { e.ctx.ui.notify(message, "info"); return undefined; };
	for (let previous = fresh.kind === "valid" ? fresh.block : startingBlock(e.active, key.repo); ;) {
		const draft = await composeFoundations(e.ask, { repo: key.repo, detected: e.detected, previous, notice: [notice, summary(e.active, base)].filter(Boolean).join("\n\n") });
		if (!draft) return done("Edición de Foundations cancelada: no se guardó nada.");
		const hash = foundationsHash(draft);
		if (hash === base && hash === e.active.hash) return done("Sin cambios en Foundations: no se guardó nada.");
		const where = hash === base
			? "La KB ya tiene esta revisión: no se guarda nada nuevo. Con el sí queda aceptada para este repo y vale desde ya en esta sesión, sin reiniciar."
			: `Se guarda en la KB, producto ${key.product}, como una revisión nueva de las perillas${fresh.perillas ? "" : " (documento nuevo)"}. Se conserva el resto del documento.${base && base !== e.active.hash ? ` Reemplaza la revisión ${base.slice(0, 8)} de la KB, que no es la vigente en esta sesión.` : ""} Con el sí queda aceptada para este repo y vale desde ya en esta sesión, sin reiniciar.`;
		const decision = await confirmFoundationsSave(e.ask, draft, { product: key.product, kbUrl: key.kbUrl, previous: e.active.block ?? undefined, where: `${where}\n${LIMITS}` });
		if (decision === "cancel") return done("Edición de Foundations cancelada: no se guardó nada.");
		if (decision === "change") { previous = draft; continue; }
		return persist(e, key, draft, base);
	}
}

/** Guarda o acepta. Ante un guardado a medias muestra el estado real y ofrece reintentar. Igual que `round`. */
async function persist(e: Editor, key: TrustKey, draft: FoundationsBlock, base: string | null): Promise<string | undefined> {
	let pending: string | undefined;
	for (;;) {
		let outcome: Outcome;
		try { outcome = await apply(e, key, draft, base); }
		// Un error fuera del guardado es anterior a enviarlo: este intento no guardó nada. Uno anterior sí pudo.
		catch (error) {
			if (pending === undefined) throw new Error(`No se guardó nada en la KB: ${reason(error)}`, { cause: error });
			outcome = { kind: "partial", status: `${pending} Al reintentar: ${reason(error)}` };
		}
		if (outcome.kind === "changed") return pending === undefined ? RELOADED : CHANGED_AGAIN;
		if (outcome.kind === "applied") {
			const where = `perillas ${(outcome.pin.docId ?? "").slice(0, 8)}`;
			e.ctx.ui.notify(outcome.saved ? `Foundations guardado en la KB (${where}), aceptado y vigente en esta sesión.` : `Foundations aceptado (${where}) y vigente en esta sesión; la KB ya tenía esta revisión.`, "info");
			return undefined;
		}
		pending ??= outcome.status;
		if (!(await confirmFoundationsRetry(e.ask, key.repo, outcome.status))) { e.ctx.ui.notify(`${outcome.status}\nSigue valiendo la política anterior.`, "warning"); return undefined; }
	}
}

/** Deja `draft` en la KB y lo acepta. `base` es el hash de Foundations que vio la persona (null: sin bloque). */
async function apply(e: Editor, key: TrustKey, draft: FoundationsBlock, base: string | null): Promise<Outcome> {
	const deps = { trustDir: foundationsDir(e.session.io.homeDir), now: e.session.now };
	let accepted: FoundationsPin | undefined;
	// Durable apenas queda escrita: vale en la sesión aunque después algo falle (como el permiso permanente).
	const onAccepted = (pin: FoundationsPin) => { accepted = pin; e.session.foundations.replace(e.ctx, pin); e.session.emit(); };
	const doc = await e.kb.currentPerillas(key.product, saveSignal(e.session));
	const parsed = parseFoundations(doc?.cuerpo ?? "", key.repo);
	const now = parsed.status === "valid" ? parsed.hash : parsed.status === "missing" ? null : undefined;
	const hash = foundationsHash(draft);
	// Ya está en la KB: la persona la eligió tal cual o un intento anterior la guardó. Sólo falta aceptarla.
	if (doc && now === hash) {
		let pin: FoundationsPin;
		try { pin = await acceptFoundations(key, draft, doc, { ...deps, signal: saveSignal(e.session) }); }
		catch (error) { return { kind: "partial", status: `La KB ya tiene esta revisión, pero no se registró su aceptación local. ${reason(error)}` }; }
		onAccepted(pin);
		return { kind: "applied", pin, saved: false };
	}
	if (now !== base) return { kind: "changed" };
	try {
		const prepared = await prepareFoundationsSave(e.kb, key, draft, saveSignal(e.session), base);
		return { kind: "applied", pin: await commitFoundationsSave(e.kb, key, draft, prepared, { ...deps, signal: saveSignal(e.session), requireLatest: true, onAccepted }), saved: true };
	} catch (error) {
		if (!(error instanceof FoundationsSaveError)) throw error;
		if (error.stage === "conflict") return { kind: "changed" };
		if (error.stage === "accepted" && accepted) return { kind: "applied", pin: accepted, saved: true };
		return { kind: "partial", status: error.message };
	}
}
