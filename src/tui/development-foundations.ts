// Foundations de la sesión: se lee de la KB al arrancar, una revisión válida se acepta sola (con aviso) y
// queda fija toda la sesión, también a través de /reload y del cambio a la sesión del worktree. Sin KB, vale
// la última revisión aceptada; sin ninguna, el default: nada pregunta. Un bloque inválido o ausente no vale.
// Sin imports de Pi en tiempo de carga: development-begin lo importa.
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import type { Workflow } from "../harness/model.ts";
import { checkBlock, commandProblem, DEFAULT_POLICY, foundationsDiff, foundationsHash, parseFoundations, POLICY_LABELS, visibleText, type FoundationsBlock, type FoundationsPolicy, type PolicyPoint } from "../harness/foundations.ts";
import { readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { CommandPolicy } from "../harness/authorization.ts";
import type { KbClient, KbDoc } from "./kb-client.ts";
import { HARNESS_KB_URL } from "./defaults.ts";
import { commitFoundationsSave, prepareFoundationsSave } from "./development-foundations-save.ts";
import { DEFAULT_TRIAGE_POLICY, parseDevelopmentTriagePolicy, type TriagePolicyPin } from "../harness/triage-policy.ts";

const READ_TIMEOUT_MS = 30_000;
const MAX_SESSIONS = 50;
export type FoundationsReading =
	| { kind: "none"; reason: string }
	| { kind: "unavailable"; key: TrustKey; reason: string }
	| { kind: "missing"; key: TrustKey; perillas: KbDoc | null }
	| { kind: "invalid"; key: TrustKey; reason: string; perillas: KbDoc }
	| { kind: "valid"; key: TrustKey; block: FoundationsBlock; hash: string; perillas: KbDoc };
export interface FoundationsPin {
	origin: "kb" | "local" | "default";
	block: FoundationsBlock | null; hash: string | null; docId: string | null; author: string | null; date: string | null;
	notice: string; reading: FoundationsReading;
}
export interface DecideDeps { trustDir: string; now: () => string }

/** `owner/name` en minúsculas, sólo para github.com. */
export function parseRepoIdentity(url: string): string | undefined {
	const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}
const issueRepo = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(url)?.[1]?.toLowerCase();

/** Sin efectos: lee el origin y las perillas vigentes. Nunca crea un producto ni guarda nada. */
export async function readFoundations(kb: KbClient | undefined, cwd: string, runner: Runner, signal: AbortSignal): Promise<FoundationsReading> {
	let repo: string | undefined;
	try { const origin = await runner.run("git", ["remote", "get-url", "origin"], { cwd, signal }); repo = origin.code === 0 ? parseRepoIdentity(origin.stdout) : undefined; } catch { repo = undefined; }
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
		if (!perillas) return { kind: "missing", key, perillas: null };
		const parsed = parseFoundations(perillas.cuerpo, repo);
		if (parsed.status === "valid") return { kind: "valid", key, block: parsed.block, hash: parsed.hash, perillas };
		return parsed.status === "missing" ? { kind: "missing", key, perillas } : { kind: "invalid", key, reason: parsed.reason, perillas };
	} catch (error) { return { kind: "unavailable", key, reason: error instanceof Error ? error.message : "falló la lectura" }; }
}

const DEFAULT_NOTICE = "vale el default: nada pregunta (todo auto)";
const defaultPin = (reading: FoundationsReading, notice: string): FoundationsPin => ({ origin: "default", block: null, hash: null, docId: null, author: null, date: null, notice, reading });
/** Qué vale en la sesión. Nunca pregunta: una revisión nueva y válida se acepta sola, se registra y se avisa. */
export async function decideFoundations(reading: FoundationsReading, ctx: ExtensionContext, deps: DecideDeps): Promise<FoundationsPin> {
	if (reading.kind === "none") return defaultPin(reading, `${reading.reason}: ${DEFAULT_NOTICE}.`);
	const record = await readTrust(deps.trustDir, reading.key);
	const accepted = record?.accepted ?? null;
	const fallback = (why: string): FoundationsPin => accepted
		? { origin: "local", block: accepted.block, hash: accepted.blockHash, docId: accepted.docId, author: accepted.author, date: accepted.date, notice: `${why}: vale la última revisión aceptada.`, reading }
		: defaultPin(reading, `${why}: ${DEFAULT_NOTICE}.`);
	if (reading.kind === "unavailable") return fallback(`KB no disponible (${reading.reason})`);
	if (reading.kind === "missing") return fallback(`Las perillas de ${reading.key.product} no tienen Foundations para ${reading.key.repo}`);
	if (reading.kind === "invalid") return fallback(`Foundations inválido en la KB (${reading.reason})`);
	const doc = reading.perillas;
	const pin: FoundationsPin = { origin: "kb", block: reading.block, hash: reading.hash, docId: doc.id, author: doc.autor ?? "", date: doc.fecha ?? "", notice: "", reading };
	const save = (next: TrustRecord) => writeTrust(deps.trustDir, next);
	const base: TrustRecord = record ?? { version: 1, ...reading.key, accepted: null, offerDeclined: false };
	const revision = { docId: doc.id, blockHash: reading.hash, block: reading.block, author: doc.autor ?? "", date: doc.fecha ?? "" };
	if (accepted?.blockHash === reading.hash) {
		// Alguien editó otra parte de las perillas: es la misma revisión de Foundations.
		if (accepted.docId !== doc.id) await save({ ...base, accepted: { ...accepted, ...revision } }).catch(() => {});
		return pin;
	}
	// La persona la escribió en la KB: se aplica sin preguntar, también sin UI, y el aviso dice qué cambió.
	const diff = foundationsDiff(accepted?.block, reading.block, { product: reading.key.product, kbUrl: reading.key.kbUrl, docId: doc.id, ...(doc.autor ? { author: doc.autor } : {}), ...(doc.fecha ? { date: doc.fecha } : {}) });
	const applied = `Foundations: se aplica la revisión nueva de la KB, sin preguntar.\n\n${diff}\n\nVale en esta sesión y en las siguientes hasta que cambie en la KB. Nunca habilita merge, tags, workflows, deploys ni secretos.`;
	try { await save({ ...base, accepted: { ...revision, acceptedAt: deps.now() } }); }
	catch {
		const notice = "No se pudo registrar la aceptación: vale en esta sesión y se vuelve a avisar en la próxima.";
		ctx.ui.notify(`${applied}\n\n${notice}`, "warning"); return { ...pin, notice };
	}
	ctx.ui.notify(applied, "info");
	return pin;
}

/** Política vigente para un trabajo: la del pin, si el issue es del mismo repo; si no, el default (todo auto). */
export function effectivePolicy(pin: FoundationsPin | undefined, state?: Workflow): { politica: FoundationsPolicy; command: CommandPolicy; hash: string | null } {
	const block = pin?.block && (!state || issueRepo(state.source.url) === pin.block.repo) ? pin.block : null;
	const politica = block?.politica ?? DEFAULT_POLICY;
	return { politica, command: { catalog: block?.comandos ?? [], outside: politica.fuera_de_catalogo }, hash: block ? pin?.hash ?? null : null };
}
const ORIGINS = { kb: "KB", local: "local (última aceptada)", default: "por defecto (sin Foundations: nada pregunta)" };
/** Para /omi-work status y el detalle del progreso. Sin I/O. */
export function foundationsLines(pin: FoundationsPin | undefined): string[] {
	if (!pin) return ["Foundations: se lee de la KB; se decide en el primer punto del harness."];
	const policy = pin.block?.politica ?? DEFAULT_POLICY;
	return [
		visibleText(`Foundations: ${ORIGINS[pin.origin]}${pin.hash ? ` · revisión ${pin.hash.slice(0, 8)}` : ""}${pin.docId ? ` · perillas ${pin.docId.slice(0, 8)}${pin.author ? ` · ${pin.author}` : ""}` : ""}`),
		`Políticas: ${(Object.keys(POLICY_LABELS) as PolicyPoint[]).map((point) => `${POLICY_LABELS[point]} ${policy[point]}`).join(" · ")}`,
		`Catálogo: ${pin.block?.comandos.length ? pin.block.comandos.join(" | ") : `sin comandos${policy.fuera_de_catalogo === "ask" ? " (todo comando fuera de la receta pregunta)" : ""}`}`,
		...(pin.notice ? [visibleText(`Aviso: ${pin.notice}`)] : []),
	];
}

// Por archivo de sesión y en memoria del proceso: sobrevive /reload y el cambio de sesión. Reabrir OMI vuelve a leer.
interface Entry { reading: Promise<FoundationsReading>; pin?: FoundationsPin | undefined; deciding?: Promise<FoundationsPin> | undefined; triage?: Promise<TriagePolicyPin> }
const sessions = new Map<string, Entry>();
function remember(file: string, entry: Entry): void {
	sessions.set(file, entry);
	for (const oldest of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; sessions.delete(oldest); }
}
/** El arranque lleva el pin de la sesión de origen a la del worktree, antes de cambiar. */
export function carryFoundationsPin(from: string, to: string): void {
	const entry = sessions.get(resolve(from));
	if (entry && !sessions.has(resolve(to))) remember(resolve(to), entry);
}

export interface FoundationsGateDeps extends DecideDeps { kb: KbClient | undefined; runner: Runner }
export class FoundationsGate {
	private readonly deps: FoundationsGateDeps;
	constructor(deps: FoundationsGateDeps) { this.deps = deps; }
	private file(ctx: ExtensionContext): string | undefined { const file = ctx.sessionManager.getSessionFile(); return file ? resolve(file) : undefined; }
	/** session_start: lanza la lectura en segundo plano si esta sesión todavía no tiene una. No pregunta. */
	load(ctx: ExtensionContext): void {
		const file = this.file(ctx);
		if (!file || sessions.has(file)) return;
		remember(file, { reading: readFoundations(this.deps.kb, ctx.cwd, this.deps.runner, AbortSignal.timeout(READ_TIMEOUT_MS)) });
	}
	/** El primer punto que necesita la política espera la lectura y la decide, sin preguntar. Después queda fija. */
	async pin(ctx: ExtensionContext): Promise<FoundationsPin> {
		const file = this.file(ctx);
		if (!file) return defaultPin({ kind: "none", reason: "sin sesión persistente" }, `Sin sesión persistente: ${DEFAULT_NOTICE}.`);
		this.load(ctx);
		const entry = sessions.get(file)!;
		if (entry.pin) return entry.pin;
		entry.deciding ??= entry.reading.then((reading) => decideFoundations(reading, ctx, this.deps)).finally(() => { entry.deciding = undefined; });
		entry.pin = await entry.deciding;
		return entry.pin;
	}
	/** Sólo criterios, no autorizaciones: comparte la lectura de perillas sin aceptar Foundations ni guardar nada. */
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
	current(ctx: ExtensionContext): FoundationsPin | undefined { const file = this.file(ctx); return file ? sessions.get(file)?.pin : undefined; }
	/** Una persona armó Foundations en esta sesión: es su propio sí, no un cambio externo. */
	replace(ctx: ExtensionContext, pin: FoundationsPin): void { const file = this.file(ctx); const entry = file && sessions.get(file); if (entry) entry.pin = pin; }
	async policy(ctx: ExtensionContext, state?: Workflow): Promise<ReturnType<typeof effectivePolicy>> { return effectivePolicy(await this.pin(ctx), state); }
	/** La persona eligió guardar este comando, no aceptar cambios ajenos en comandos o políticas. El pin lo reemplaza quien llama, en onAccepted. */
	async saveCommand(ctx: ExtensionContext, state: Workflow, command: string, signal: AbortSignal, hooks: { beforeAccept: () => Promise<void>; onAccepted: (pin: FoundationsPin) => void }): Promise<FoundationsPin> {
		signal.throwIfAborted();
		const problem = commandProblem(command);
		if (problem) throw new Error(`Comando inválido para Foundations: ${problem}`);
		const kb = this.deps.kb;
		if (!kb) throw new Error("No se puede guardar el permiso permanente: KB no disponible.");
		const pin = await this.pin(ctx);
		const fresh = await readFoundations(kb, state.checkout.root, this.deps.runner, signal);
		signal.throwIfAborted();
		if (fresh.kind === "none" || fresh.kind === "unavailable") throw new Error(`No se puede guardar el permiso en la KB: ${fresh.reason}`);
		if (fresh.kind === "invalid") throw new Error(`Foundations inválido en la KB: ${fresh.reason}`);
		const key = fresh.key;
		if (issueRepo(state.source.url) !== key.repo || pin.reading.kind === "none" || pin.reading.key.repo !== key.repo || pin.reading.key.product !== key.product || pin.reading.key.kbUrl !== key.kbUrl) throw new Error("Cambió la identidad de origin/KB/producto/repo respecto del trabajo o del pin; no se guardó el permiso.");
		const expectedHash = pin.block ? foundationsHash(pin.block) : null;
		if ((fresh.kind === "valid" ? fresh.hash : null) !== expectedHash) throw new Error("La revisión de Foundations cambió respecto de la aceptada en esta sesión. Revisala en una sesión nueva antes de guardar el comando.");
		// Sumar un comando no cambia políticas: sin bloque, se crea con las del default que ya valían.
		const base: FoundationsBlock = fresh.kind === "valid" ? fresh.block : { version: 1, repo: key.repo, comandos: [], politica: { ...DEFAULT_POLICY } };
		const block = { ...base, comandos: [...new Set([...base.comandos, command])] };
		const checked = checkBlock(block);
		if ("reason" in checked) throw new Error(`No se puede agregar el comando al catálogo de Foundations: ${checked.reason}`);
		// También verifica la expectativa sobre la relectura que realmente se usa para componer.
		const prepared = await prepareFoundationsSave(kb, key, checked.block, signal, expectedHash);
		await hooks.beforeAccept();
		return commitFoundationsSave(kb, key, checked.block, prepared, { trustDir: this.deps.trustDir, now: this.deps.now, signal, requireLatest: true, ...hooks });
	}
}
