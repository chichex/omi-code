// Foundations de la sesión: se lee de la KB al arrancar, una revisión v2 válida se acepta sola (con aviso) y
// queda fija toda la sesión, también a través de /reload y del cambio a la sesión del worktree. Sin KB, vale
// la última v2 aceptada; sin ninguna, el default: nada pregunta. Un bloque inválido, ausente o v1 no vale.
// Lecturas y editor nunca aceptan implícitamente. Sin imports runtime de Pi: development-begin también usa este módulo.
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import type { Workflow } from "../harness/model.ts";
import { ASK_HELP, AUTO_WARNINGS, checkBlock, DEFAULT_POLICY, foundationsDiff, foundationsHash, parseFoundations, POLICY_LABELS, visibleText, type FoundationsBlock, type FoundationsPolicy, type PolicyPoint } from "../harness/foundations.ts";
import { readTrust, writeTrust, type TrustInspection, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { CommandPolicy } from "../harness/authorization.ts";
import { prefixLabel } from "../harness/command-allow.ts";
import { addAllowedPrefix, readAllowedPrefixes, removeAllowedPrefix } from "../harness/command-allow-store.ts";
import type { KbClient, KbDoc } from "./kb-client.ts";
import { HARNESS_KB_URL } from "./defaults.ts";
import { DEFAULT_TRIAGE_POLICY, parseDevelopmentTriagePolicy, type TriagePolicyPin } from "../harness/triage-policy.ts";

const READ_TIMEOUT_MS = 30_000;
const MAX_SESSIONS = 50;
export type FoundationsReading =
	| { kind: "none"; reason: string }
	| { kind: "unavailable"; key: TrustKey; reason: string }
	| { kind: "missing"; key: TrustKey; perillas: KbDoc | null }
	| { kind: "invalid"; key: TrustKey; reason: string; perillas: KbDoc; legacy?: true }
	| { kind: "valid"; key: TrustKey; block: FoundationsBlock; hash: string; perillas: KbDoc };
export interface FoundationsPin {
	version: 2; origin: "kb" | "local" | "default";
	block: FoundationsBlock | null; hash: string | null; docId: string | null; author: string | null; date: string | null;
	notice: string; reading: FoundationsReading;
}
export interface DecideDeps { trustDir: string; now: () => string; isCurrent?: () => boolean }

/** `owner/name` en minúsculas, sólo para github.com. */
export function parseRepoIdentity(url: string): string | undefined {
	const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}
const issueRepo = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(url)?.[1]?.toLowerCase();
/** Sólo lectura; no crea productos, documentos, aceptaciones ni permisos. */
export async function readFoundations(kb: KbClient | undefined, cwd: string, runner: Runner, signal: AbortSignal): Promise<FoundationsReading> {
	let repo: string | undefined;
	try { const origin = await runner.run("git", ["remote", "get-url", "origin"], { cwd, signal }); repo = origin.code === 0 ? parseRepoIdentity(origin.stdout) : undefined; } catch { repo = undefined; }
	signal.throwIfAborted();
	if (!repo) return { kind: "none", reason: "el repo no tiene origin en github.com" };
	const product = repo.split("/")[1]!;
	if (!/^[a-z0-9-]+$/.test(product)) return { kind: "none", reason: `${repo} no tiene un nombre que sea un producto de la KB` };
	const key: TrustKey = { kbUrl: kb?.url ?? HARNESS_KB_URL, product, repo };
	if (!kb) return { kind: "unavailable", key, reason: "sin KB" };
	try {
		const ready = await kb.ready(cwd, signal);
		if (!ready.ready) return { kind: "unavailable", key, reason: ready.reason };
		if (!(await kb.products(signal)).includes(product)) return { kind: "none", reason: `la KB no tiene el producto ${product} o no tenés acceso` };
		const perillas = await kb.currentPerillas(product, signal);
		signal.throwIfAborted();
		if (!perillas) return { kind: "missing", key, perillas: null };
		const parsed = parseFoundations(perillas.cuerpo, repo);
		if (parsed.status === "valid") return { kind: "valid", key, block: parsed.block, hash: parsed.hash, perillas };
		return parsed.status === "missing" ? { kind: "missing", key, perillas } : { kind: "invalid", key, reason: parsed.reason, perillas, ...(parsed.legacy ? { legacy: true as const } : {}) };
	} catch (error) {
		signal.throwIfAborted();
		return { kind: "unavailable", key, reason: error instanceof Error ? error.message : "falló la lectura" };
	}
}
const DEFAULT_NOTICE = "vale el default: nada pregunta (todo auto)";
const defaultPin = (reading: FoundationsReading, notice: string): FoundationsPin => ({ version: 2, origin: "default", block: null, hash: null, docId: null, author: null, date: null, notice, reading });
/** También valida pins viejos conservados en memoria al recargar el runtime. Lo que no valida vale como el default. */
function acceptedBlock(pin: FoundationsPin | undefined): FoundationsBlock | null {
	if (!pin || pin.version !== 2 || pin.origin === "default" || !pin.block || pin.reading?.kind === "none" || !pin.reading) return null;
	const checked = checkBlock(pin.block);
	if ("reason" in checked || foundationsHash(checked.block) !== pin.hash || pin.reading.key.repo !== checked.block.repo) return null;
	// Desde la KB, la lectura tiene que ser exactamente esa revisión.
	if (pin.origin === "kb" && (pin.reading.kind !== "valid" || pin.reading.hash !== pin.hash)) return null;
	return checked.block;
}
function safePin(pin: FoundationsPin): FoundationsPin {
	return pin.version !== 2 || pin.block && !acceptedBlock(pin) ? defaultPin(pin.reading, `Foundations sin configurar: ${DEFAULT_NOTICE}. Para pedir confirmaciones, configuralo con /omi-foundations.`) : pin;
}
/** Qué vale en la sesión. Nunca pregunta: una revisión v2 nueva y válida se acepta sola, se registra y se avisa. */
export async function decideFoundations(reading: FoundationsReading, ctx: ExtensionContext, deps: DecideDeps): Promise<FoundationsPin> {
	if (reading.kind === "none") return defaultPin(reading, `${reading.reason}: ${DEFAULT_NOTICE}.`);
	const record = await readTrust(deps.trustDir, reading.key); const accepted = record?.accepted ?? null;
	const fallback = (why: string): FoundationsPin => accepted
		? { version: 2, origin: "local", block: accepted.block, hash: accepted.blockHash, docId: accepted.docId, author: accepted.author, date: accepted.date, notice: `${why}: vale la última revisión aceptada.`, reading }
		: defaultPin(reading, `${why}: ${DEFAULT_NOTICE}.`);
	if (reading.kind === "unavailable") return fallback(`KB no disponible (${reading.reason})`);
	// Un bloque del formato anterior es, para la persona, lo mismo que no tener Foundations.
	if (reading.kind === "missing" || reading.kind === "invalid" && reading.legacy) return fallback(`Las perillas de ${reading.key.product} no tienen Foundations para ${reading.key.repo}`);
	if (reading.kind === "invalid") return fallback(`Foundations inválido en la KB (${reading.reason})`);
	const checked = checkBlock(reading.block);
	if ("reason" in checked || foundationsHash(checked.block) !== reading.hash) return fallback("Foundations inválido en la KB");
	if (deps.isCurrent?.() === false) return fallback("La decisión de Foundations quedó obsoleta durante la lectura");
	const saveTrust = (next: TrustRecord) => writeTrust(deps.trustDir, next, { expected: record ?? null, ...(deps.isCurrent ? { isCurrent: deps.isCurrent } : {}) });
	const doc = reading.perillas;
	const pin: FoundationsPin = { version: 2, origin: "kb", block: checked.block, hash: reading.hash, docId: doc.id, author: doc.autor ?? "", date: doc.fecha ?? "", notice: "", reading };
	if (record && accepted?.blockHash === reading.hash) {
		// Mismo bloque aceptado en otro documento: sólo se actualiza metadata local, nunca permisos ni KB.
		if (accepted.docId !== doc.id && deps.isCurrent?.() !== false) await saveTrust({ ...record, accepted: { ...accepted, docId: doc.id, author: doc.autor ?? "", date: doc.fecha ?? "" } }).catch(() => {});
		return pin;
	}
	// La persona la escribió en la KB: se aplica sin preguntar, también sin UI, y el aviso dice qué cambió.
	const diff = foundationsDiff(accepted?.block, checked.block, { product: reading.key.product, kbUrl: reading.key.kbUrl, docId: doc.id, ...(doc.autor ? { author: doc.autor } : {}), ...(doc.fecha ? { date: doc.fecha } : {}) });
	const applied = `Foundations: se aplica la revisión nueva de la KB, sin preguntar.\n\n${diff}\n\nVale en esta sesión y en las siguientes hasta que cambie en la KB. Nunca habilita merge, tags, workflows, deploys ni secretos; no es un sandbox.`;
	const base: TrustRecord = record ?? { version: 2, ...reading.key, accepted: null, deferred: null };
	try { await saveTrust({ ...base, accepted: { docId: doc.id, blockHash: reading.hash, block: checked.block, author: doc.autor ?? "", date: doc.fecha ?? "", acceptedAt: deps.now() } }); }
	catch {
		const notice = "No se pudo registrar la aceptación: vale en esta sesión y se vuelve a avisar en la próxima.";
		ctx.ui.notify(`${applied}\n\n${notice}`, "warning"); return { ...pin, notice };
	}
	ctx.ui.notify(applied, "info");
	return pin;
}

/** Política vigente para un trabajo: la v2 aceptada, si el issue es del mismo repo; si no, el default (todo auto). */
export function effectivePolicy(pin: FoundationsPin | undefined, state?: Workflow): { politica: FoundationsPolicy; command: CommandPolicy; hash: string | null } {
	const accepted = acceptedBlock(pin);
	const block = accepted && (!state || issueRepo(state.source.url) === accepted.repo) ? accepted : null;
	return { politica: block?.politica ?? DEFAULT_POLICY, command: { block, accepted: block !== null }, hash: block ? pin?.hash ?? null : null };
}
const ORIGINS = { kb: "KB", local: "local (última aceptada)", default: "por defecto (sin configurar: nada pregunta)" };
const origin = (pin: FoundationsPin): string => `${ORIGINS[pin.origin]}${pin.hash ? ` · revisión ${pin.hash.slice(0, 8)}` : ""}${pin.docId ? ` · perillas ${pin.docId.slice(0, 8)}${pin.author ? ` · ${pin.author}` : ""}` : ""}`;
const POINTS: readonly PolicyPoint[] = ["arranque", "receta", "push_pr"];
const rulesLines = (block: FoundationsBlock | null): string[] => ["Patrones que requieren confirmación:",
	...(block?.confirmar.length ? block.confirmar.map((rule) => visibleText(`  ${rule}`)) : [block ? "  (lista vacía: ningún comando pide confirmación por esta política)" : "  (sin configurar: nada pregunta)"])];
/** Para /omi-work status y el detalle del progreso. Sin I/O. */
export function foundationsLines(pin: FoundationsPin | undefined): string[] {
	if (!pin) return ["Foundations: se lee de la KB; se decide en el primer punto del harness."];
	pin = safePin(pin);
	const block = acceptedBlock(pin); const policy = block?.politica ?? DEFAULT_POLICY;
	return [
		visibleText(`Foundations: ${origin(pin)}`),
		"Políticas:", ...POINTS.map((point) => `  ${POLICY_LABELS[point]}: ${policy[point]}`),
		...rulesLines(block),
		...(pin.notice ? [visibleText(`Aviso: ${pin.notice}`)] : []), "Editar: /omi-foundations",
	];
}
/** Lo que la sesión leyó, para mostrar qué va a regir antes de fijar el pin. `motive`: por qué no vale una v2 de la KB.
 * `allowed`: los prefijos de «no volver a preguntar» del repo en esta máquina. */
export interface FoundationsPreview { reading: FoundationsReading; local: TrustInspection; motive: string | null; allowed?: readonly string[] }
/** Como decideFoundations, sin efectos: la v2 de la KB, si no la última aceptada en esta máquina, si no el default. */
function previewPin({ reading, local }: FoundationsPreview): FoundationsPin {
	if (reading.kind === "valid") return { version: 2, origin: "kb", block: reading.block, hash: reading.hash, docId: reading.perillas.id, author: reading.perillas.autor ?? "", date: reading.perillas.fecha ?? "", notice: "", reading };
	const accepted = reading.kind !== "none" && local.kind === "valid" ? local.record.accepted : null;
	return accepted ? { version: 2, origin: "local", block: accepted.block, hash: accepted.blockHash, docId: accepted.docId, author: accepted.author, date: accepted.date, notice: "", reading } : defaultPin(reading, "");
}
const sentence = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
/** Para la pantalla OMI: origen, cada política con lo que hace, todos los patrones, el aviso y el motivo. Sin I/O. */
export function foundationsDetail(pin: FoundationsPin | undefined, preview?: FoundationsPreview): string[] {
	const shown = pin ? safePin(pin) : preview ? previewPin(preview) : undefined;
	if (!shown) return ["Todavía no se leyó de la KB: se lee al abrir la sesión."];
	const block = acceptedBlock(shown); const policy = block?.politica ?? DEFAULT_POLICY;
	// El pin queda fijo en la sesión: una revisión nueva de la KB vale desde la próxima.
	const latest = pin && preview?.reading.kind === "valid" && preview.reading.hash !== shown.hash ? preview.reading.hash : null;
	return [
		visibleText(`Origen: ${origin(shown)}`), pin ? "Vigente en esta sesión." : "Se fija en esta sesión al empezar un trabajo.",
		...POINTS.map((point) => `${sentence(POLICY_LABELS[point])}: ${policy[point]}. ${sentence(policy[point] === "auto" ? AUTO_WARNINGS[point] : ASK_HELP[point])}.`),
		...rulesLines(block),
		...(shown.notice ? [visibleText(`Aviso: ${shown.notice}`)] : []),
		...(preview?.motive ? [visibleText(`Motivo: ${preview.motive}`)] : []),
		...(latest ? [`En la KB hay otra revisión (${latest.slice(0, 8)}): vale desde la próxima sesión.`] : []),
		...(preview?.allowed?.length ? ["No vuelven a preguntar en este repo, en esta máquina:", ...preview.allowed.map((prefix) => visibleText(`  ${prefixLabel(prefix)}`)), "Quitar: /omi-permitidos"] : []),
	];
}
interface Entry { reading: Promise<FoundationsReading>; generation?: number; pin?: FoundationsPin | undefined; deciding?: Promise<FoundationsPin> | undefined; triage?: Promise<TriagePolicyPin> }
const sessions = new Map<string, Entry>();
function remember(file: string, entry: Entry): void {
	sessions.set(file, entry);
	for (const oldest of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; sessions.delete(oldest); }
}
export function carryFoundationsPin(from: string, to: string): void {
	const entry = sessions.get(resolve(from));
	if (entry && !sessions.has(resolve(to))) remember(resolve(to), entry);
}
/** Para la pantalla OMI, que vive en otra extensión: el pin de esa sesión si ya se decidió. Sin I/O ni efectos. */
export function sessionFoundationsPin(sessionFile: string): FoundationsPin | undefined {
	const pin = sessions.get(resolve(sessionFile))?.pin;
	return pin ? safePin(pin) : undefined;
}

/** `allowDir`: los prefijos de «no volver a preguntar»; por defecto, junto al registro de Foundations. */
export interface FoundationsGateDeps extends DecideDeps { kb: KbClient | undefined; runner: Runner; allowDir?: string }
export class FoundationsGate {
	private readonly deps: FoundationsGateDeps;
	private readonly allowDir: string;
	constructor(deps: FoundationsGateDeps) { this.deps = deps; this.allowDir = deps.allowDir ?? join(dirname(deps.trustDir), "command-allow"); }
	private file(ctx: ExtensionContext): string | undefined { const file = ctx.sessionManager.getSessionFile(); return file ? resolve(file) : undefined; }
	load(ctx: ExtensionContext): void {
		const file = this.file(ctx);
		if (!file || sessions.has(file)) return;
		const reading = readFoundations(this.deps.kb, ctx.cwd, this.deps.runner, AbortSignal.timeout(READ_TIMEOUT_MS))
			.catch((error: unknown): FoundationsReading => ({ kind: "none", reason: `No se pudo leer Foundations: ${error instanceof Error ? error.message : "lectura cancelada"}` }));
		remember(file, { reading });
	}
	/** La lectura que empezó al abrir la sesión (o la del último Guardar), sin releer la KB ni decidir el pin: la usa el setup. */
	async loaded(ctx: ExtensionContext): Promise<FoundationsReading | undefined> {
		const file = this.file(ctx);
		if (!file) return undefined;
		this.load(ctx); return sessions.get(file)?.reading;
	}
	/** El editor usa esta lectura, nunca pin(): abrir no acepta ni escribe nada. */
	async read(ctx: ExtensionContext, signal: AbortSignal): Promise<FoundationsReading> {
		return readFoundations(this.deps.kb, ctx.cwd, this.deps.runner, signal);
	}
	/** El primer punto que necesita la política espera la lectura y la decide, sin preguntar. Después queda fija. */
	async pin(ctx: ExtensionContext): Promise<FoundationsPin> {
		const file = this.file(ctx);
		if (!file) return defaultPin({ kind: "none", reason: "sin sesión persistente" }, `Sin sesión persistente: ${DEFAULT_NOTICE}.`);
		this.load(ctx); const entry = sessions.get(file)!;
		if (entry.pin) { entry.pin = safePin(entry.pin); return entry.pin; }
		const generation = entry.generation ?? 0;
		entry.deciding ??= entry.reading.then((reading) => decideFoundations(reading, ctx, { ...this.deps, isCurrent: () => (entry.generation ?? 0) === generation })).finally(() => { entry.deciding = undefined; });
		const decided = safePin(await entry.deciding);
		// Un guardado propio explícito tiene precedencia sobre una decisión que quedó pendiente.
		entry.pin ??= decided;
		return entry.pin;
	}
	async triage(ctx: ExtensionContext): Promise<TriagePolicyPin> {
		const fallback = (notice: string): TriagePolicyPin => ({ origin: "default", policy: structuredClone(DEFAULT_TRIAGE_POLICY), hash: null, notice });
		const file = this.file(ctx);
		if (!file) return fallback("Sin sesión persistente: criterios de triage por defecto.");
		this.load(ctx); const entry = sessions.get(file)!;
		entry.triage ??= entry.reading.then((reading) => {
			if (reading.kind === "none" || reading.kind === "unavailable") return fallback(`Triage: ${reading.reason}; se usan criterios conservadores por defecto.`);
			const parsed = parseDevelopmentTriagePolicy(reading.perillas?.cuerpo ?? "", reading.key.repo);
			if (parsed.status === "invalid") throw new Error(`Política de triage inválida: ${parsed.reason}. No se creó ningún recurso.`);
			return parsed.status === "missing" ? fallback("Sin bloque de triage para este repo: criterios conservadores por defecto.") : { origin: "kb" as const, policy: parsed.policy, hash: parsed.hash, notice: "" };
		});
		return structuredClone(await entry.triage);
	}
	current(ctx: ExtensionContext): FoundationsPin | undefined {
		const file = this.file(ctx); const pin = file ? sessions.get(file)?.pin : undefined;
		return pin ? safePin(pin) : undefined;
	}
	/** Empieza un guardado explícito: una decisión automática pendiente queda obsoleta y no escribe la confianza. */
	supersede(ctx: ExtensionContext): void {
		const file = this.file(ctx); const entry = file && sessions.get(file);
		if (entry) entry.generation = (entry.generation ?? 0) + 1;
	}
	replace(ctx: ExtensionContext, pin: FoundationsPin): void {
		const file = this.file(ctx); const entry = file && sessions.get(file);
		if (entry) { entry.generation = (entry.generation ?? 0) + 1; entry.pin = safePin(pin); entry.reading = Promise.resolve(entry.pin.reading); }
	}
	/** Con una v2 aceptada, suma los prefijos que la persona eligió no volver a preguntar en este repo. */
	async policy(ctx: ExtensionContext, state?: Workflow): Promise<ReturnType<typeof effectivePolicy>> {
		const pin = await this.pin(ctx), policy = effectivePolicy(pin, state), key = pinKey(pin);
		if (!policy.command.accepted || !key) return policy;
		return { ...policy, command: { ...policy.command, allow: await readAllowedPrefixes(this.allowDir, key) } };
	}
	/** Los prefijos permitidos del repo de esta sesión. Sin repo conocido: undefined. No fija el pin. */
	async allowed(ctx: ExtensionContext): Promise<{ key: TrustKey; prefixes: string[] } | undefined> {
		const key = await this.repoKey(ctx);
		return key ? { key, prefixes: await readAllowedPrefixes(this.allowDir, key) } : undefined;
	}
	/** Sólo tras el sí de la persona: «Sí, y no volver a preguntar por …» o quitarlo con /omi-permitidos. */
	async allow(ctx: ExtensionContext, prefix: string): Promise<void> { await addAllowedPrefix(this.allowDir, await this.requireKey(ctx), prefix); }
	async disallow(ctx: ExtensionContext, prefix: string): Promise<void> { await removeAllowedPrefix(this.allowDir, await this.requireKey(ctx), prefix); }
	// El repo del pin, o el de la lectura de la sesión si el pin todavía no se fijó: es la misma identidad.
	private async repoKey(ctx: ExtensionContext): Promise<TrustKey | undefined> { return readingKey(this.current(ctx)?.reading) ?? readingKey(await this.loaded(ctx)); }
	private async requireKey(ctx: ExtensionContext): Promise<TrustKey> {
		const key = await this.repoKey(ctx);
		if (!key) throw new Error("No se sabe de qué repo es esta sesión (sin origin en github.com o sin producto en la KB); no se guardó nada.");
		return key;
	}
}
const readingKey = (reading: FoundationsReading | undefined): TrustKey | undefined => reading && reading.kind !== "none" ? reading.key : undefined;
const pinKey = (pin: FoundationsPin | undefined): TrustKey | undefined => readingKey(pin?.reading);
