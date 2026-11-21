// Foundations de la sesión: sólo v2 válida y aceptada autoriza. Lecturas/editor nunca aceptan implícitamente.
// Sin imports runtime de Pi: development-begin también usa este módulo.
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import type { Workflow } from "../harness/model.ts";
import { checkBlock, foundationsDiff, foundationsHash, parseFoundations, POLICY_LABELS, STRICT_POLICY, visibleText, type FoundationsBlock, type FoundationsPolicy, type PolicyPoint } from "../harness/foundations.ts";
import { readTrust, writeTrust, type TrustKey, type TrustRecord } from "../harness/foundations-trust.ts";
import type { CommandPolicy } from "../harness/authorization.ts";
import type { KbClient, KbDoc } from "./kb-client.ts";
import { HARNESS_KB_URL } from "./defaults.ts";
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
	version: 2; origin: "kb" | "local" | "strict";
	block: FoundationsBlock | null; hash: string | null; docId: string | null; author: string | null; date: string | null;
	notice: string; reading: FoundationsReading;
}
export interface DecideDeps { trustDir: string; now: () => string; confirm: (ctx: ExtensionContext, title: string, description: string) => Promise<boolean> }
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
		return parsed.status === "missing" ? { kind: "missing", key, perillas } : { kind: "invalid", key, reason: parsed.reason, perillas };
	} catch (error) {
		signal.throwIfAborted();
		return { kind: "unavailable", key, reason: error instanceof Error ? error.message : "falló la lectura" };
	}
}
const strictPin = (reading: FoundationsReading, notice: string): FoundationsPin => ({ version: 2, origin: "strict", block: null, hash: null, docId: null, author: null, date: null, notice, reading });
/** También valida pins viejos conservados en memoria al recargar el runtime. Ningún error equivale a lista vacía. */
function acceptedBlock(pin: FoundationsPin | undefined): FoundationsBlock | null {
	if (!pin || pin.version !== 2 || pin.origin === "strict" || pin.reading.kind !== "valid") return null;
	const checked = checkBlock(pin.block); const reading = checkBlock(pin.reading.block);
	if ("reason" in checked || "reason" in reading) return null;
	const hash = foundationsHash(checked.block);
	return hash === pin.hash && pin.reading.hash === hash && foundationsHash(reading.block) === hash && pin.reading.key.repo === checked.block.repo ? checked.block : null;
}
function safePin(pin: FoundationsPin): FoundationsPin {
	return pin.version !== 2 || pin.block && !acceptedBlock(pin) ? strictPin(pin.reading, "Foundations inválido u obsoleto: hay que volver a configurar y aceptar v2. Todo comando pide sí, salvo su grant humano exacto.") : pin;
}
/** Decisión explícita por revisión. Ausente/inválida/vieja/no aceptada no activa una política anterior. */
export async function decideFoundations(reading: FoundationsReading, ctx: ExtensionContext, deps: DecideDeps): Promise<FoundationsPin> {
	if (reading.kind === "none") return strictPin(reading, reading.reason);
	if (reading.kind === "unavailable") return strictPin(reading, `KB no disponible (${reading.reason}): todo comando pide confirmación salvo grants humanos exactos.`);
	if (reading.kind === "missing") return strictPin(reading, "Falta Foundations v2: configurá y guardá el modelo nuevo. Todo comando pide confirmación.");
	if (reading.kind === "invalid") return strictPin(reading, `Foundations inválido u obsoleto (${reading.reason}): volvé a configurar v2.`);
	const checked = checkBlock(reading.block);
	if ("reason" in checked || foundationsHash(checked.block) !== reading.hash) return strictPin(reading, "Foundations inválido u obsoleto: configurá v2 de nuevo.");
	const record = await readTrust(deps.trustDir, reading.key); const accepted = record?.accepted ?? null;
	const doc = reading.perillas;
	const pin: FoundationsPin = { version: 2, origin: "kb", block: checked.block, hash: reading.hash, docId: doc.id, author: doc.autor ?? "", date: doc.fecha ?? "", notice: "", reading };
	if (accepted?.blockHash === reading.hash) return pin;
	if (!ctx.hasUI) return strictPin(reading, "Hay una revisión de Foundations v2 no aceptada; aceptarla requiere UI.");
	const description = `${foundationsDiff(accepted?.block, checked.block, { product: reading.key.product, kbUrl: reading.key.kbUrl, docId: doc.id, ...(doc.autor ? { author: doc.autor } : {}), ...(doc.fecha ? { date: doc.fecha } : {}) })}\n\nCon el sí se acepta esta revisión; con no o cancelar, todo comando requiere confirmación salvo su grant humano exacto. Nunca habilita merge, tags, workflows, deploys ni secretos; no es un sandbox.`;
	if (!(await deps.confirm(ctx, "Aceptar Foundations", description))) return strictPin(reading, "Rechazaste la revisión de Foundations v2: no está aceptada.");
	const base: TrustRecord = record ?? { version: 2, ...reading.key, accepted: null, offerDeclined: false };
	try { await writeTrust(deps.trustDir, { ...base, accepted: { docId: doc.id, blockHash: reading.hash, block: checked.block, author: doc.autor ?? "", date: doc.fecha ?? "", acceptedAt: deps.now() } }); }
	catch { return strictPin(reading, "No se pudo guardar la aceptación local; esta revisión no quedó activada."); }
	return pin;
}
export function effectivePolicy(pin: FoundationsPin | undefined, state?: Workflow): { politica: FoundationsPolicy; command: CommandPolicy; hash: string | null } {
	const accepted = acceptedBlock(pin);
	const block = accepted && (!state || issueRepo(state.source.url) === accepted.repo) ? accepted : null;
	return { politica: block?.politica ?? STRICT_POLICY, command: { block, accepted: block !== null }, hash: block ? pin?.hash ?? null : null };
}
const ORIGINS = { kb: "KB", local: "local (última aceptada)", strict: "estricta" };
export function foundationsLines(pin: FoundationsPin | undefined): string[] {
	if (!pin) return ["Foundations: se lee de la KB; configurá con /omi-work foundations."];
	pin = safePin(pin);
	const block = acceptedBlock(pin); const policy = block?.politica ?? STRICT_POLICY;
	return [
		visibleText(`Foundations: ${ORIGINS[pin.origin]}${pin.hash ? ` · revisión ${pin.hash.slice(0, 8)}` : ""}${pin.docId ? ` · perillas ${pin.docId.slice(0, 8)}${pin.author ? ` · ${pin.author}` : ""}` : ""}`),
		"Políticas:", ...(Object.keys(POLICY_LABELS) as PolicyPoint[]).map((point) => `  ${POLICY_LABELS[point]}: ${policy[point]}`),
		"Patrones que requieren confirmación:", ...(block?.confirmar.length ? block.confirmar.map((rule) => visibleText(`  ${rule}`)) : [block ? "  (lista vacía: todo comando SIMPLE sin confirmación por esta política)" : "  (sin v2 aceptada: todo comando pide confirmación salvo grant exacto)"]),
		...(pin.notice ? [visibleText(`Aviso: ${pin.notice}`)] : []), "Editar: /omi-work foundations",
	];
}
interface Entry { reading: Promise<FoundationsReading>; pin?: FoundationsPin | undefined; deciding?: Promise<FoundationsPin> | undefined; triage?: Promise<TriagePolicyPin> }
const sessions = new Map<string, Entry>();
function remember(file: string, entry: Entry): void {
	sessions.set(file, entry);
	for (const oldest of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; sessions.delete(oldest); }
}
export function carryFoundationsPin(from: string, to: string): void {
	const entry = sessions.get(resolve(from));
	if (entry && !sessions.has(resolve(to))) remember(resolve(to), entry);
}
export interface FoundationsGateDeps extends DecideDeps { kb: KbClient | undefined; runner: Runner }
export class FoundationsGate {
	private readonly deps: FoundationsGateDeps;
	constructor(deps: FoundationsGateDeps) { this.deps = deps; }
	private file(ctx: ExtensionContext): string | undefined { const file = ctx.sessionManager.getSessionFile(); return file ? resolve(file) : undefined; }
	load(ctx: ExtensionContext): void {
		const file = this.file(ctx);
		if (!file || sessions.has(file)) return;
		const reading = readFoundations(this.deps.kb, ctx.cwd, this.deps.runner, AbortSignal.timeout(READ_TIMEOUT_MS))
			.catch((error: unknown): FoundationsReading => ({ kind: "none", reason: `No se pudo leer Foundations: ${error instanceof Error ? error.message : "lectura cancelada"}` }));
		remember(file, { reading });
	}
	/** El editor usa esta lectura, nunca pin(): abrir no acepta ni escribe nada. */
	async read(ctx: ExtensionContext, signal: AbortSignal): Promise<FoundationsReading> {
		return readFoundations(this.deps.kb, ctx.cwd, this.deps.runner, signal);
	}
	async pin(ctx: ExtensionContext): Promise<FoundationsPin> {
		const file = this.file(ctx);
		if (!file) return strictPin({ kind: "none", reason: "sin sesión persistente" }, "Sin sesión persistente: política estricta.");
		this.load(ctx); const entry = sessions.get(file)!;
		if (entry.pin) { entry.pin = safePin(entry.pin); return entry.pin; }
		entry.deciding ??= entry.reading.then((reading) => decideFoundations(reading, ctx, this.deps)).finally(() => { entry.deciding = undefined; });
		entry.pin = safePin(await entry.deciding);
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
	replace(ctx: ExtensionContext, pin: FoundationsPin): void {
		const file = this.file(ctx); const entry = file && sessions.get(file);
		if (entry) { entry.pin = safePin(pin); entry.reading = Promise.resolve(entry.pin.reading); }
	}
	async policy(ctx: ExtensionContext, state?: Workflow): Promise<ReturnType<typeof effectivePolicy>> { return effectivePolicy(await this.pin(ctx), state); }
}
