// Configurar Foundations es una acción humana: abrir no acepta, guarda ni concede un grant. Sin Foundations nada
// pregunta. Se abre con /omi-foundations, f en la vista OMI o el setup de lo que falta (development-config-setup.ts).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkBlock, type FoundationsBlock } from "../harness/foundations.ts";
import { foundationsDir, readTrust, type TrustKey } from "../harness/foundations-trust.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { FoundationsReading } from "./development-foundations.ts";
import type { KbClient } from "./kb-client.ts";
import { guideFoundations } from "./development-foundations-guide.ts";
import { askQuestions } from "./questions/ask.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "./development-foundations-save.ts";

const SAVE_TIMEOUT_MS = 30_000;
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
	// Leer la KB puede tardar: sin espera visible, f en la pantalla OMI parecía no hacer nada.
	const reading = await session.loader(ctx, "Leyendo Foundations de la KB", (cancel) => session.foundations.read(ctx, AbortSignal.any([ioSignal(), cancel])));
	if (!reading) { ctx.ui.notify("Lectura de Foundations cancelada: no se abrió la guía ni se cambió nada.", "info"); return false; }
	editable(reading);
	if (state && issueRepo(state.source.url) !== reading.key.repo) throw new Error("El repo de origin no coincide con el issue; no se cambió Foundations.");
	const key = reading.key; const trustDir = foundationsDir(session.io.homeDir);
	const record = await readTrust(trustDir, key);
	// Abrir nunca acepta ni escribe: sólo se avisa lo que la persona tiene que saber para decidir.
	const notice = reading.kind === "invalid" && !reading.legacy ? `La configuración de la KB es inválida (${reading.reason}): empezás de cero, sin heredar permisos.` : undefined;
	session.emit("Editando Foundations", true);
	let block: FoundationsBlock | undefined;
	try {
		const previousAccepted = record?.accepted?.block;
		const initial = reading.kind === "valid" ? reading.block : reading.kind === "missing" ? previousAccepted : undefined;
		block = await guideFoundations({ key, initial, previousAccepted, notice }, (batch) => askQuestions(ctx, batch, { signal }));
	} finally { session.emit(); }
	if (!block) return false;
	await assertCurrent();
	const checked = checkBlock(block);
	if ("reason" in checked || block.repo !== key.repo) throw new Error("El borrador de Foundations es inválido o pertenece a otro repo.");
	const fresh = await session.foundations.read(ctx, ioSignal()); editable(fresh);
	if (!sameKey(key, fresh.key)) throw new Error("Cambió la identidad de origin/KB/producto/repo; no se guardó Foundations.");
	const expectation = reading.kind === "valid" ? reading.hash : reading.kind === "missing" ? null : { repair: reading.perillas };
	const prepared = await prepareFoundationsSave(kb, key, block, ioSignal(), expectation);
	await assertCurrent();
	session.foundations.supersede(ctx);
	await commitFoundationsSave(kb, key, block, prepared, { trustDir, now: session.now, signal: ioSignal(),
		beforeAccept: assertCurrent, onAccepted: (pin) => { session.foundations.replace(ctx, pin); session.emit(); } });
	ctx.ui.notify("Foundations guardado en la KB y aceptado localmente. No se ejecutó ningún comando ni se concedió un grant; reintentá cualquier comando pendiente.", "info");
	return true;
}
