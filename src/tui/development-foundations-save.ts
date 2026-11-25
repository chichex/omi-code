// Guardado explícito de Foundations v2. Sin UI, ejecución de comandos ni imports runtime de Pi.
import { createHash } from "node:crypto";
import { checkBlock, composePerillas, foundationsHash, parseFoundations, type FoundationsBlock } from "../harness/foundations.ts";
import { readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { FoundationsPin } from "./development-foundations.ts";
import { MAX_KB_DOCUMENT_LENGTH, type KbClient, type KbDoc } from "./kb-client.ts";

/** En qué quedó la KB: cambió antes de guardar (nada guardado), pudo haberse guardado, quedó guardada sin aceptar, o aceptada. */
export type SaveStage = "conflict" | "unconfirmed" | "saved" | "accepted";
export class FoundationsSaveError extends Error {
	readonly stage: SaveStage;
	constructor(stage: SaveStage, message: string, options?: ErrorOptions) { super(message, options); this.name = "FoundationsSaveError"; this.stage = stage; }
}

export interface PreparedSave { previous: KbDoc | null; body: string; clave: string }
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type SaveExpectation = string | null | { repair: Pick<KbDoc, "id" | "cuerpo"> };
/** Hash válido, ausencia explícita (null), o las perillas exactas que abrió la guía para reparar. */
export async function prepareFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, signal: AbortSignal, expected?: SaveExpectation): Promise<PreparedSave> {
	signal.throwIfAborted();
	const previous = await kb.currentPerillas(key.product, signal);
	signal.throwIfAborted();
	const repair = expected && typeof expected === "object" ? expected.repair : undefined;
	if (expected !== undefined) {
		const parsed = parseFoundations(previous?.cuerpo ?? "", key.repo);
		const matches = repair ? parsed.status === "invalid" && previous?.id === repair.id && previous.cuerpo === repair.cuerpo
			: parsed.status !== "invalid" && (parsed.status === "valid" ? parsed.hash : null) === expected;
		if (!matches) throw new FoundationsSaveError("conflict", "La revisión de Foundations cambió antes de componer las perillas; no se guardó nada. Revisá la KB en una sesión nueva.");
	}
	const body = composePerillas(previous?.cuerpo, key.product, key.repo, block, { repairInvalid: repair !== undefined });
	if (body.length > MAX_KB_DOCUMENT_LENGTH) throw new Error(`Las perillas resultantes exceden el límite legible de KB (${MAX_KB_DOCUMENT_LENGTH} caracteres); no se guardó nada.`);
	return { previous, body, clave: `omi-foundations|${key.repo.slice(0, 80)}|${previous?.id ?? "none"}|${sha256(body).slice(0, 40)}` };
}

interface SaveDeps {
	trustDir: string; now: () => string; signal: AbortSignal; writeAcceptance?: typeof writeTrust;
	beforeAccept?: () => Promise<void>;
	/** Publica sólo una aceptación durable que siga vigente; editar/guardar nunca ejecuta comandos. */
	onAccepted?: (pin: FoundationsPin) => void;
}
// Turnos por identidad compartida, no por objeto KbClient ni sesión. Sólo coordinan este proceso.
const saveTurns = new Map<string, object>();
function beginSave(key: TrustKey) {
	const id = JSON.stringify([key.kbUrl, key.product, key.repo]); const token = {};
	saveTurns.set(id, token);
	const isCurrent = () => saveTurns.get(id) === token;
	return { isCurrent, close: () => { if (isCurrent()) saveTurns.delete(id); } };
}
/** Control optimista, no CAS: relee antes de enviar y confirma después. La clave recupera una respuesta perdida. */
export async function commitFoundationsSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, prepared: PreparedSave, deps: SaveDeps): Promise<FoundationsPin> {
	const { signal } = deps;
	signal.throwIfAborted();
	if (prepared.body.length > MAX_KB_DOCUMENT_LENGTH) throw new Error(`Las perillas exceden el límite legible de KB (${MAX_KB_DOCUMENT_LENGTH} caracteres); no se guardó nada.`);
	const checked = checkBlock(block);
	const persisted = parseFoundations(prepared.body, key.repo);
	if ("reason" in checked || persisted.status !== "valid" || checked.block.repo !== key.repo || foundationsHash(checked.block) !== persisted.hash) throw new Error("El bloque o el documento preparado de Foundations es inválido o cambió; no se guardó nada.");
	// Aceptar exactamente lo persistido, no un objeto mutable que cambie durante el I/O.
	block = structuredClone(persisted.block);
	const turn = beginSave(key);
	try { return await persistSave(kb, key, block, prepared, deps, turn.isCurrent); }
	finally { turn.close(); }
}
async function persistSave(kb: KbClient, key: TrustKey, block: FoundationsBlock, prepared: PreparedSave, deps: SaveDeps, isCurrent: () => boolean): Promise<FoundationsPin> {
	const { signal } = deps;
	const assertCurrent = () => {
		signal.throwIfAborted();
		if (!isCurrent()) throw new Error("El guardado de Foundations quedó obsoleto ante un guardado más nuevo; no se publicó el pin anterior.");
	};
	// Capturar antes del I/O remoto o de cualquier decisión pendiente; nunca releer para adoptar un permiso ajeno.
	const initialTrust = await readTrust(deps.trustDir, key);
	assertCurrent();
	const current = await kb.currentPerillas(key.product, signal);
	assertCurrent();
	if ((current?.id ?? null) !== (prepared.previous?.id ?? null) || current?.cuerpo !== prepared.previous?.cuerpo) throw new FoundationsSaveError("conflict", "Las perillas cambiaron en la KB antes de guardar Foundations; no se guardó nada. Revisá la revisión vigente.");
	const input = { product: key.product, titulo: prepared.previous?.titulo || `Perillas de ${key.product}`, cuerpo: prepared.body, clave: prepared.clave };
	let confirmed = false; let accepted = false;
	try {
		// Una respuesta perdida puede haber guardado; jamás reintentar después de un aborto.
		const saved = await kb.save(input, signal).catch(async () => {
			assertCurrent();
			const latest = await kb.currentPerillas(key.product, signal);
			assertCurrent();
			const unchanged = (latest?.id ?? null) === (prepared.previous?.id ?? null) && latest?.cuerpo === prepared.previous?.cuerpo;
			// La misma clave recupera un envío ya persistido; si no, sólo reintentar sobre la base comprobada.
			if (!unchanged && latest?.cuerpo !== prepared.body) throw new Error("Las perillas cambiaron durante el primer fallo; no se reenvió sobre una revisión concurrente.");
			return kb.save(input, signal);
		});
		assertCurrent();
		const stored = await kb.read(saved.id, signal);
		assertCurrent();
		if (stored.id !== saved.id || stored.cuerpo !== prepared.body || stored.producto !== key.product || stored.tipo !== "perillas") throw new Error("La KB devolvió otro contenido o documento al verificar el guardado.");
		confirmed = true;
		const assertLatest = async () => {
			assertCurrent();
			const latest = await kb.currentPerillas(key.product, signal);
			assertCurrent();
			if (latest?.id !== stored.id || latest.cuerpo !== prepared.body) throw new Error("Las perillas cambiaron durante la confirmación: hay una revisión más nueva. Revisala antes de continuar.");
		};
		await assertLatest();
		await deps.beforeAccept?.();
		assertCurrent();
		const hash = foundationsHash(block);
		const record: TrustRecord = initialTrust ?? { version: 2, ...key, accepted: null, deferred: null };
		const nextRecord: TrustRecord = { ...record, accepted: { docId: stored.id, blockHash: hash, block, author: stored.autor ?? "", date: stored.fecha ?? "", acceptedAt: deps.now() } };
		await (deps.writeAcceptance ?? writeTrust)(deps.trustDir, nextRecord, {
			expected: initialTrust ?? null, isCurrent: () => isCurrent() && !signal.aborted,
			// Dentro de la cola local, tras preparar el temporal y antes del reemplazo atómico.
			beforeReplace: assertLatest,
		});
		accepted = true;
		await assertLatest();
		if (JSON.stringify(await readTrust(deps.trustDir, key)) !== JSON.stringify(nextRecord)) throw new Error("La aceptación local cambió después de escribir; no se publicó el pin anterior.");
		assertCurrent();
		const pin: FoundationsPin = {
			version: 2, origin: "kb", block, hash, docId: stored.id, author: stored.autor ?? "", date: stored.fecha ?? "",
			notice: "",
			reading: { kind: "valid", key, block, hash, perillas: stored },
		};
		deps.onAccepted?.(pin);
		signal.throwIfAborted();
		return pin;
	} catch (error) {
		const why = error instanceof Error ? error.message : "falló la persistencia";
		const status = !isCurrent() ? "Un guardado más nuevo reemplazó este turno de Foundations; no se publicó el pin anterior ni se ejecutó el comando"
			: accepted ? "Foundations quedó guardado en la KB y aceptado localmente para futuras sesiones, pero no se ejecutó el comando"
			: confirmed ? "Foundations se guardó en la KB, pero no se completó su verificación o aceptación local"
				: "No se pudo confirmar el guardado de Foundations en la KB; pudo haberse guardado";
		throw new FoundationsSaveError(accepted ? "accepted" : confirmed ? "saved" : "unconfirmed", `${status}. ${why}`, { cause: error });
	}
}
