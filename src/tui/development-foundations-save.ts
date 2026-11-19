// Persistencia compartida del creador de Foundations y del permiso permanente. Sin UI ni imports runtime de Pi.
import { createHash } from "node:crypto";
import { composePerillas, foundationsHash, parseFoundations, type FoundationsBlock } from "../harness/foundations.ts";
import { readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { FoundationsPin } from "./development-foundations.ts";
import type { KbClient, KbDoc } from "./kb-client.ts";

export interface PreparedSave { previous: KbDoc | null; body: string; clave: string }
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** La expectativa se valida sobre el mismo documento que se compone, incluida la ausencia explícita (null). */
export async function prepareFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, signal: AbortSignal, expectedHash?: string | null): Promise<PreparedSave> {
	signal.throwIfAborted();
	const previous = await kb.currentPerillas(key.product, signal);
	signal.throwIfAborted();
	if (expectedHash !== undefined) {
		const parsed = parseFoundations(previous?.cuerpo ?? "", key.repo);
		if (parsed.status === "invalid" || (parsed.status === "valid" ? parsed.hash : null) !== expectedHash) throw new Error("La revisión de Foundations cambió antes de componer las perillas; no se guardó nada. Revisá la KB en una sesión nueva.");
	}
	const body = composePerillas(previous?.cuerpo, key.product, key.repo, block);
	return { previous, body, clave: `omi-foundations|${key.repo.slice(0, 80)}|${previous?.id ?? "none"}|${sha256(body).slice(0, 40)}` };
}

interface SaveDeps {
	trustDir: string; now: () => string; signal: AbortSignal;
	requireLatest?: boolean; beforeAccept?: () => Promise<void>;
}
/** Control optimista, no CAS: relee antes de enviar y confirma después. La clave recupera una respuesta perdida. */
export async function commitFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, prepared: PreparedSave, deps: SaveDeps): Promise<FoundationsPin> {
	const { signal } = deps;
	signal.throwIfAborted();
	const current = await kb.currentPerillas(key.product, signal);
	signal.throwIfAborted();
	if ((current?.id ?? null) !== (prepared.previous?.id ?? null) || current?.cuerpo !== prepared.previous?.cuerpo) throw new Error("Las perillas cambiaron en la KB antes de guardar Foundations; no se guardó nada. Revisá la revisión vigente.");
	const input = { product: key.product, titulo: prepared.previous?.titulo || `Perillas de ${key.product}`, cuerpo: prepared.body, clave: prepared.clave };
	let confirmed = false;
	try {
		// Una respuesta perdida puede haber guardado; jamás reintentar después de un aborto.
		const saved = await kb.save(input, signal).catch(() => { signal.throwIfAborted(); return kb.save(input, signal); });
		signal.throwIfAborted();
		const stored = await kb.read(saved.id, signal);
		signal.throwIfAborted();
		if (stored.id !== saved.id || stored.cuerpo !== prepared.body || stored.producto !== key.product || stored.tipo !== "perillas") throw new Error("La KB devolvió otro contenido o documento al verificar el guardado.");
		confirmed = true;
		const latest = await kb.currentPerillas(key.product, signal);
		signal.throwIfAborted();
		if (deps.requireLatest && (latest?.id !== stored.id || latest.cuerpo !== prepared.body)) throw new Error("Las perillas cambiaron durante la confirmación: hay una revisión más nueva. Revisala antes de continuar.");
		await deps.beforeAccept?.();
		signal.throwIfAborted();
		const hash = foundationsHash(block);
		const record: TrustRecord = await readTrust(deps.trustDir, key) ?? { version: 1, ...key, accepted: null, offerDeclined: false };
		signal.throwIfAborted();
		await writeTrust(deps.trustDir, { ...record, accepted: { docId: stored.id, blockHash: hash, block, author: stored.autor ?? "", date: stored.fecha ?? "", acceptedAt: deps.now() } });
		signal.throwIfAborted();
		return {
			origin: "kb", block, hash, docId: stored.id, author: stored.autor ?? "", date: stored.fecha ?? "",
			notice: latest?.id === stored.id ? "" : "La KB guardó Foundations, pero ya hay perillas más nuevas: la próxima sesión muestra la diferencia.",
			reading: { kind: "valid", key, block, hash, perillas: stored },
		};
	} catch (error) {
		const why = error instanceof Error ? error.message : "falló la persistencia";
		throw new Error(`${confirmed ? "Foundations se guardó en la KB, pero no se completó su verificación o aceptación local" : "No se pudo confirmar el guardado de Foundations en la KB; pudo haberse guardado"}. ${why}`, { cause: error });
	}
}
