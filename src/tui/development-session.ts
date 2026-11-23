// Adaptación de una sesión Pi a un trabajo durable. No se reanudan efectos al cargar la sesión.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { processRunner, type Runner } from "../core/exec.ts";
import { parseWorkflow, type Workflow, type WorkflowV2, type Phase } from "../harness/model.ts";
export interface ObservationOrigin { id: string; source: string; epoch: number; phase: Phase; round: number }
import type { ReadReceipt } from "../harness/references.ts";
import { createWorkflow, recipeApprovalHash, transition, type WorkflowEvent } from "../harness/state.ts";
import { readWorkflow, updateWorkflow } from "../harness/store.ts";
import { inspectCheckout } from "../harness/git.ts";
import { readIssueSource } from "../harness/github.ts";
import { pullRequestBody, renderWorkflowArtifact } from "../harness/pr-body.ts";
import { publishTargets, publishWork } from "./development-stack.ts";
import { updateIssueSection } from "./development-issue.ts";
import { restoreIssueTriage } from "./workspace/issue-triage.ts";
import { readGit } from "./workspace/data.ts";
import { developmentProgress, PHASE_LABELS } from "./development-view.ts";
import { borderedLoader, type WaitLoader } from "./development-loader.ts";
import { developmentOffline } from "./development-tickets.ts";
import { approvalDocument, approvalText, type ApprovalDocument } from "./development-approval.ts";
import { PUBLICATION_TITLE, publicationDocument, publicationSummary } from "./development-publication.ts";
import { showApprovalReview } from "./development-approval-view.ts";
import type { KbClient } from "./kb-client.ts";
import { FoundationsGate, foundationsLines } from "./development-foundations.ts";
import { foundationsDir } from "../harness/foundations-trust.ts";
import { showCommandChoices } from "./development-command-dialog.ts";
import { lifecycleLines } from "../harness/lifecycle-progress.ts";
import type { LifecyclePorts } from "./development-lifecycle.ts";
import { LifecycleContinuityHost } from "./development-lifecycle-continuity.ts";

export const DEVELOPMENT_ANCHOR = "omi-development-workflow";
const AnchorSchema = Type.Object({ id: Type.String(), root: Type.String(), issue: Type.Integer({ minimum: 1 }), revision: Type.Integer({ minimum: 0 }), disabled: Type.Optional(Type.Boolean()) });
export interface DevelopmentDeps { runner?: Runner; now?: () => string; loader?: WaitLoader; kb?: KbClient; lifecycle?: LifecyclePorts; classifyTimeoutMs?: number }
// El preflight y el documento íntegro se comparten con la revisión TUI y RPC.
export function approvalPreview(state: Workflow): string { return approvalText(approvalDocument(state)); }
export class DevelopmentSession {
	state: Workflow | undefined;
	onChange: (() => void) | undefined;
	lockedReason = "";
	/** Una tool del harness cerró el turno a propósito (pausa, PR, un no de la persona): no se retoma solo. */
	turnYielded = false;
	readonly reads = new Map<string, ReadReceipt>();
	readonly runner: Runner;
	readonly now: () => string;
	/** Espera con Esc para cancelar: clasificar un pedido o leer la KB. */
	readonly loader: WaitLoader;
	readonly lifecycle = new AbortController();
	readonly continuity = new LifecycleContinuityHost(this);
	private context: ExtensionContext | undefined;
	// Último vínculo válido de la conversación: permite salir aunque el estado no se pueda leer.
	private lastAnchor: { id: string; root: string; issue: number; revision: number } | undefined;
	private alive = true;
	private epoch = 0;
	private mutations: Promise<unknown> = Promise.resolve();
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = this.mutations.then(work); this.mutations = result.catch(() => {}); return result;
	}
	observationOrigin(): ObservationOrigin | undefined {
		const s = this.state;
		return s && this.alive && !this.lockedReason ? { id: s.id, source: s.source.hash, epoch: this.epoch, phase: s.phase, round: s.round } : undefined;
	}
	observe(origin: ObservationOrigin | undefined, mode: "inline" | "subagent" | "lens", ctx: ExtensionContext): Promise<void> {
		return this.serialize(async () => {
			const s = this.state;
			if (!origin || !s || !this.alive || this.lockedReason || origin.epoch !== this.epoch || origin.id !== s.id || origin.source !== s.source.hash || origin.round !== s.round) return;
			const previous = s.observations?.find(o => o.phase === origin.phase && o.round === origin.round);
			if (previous?.[mode]) return;
			this.checkContext(ctx);
			this.state = await updateWorkflow(s.checkout, s.source.number, s.revision, saved => {
				if (!saved || saved.id !== s.id) throw new Error("El trabajo cambió");
				const observations = (saved.observations ?? []).filter(o => o.phase !== origin.phase || o.round !== origin.round);
				observations.push({ phase: origin.phase, round: origin.round, inline: false, subagent: false, lens: false, ...previous, [mode]: true });
				return parseWorkflow(JSON.stringify({ ...saved, observations, revision: saved.revision + 1 }));
			});
			this.anchor(); this.emit();
		}).catch(() => { ctx.ui.notify("No se pudo guardar una observación de ejecución; no se mostrará como confirmada.", "warning"); });
	}
	offline: boolean;
	readonly pi: ExtensionAPI;
	readonly io: Io;
	/** Foundations fijo de esta sesión: decide qué corre o avanza sin preguntar. */
	readonly foundations: FoundationsGate;
	/** Sólo el host usa este cliente para el guardado explícito desde el panel; no es una tool del modelo. */
	readonly kb: KbClient | undefined;
	/** Lifecycle post-PR: lecturas GitHub acotadas (sin runner inyectado, el del harness) y puertos de prueba. */
	readonly githubRunner: Runner | undefined;
	readonly lifecyclePorts: LifecyclePorts;
	/** Dueño de las actividades del lifecycle que abre esta sesión. */
	readonly owner = randomUUID();
	constructor(pi: ExtensionAPI, io: Io, args: readonly string[], deps: DevelopmentDeps = {}) {
		this.pi = pi; this.io = io;
		this.runner = deps.runner ?? processRunner; this.now = deps.now ?? (() => new Date().toISOString()); this.loader = deps.loader ?? borderedLoader;
		this.offline = developmentOffline(args, io.env);
		this.kb = deps.kb; this.githubRunner = deps.runner; this.lifecyclePorts = deps.lifecycle ?? {};
		this.foundations = new FoundationsGate({ kb: deps.kb, runner: this.runner, trustDir: foundationsDir(io.homeDir), now: this.now });
	}
	private anchor(): void {
		const s = this.state;
		if (s && this.alive) this.pi.appendEntry(DEVELOPMENT_ANCHOR, { id: s.id, root: s.checkout.root, issue: s.source.number, revision: s.revision });
	}
	emit(activity?: string, waiting = false): void {
		if (!this.alive) return;
		const progress = this.state ? developmentProgress(this.state, activity, foundationsLines(this.context && this.foundations.current(this.context))) : undefined;
		if (progress && (this.lockedReason || waiting)) {
			progress.status = "waiting"; progress.blockedReason = this.lockedReason;
			if (progress.stages) progress.stages = progress.stages.map(s => s.current ? { ...s, status: "waiting" } : s);
		}
		this.onChange?.();
		this.pi.events.emit("omi:workflow", { progress });
		this.context?.ui.setStatus("omi-development", progress ? `Desarrollo · ${progress.phaseLabel}${progress.blockedReason ? " · bloqueado" : ""}` : this.lockedReason ? "Desarrollo · bloqueado · /omi-work stop para salir" : undefined);
	}
	private async checkout(ctx: ExtensionContext): Promise<Workflow["checkout"]> {
		const prepared = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd);
		if (!prepared) throw new Error("Esta sesión no es el worktree de un issue. Pedí el cambio en el chat o elegí un issue en Issues y OMI prepara su worktree.");
		const git = await readGit(ctx.cwd, this.lifecycle.signal);
		if (!git || git.detached || git.branch !== prepared.branch || resolve(git.root) !== resolve(prepared.worktree)) throw new Error("La sesión no está en el worktree y rama del issue preparado");
		return { root: await realpath(git.root), commonDir: await realpath(git.commonDir), branch: prepared.branch, baseCommit: prepared.baseCommit };
	}
	checkContext(ctx: ExtensionContext): void {
		if (!ctx.isProjectTrusted() || !ctx.sessionManager.getSessionFile()) throw new Error("El harness requiere proyecto de confianza y sesión persistente");
		if (this.state && resolve(ctx.cwd) !== resolve(this.state.checkout.root)) throw new Error("El trabajo pertenece a otro checkout");
		if (this.lockedReason) throw new Error(this.lockedReason);
	}
	current(ctx: ExtensionContext): Workflow {
		this.checkContext(ctx);
		if (!this.state) throw new Error("No hay trabajo activo. Pedí el cambio en el chat o elegí un issue en Issues; para uno guardado, /omi-work resume.");
		return this.state;
	}
	async restore(ctx: ExtensionContext, adopt = false): Promise<void> {
		await this.mutations; this.epoch++;
		this.context = ctx; this.state = undefined; this.lockedReason = ""; this.lastAnchor = undefined; this.reads.clear();
		const entry = ctx.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === DEVELOPMENT_ANCHOR);
		if (!entry && !adopt) { this.emit(); return; }
		try {
			const anchor = entry?.type === "custom" ? entry.data : undefined;
			if (anchor !== undefined && !Value.Check(AnchorSchema, anchor)) throw new Error("Vínculo del harness inválido; no se reinicia automáticamente");
			if (Value.Check(AnchorSchema, anchor) && anchor.disabled && !adopt) { this.emit(); return; }
			if (Value.Check(AnchorSchema, anchor)) this.lastAnchor = { id: anchor.id, root: anchor.root, issue: anchor.issue, revision: anchor.revision };
			this.checkContext(ctx);
			const checkout = await this.checkout(ctx);
			const prepared = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd)!;
			const saved = await readWorkflow(checkout, prepared.issue.number);
			if (!saved) throw new Error("Falta el estado guardado del harness. Recuperalo antes de continuar; no se recreó nada.");
			if (Value.Check(AnchorSchema, anchor) && (anchor.id !== saved.id || resolve(anchor.root) !== checkout.root || anchor.issue !== saved.source.number)) throw new Error("El vínculo corresponde a otro trabajo");
			this.state = saved;
			if (!adopt && Value.Check(AnchorSchema, anchor) && anchor.revision !== saved.revision) throw new Error("El trabajo avanzó en otra rama de conversación o ventana. Usá /omi-work resume para adoptar el estado vigente.");
			await inspectCheckout(checkout, this.runner, this.lifecycle.signal);
			if (adopt) this.anchor();
		} catch (error) {
			this.lockedReason = error instanceof Error ? error.message : "No se pudo restaurar el harness";
			ctx.ui.notify(this.lockedReason, "warning");
		}
		this.emit();
	}
	// El arranque ya pasó por development-begin (el sí, o arranque: auto): acá no se vuelve a preguntar.
	async start(ctx: ExtensionContext): Promise<void> {
		this.context = ctx; this.checkContext(ctx);
		if (this.offline) throw new Error("Iniciar requiere leer el issue vigente en GitHub; quitá --offline o PI_OFFLINE. Retomar lo guardado no requiere red.");
		const checkout = await this.checkout(ctx); const prepared = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd)!;
		const existing = await readWorkflow(checkout, prepared.issue.number);
		if (existing) { await this.restore(ctx, true); this.current(ctx); await this.fresh(ctx); return; }
		const snapshot = await inspectCheckout(checkout, this.runner, this.lifecycle.signal);
		if (!snapshot.clean) throw new Error("Iniciá el harness con el worktree limpio; no se adoptan cambios ajenos a la receta");
		const source = await readIssueSource(checkout, prepared.issue.number, this.runner, this.lifecycle.signal);
		if (source.url.replace(/\/$/, "") !== prepared.issue.url.replace(/\/$/, "")) throw new Error("GitHub devolvió otro issue/repositorio");
		// El pedido se cita en el PR draft: si no entra, nunca se podrá publicar.
		try { renderWorkflowArtifact(createWorkflow(source, checkout, "preview", this.now())); }
		catch { throw new Error("El pedido es demasiado grande para citarlo en el PR draft de GitHub; acotá el issue antes de iniciar"); }
		this.state = await updateWorkflow(checkout, source.number, undefined, () => createWorkflow(source, checkout, randomUUID(), this.now()));
		this.anchor(); this.emit();
	}
	async apply(event: WorkflowEvent, ctx: ExtensionContext): Promise<Workflow> {
		return this.serialize(async () => {
			const expected = this.current(ctx);
			this.state = await updateWorkflow(expected.checkout, expected.source.number, expected.revision, (saved) => {
				if (!saved || saved.id !== expected.id) throw new Error("El trabajo cambió o desapareció");
				return transition(saved, event, this.now());
			});
			if (event.type === "source_changed") this.epoch++;
			this.anchor(); this.emit(); return this.state;
		});
	}
	/** Reducer del host (lifecycle) sobre el estado vigente en disco; la revisión avanza una vez. */
	async update(ctx: ExtensionContext, change: (saved: WorkflowV2) => WorkflowV2): Promise<WorkflowV2> {
		return this.serialize(async () => {
			const expected = this.current(ctx);
			const saved = await readWorkflow(expected.checkout, expected.source.number);
			if (!saved || saved.id !== expected.id) throw new Error("El trabajo cambió o desapareció");
			const next = await updateWorkflow(expected.checkout, expected.source.number, saved.revision, (current) => {
				if (!current || current.id !== expected.id) throw new Error("El trabajo cambió o desapareció");
				return { ...change(parseWorkflow(JSON.stringify(current))), revision: current.revision + 1 };
			});
			this.state = parseWorkflow(JSON.stringify(next)); this.anchor(); this.emit(); return this.state;
		});
	}
	/** Adopta lo que escribió el coordinador raíz (performLifecycleOperation) sin ejecutar nada. */
	async reload(ctx: ExtensionContext): Promise<void> {
		await this.serialize(async () => {
			const expected = this.current(ctx); const saved = await readWorkflow(expected.checkout, expected.source.number);
			if (!saved || saved.id !== expected.id) throw new Error("El trabajo cambió o desapareció");
			this.state = saved; this.anchor(); this.emit();
		});
	}
	async fresh(ctx: ExtensionContext): Promise<boolean> {
		const state = this.current(ctx);
		if (this.offline) throw new Error("Esta acción necesita contrastar el issue vigente con GitHub; quitá --offline");
		const source = await readIssueSource(state.checkout, state.source.number, this.runner, this.lifecycle.signal);
		if (source.url !== state.source.url) throw new Error("Cambió la identidad del issue; no se reutiliza el trabajo");
		if (source.hash === state.source.hash) return true;
		await this.apply({ type: "source_changed", source }, ctx); this.reads.clear();
		ctx.ui.notify("El pedido cambió. Receta, aprobaciones y verificaciones se invalidaron; vuelve a Explorar.", "warning"); return false;
	}
	/** Una acción pendiente pertenece a la sesión que la inició, no sólo a la revisión durable. */
	continuationGuard(ctx: ExtensionContext): () => void {
		const origin = this.observationOrigin(), signal = this.lifecycle.signal;
		return () => {
			signal.throwIfAborted(); ctx.signal?.throwIfAborted();
			const current = this.observationOrigin();
			if (!origin || current?.epoch !== origin.epoch || current.id !== origin.id) throw new Error("La sesión cambió; se descartó la acción pendiente.");
			this.checkContext(ctx);
		};
	}
	async confirm(ctx: ExtensionContext, title: string, description: string): Promise<boolean> {
		this.checkContext(ctx);
		if (!ctx.hasUI) throw new Error(`${title}: requiere confirmación humana interactiva`);
		this.emit(`Esperando confirmación · ${title}`, true);
		const epoch = this.epoch;
		const signal = AbortSignal.any([this.lifecycle.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		try {
			const approved = await ctx.ui.confirm(title, description, { signal });
			signal.throwIfAborted();
			if (this.epoch !== epoch) throw new Error("La sesión cambió durante la confirmación; no se ejecutó la acción pendiente.");
			this.checkContext(ctx);
			return approved;
		} finally { this.emit(); }
	}
	/** Un selector no autoriza nada por sí mismo; cada caller interpreta sólo sus opciones explícitas. */
	async select(ctx: ExtensionContext, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
		this.checkContext(ctx);
		if (!ctx.hasUI) throw new Error("Autorizar comando del proyecto: requiere confirmación humana interactiva");
		const cancellation = AbortSignal.any([signal, this.lifecycle.signal]);
		cancellation.throwIfAborted();
		this.emit("Esperando autorización de comando", true);
		try {
			const choice = await showCommandChoices(ctx, title, options, cancellation);
			cancellation.throwIfAborted();
			return choice;
		} finally { this.emit(); }
	}
	/** Evita usar una decisión desde una ventana vieja, también si no se escribe un grant en el trabajo. */
	async assertUnchanged(expected: Workflow, ctx: ExtensionContext): Promise<void> {
		await this.mutations;
		this.lifecycle.signal.throwIfAborted();
		const current = this.current(ctx);
		const saved = await readWorkflow(expected.checkout, expected.source.number);
		const same = (value: Workflow | undefined) => value?.id === expected.id && value.revision === expected.revision && value.source.hash === expected.source.hash && value.status === expected.status && value.phase === expected.phase && recipeApprovalHash(value) === recipeApprovalHash(expected);
		if (!same(current) || !same(saved)) throw new Error("El trabajo cambió durante la autorización; retomá su estado vigente antes de continuar.");
	}
	// true sólo si la persona aprobó: un no no vuelve a disparar al modelo.
	async approve(ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
		if (!(await this.fresh(ctx))) return false;
		const state = this.current(ctx);
		if (state.phase !== "approve") throw new Error("Todavía no hay una receta/spec lista para aprobar");
		const assertExplored = async () => {
			const snapshot = await inspectCheckout(state.checkout, this.runner, this.lifecycle.signal);
			if (!state.exploration?.fingerprint || snapshot.fingerprint !== state.exploration.fingerprint) throw new Error("El código cambió desde Explorar. Usá /omi-work refresh y volvé a explorar antes de aprobar.");
		};
		await assertExplored();
		const document = approvalDocument(state);
		// receta: auto aprueba sin la revisión humana y sin UI; se revalida igual y sus D quedan autorizados.
		const foundations = await this.foundations.policy(ctx, state); const auto = foundations.politica.receta === "auto";
		if (!auto && (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode))) throw new Error("Aprobar receta: requiere confirmación humana interactiva");
		const cancellation = AbortSignal.any([this.lifecycle.signal, ...((signal ?? ctx.signal) ? [signal ?? ctx.signal!] : [])]);
		this.emit(auto ? "Foundations · receta auto" : "Esperando revisión de receta", !auto);
		let approved: boolean;
		try {
			approved = auto || await this.reviewed(ctx, document, cancellation);
		} finally { this.emit(); }
		if (!approved || cancellation.aborted) return false;
		// Una revisión larga no puede autorizar una receta distinta ni un estado adoptado por otra ventana.
		const saved = await readWorkflow(state.checkout, state.source.number);
		if (!saved || saved.id !== state.id || saved.revision !== state.revision || recipeApprovalHash(saved) !== recipeApprovalHash(state)) throw new Error("El trabajo cambió durante la revisión; retomá el estado vigente y revisá la receta otra vez.");
		if (!(await this.fresh(ctx))) return false;
		await assertExplored();
		cancellation.throwIfAborted();
		await this.apply({ type: "approved", ...(auto ? { by: "foundations" as const, ...(foundations.hash ? { foundations: foundations.hash } : {}) } : {}) }, ctx);
		// También con receta: auto la sección del issue muestra la receta aprobada.
		await updateIssueSection(this, ctx);
		if (auto) ctx.ui.notify("Foundations · receta auto: la receta se aprobó sin revisión humana. Sus comandos siguen Foundations: sin configurar corren sin preguntar; configurado, las reglas que coinciden y los comandos compuestos piden sí, salvo grant humano exacto vigente.", "info");
		return true;
	}
	// Volver a explorar descarta receta, aprobación y pruebas; también las lecturas y comandos autorizados.
	async refresh(ctx: ExtensionContext): Promise<void> {
		if (await this.fresh(ctx)) await this.apply({ type: "source_changed", source: this.current(ctx).source }, ctx);
		this.reads.clear();
	}
	async publish(ctx: ExtensionContext): Promise<void> {
		if (!(await this.fresh(ctx))) return;
		let state = this.current(ctx);
		// Un PR adoptado por el lifecycle no se republica: la corrección va al mismo PR con /omi-work fix y su propio sí.
		if (state.version === 2 && state.pullRequest?.ownership === "adopted") throw new Error("El PR ya es del lifecycle: la corrección se publica en el mismo PR con /omi-work fix, con su propio permiso.");
		if (state.phase !== "pr") throw new Error("Primero completá todos los pasos y la verificación del cambio actual");
		const snapshot = await inspectCheckout(state.checkout, this.runner, this.lifecycle.signal);
		if (!snapshot.clean) throw new Error("El worktree cambió después de verificar. Volvé a Implementar/Verificar.");
		// Revalidar evidencia con el fingerprint actual, también al recuperar una publicación pendiente.
		transition({ ...state, phase: "verify", publication: { status: "none" } }, { type: "verified", fingerprint: snapshot.fingerprint }, this.now());
		// El cuerpo exacto que se publica (en un stack, el del PR que cierra); falla antes del sí si no entra en GitHub. Un recibo pendiente de otro
		// cuerpo (por ejemplo, del formato anterior) nunca se publica: se renueva con este, según push_pr.
		const head = state.publication.status === "pending" ? state.publication.head : snapshot.head;
		const proposal = pullRequestBody(state, head);
		const replaces = state.publication.status === "pending" && state.publication.bodyHash !== proposal.bodyHash ? state.publication.bodyHash : undefined;
		const summary = publicationSummary(state, publishTargets(state, head), replaces !== undefined);
		if ((await this.foundations.policy(ctx, state)).politica.push_pr === "auto") ctx.ui.notify(`Foundations · push + PR draft auto: sin preguntar.\n${summary}`, "info");
		else if (!(await this.reviewPublication(ctx, publicationDocument(summary, proposal.body)))) return;
		// Una revisión larga no autoriza un trabajo que avanzó en otra ventana.
		const saved = await readWorkflow(state.checkout, state.source.number);
		if (!saved || saved.id !== state.id || saved.revision !== state.revision) throw new Error("El trabajo cambió durante la revisión del PR; retomá el estado vigente y volvé a publicar.");
		if (state.publication.status === "none" || replaces) state = await this.apply({ type: "publishing", head, bodyHash: proposal.bodyHash, ...(replaces ? { replaces } : {}) }, ctx);
		const receipt = await publishWork(state, this.runner, this.lifecycle.signal);
		await this.apply({ type: "published", ...receipt }, ctx);
		await updateIssueSection(this, ctx);
		await this.continuity.publication(ctx);
	}
	// Revisión íntegra de un documento: navegable en la TUI, el texto entero en RPC. Volver, cerrar o cancelar no aprueban.
	private async reviewed(ctx: ExtensionContext, document: ApprovalDocument, cancellation: AbortSignal): Promise<boolean> {
		const approved = ctx.mode === "tui" ? await showApprovalReview(ctx, document, cancellation) : await ctx.ui.confirm(document.title, approvalText(document), { signal: cancellation }) === true;
		return approved && !cancellation.aborted;
	}
	private async reviewPublication(ctx: ExtensionContext, document: ApprovalDocument): Promise<boolean> {
		this.checkContext(ctx);
		if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) throw new Error(`${PUBLICATION_TITLE}: requiere confirmación humana interactiva`);
		const cancellation = AbortSignal.any([this.lifecycle.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		this.emit(`Esperando revisión · ${PUBLICATION_TITLE}`, true);
		try { return await this.reviewed(ctx, document, cancellation); } finally { this.emit(); }
	}
	async answer(id: string, ctx: ExtensionContext): Promise<boolean> {
		const state = this.current(ctx); const inference = state.inferences.find((i) => i.id === id && i.resolution === "pending");
		if (!inference) throw new Error("No existe esa pregunta pendiente");
		if (!ctx.hasUI) throw new Error("Desambiguar requiere una respuesta humana interactiva");
		this.emit(`Esperando respuesta · ${id} · ${inference.question}`, true);
		let answer: string | undefined;
		try { answer = await ctx.ui.input(`${id} · ${inference.question}`, `Recomendada: ${inference.recommended}`, { signal: this.lifecycle.signal }); }
		finally { this.emit(); }
		if (!answer?.trim()) return false;
		if (answer.trim().length > 4000) throw new Error("La respuesta supera 4.000 caracteres; resumila y volvé a responder");
		await this.apply({ type: "answered", id, answer: answer.trim() }, ctx); return true;
	}
	async stop(ctx: ExtensionContext): Promise<void> {
		if (this.lockedReason) { await this.leaveLocked(ctx); return; }
		const s = this.current(ctx);
		if (!(await this.confirm(ctx, "Salir del harness", "Se pausa el trabajo y el chat vuelve a sus tools normales. No borra archivos ni revierte acciones. Para continuar el flujo usá /omi-work resume."))) return;
		// Salir no depende de que el estado admita otra transición: un trabajo pausado o inválido también se deja.
		if (s.status !== "complete" && s.status !== "paused") {
			try { await this.apply({ type: "pause", reason: "La persona salió del harness" }, ctx); }
			catch (error) { ctx.ui.notify(`No se pudo pausar el estado guardado (${error instanceof Error ? error.message : "error"}); se sale igual del harness.`, "warning"); }
		}
		this.pi.appendEntry(DEVELOPMENT_ANCHOR, { id: s.id, root: s.checkout.root, issue: s.source.number, revision: this.state!.revision, disabled: true });
		this.state = undefined; this.lockedReason = ""; this.emit();
	}
	// Un harness bloqueado (estado inválido, atrasado o ajeno) no se toca: sólo se deja de usar en esta conversación.
	private async leaveLocked(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) throw new Error("Salir del harness: requiere confirmación humana interactiva");
		if (!(await ctx.ui.confirm("Salir del harness bloqueado", `${this.lockedReason}\n\nEl chat vuelve a sus tools normales. No se modifica el estado guardado ni se borran archivos; recuperarlo queda a tu cargo.`, { signal: this.lifecycle.signal }))) return;
		if (this.lastAnchor && this.alive) this.pi.appendEntry(DEVELOPMENT_ANCHOR, { ...this.lastAnchor, disabled: true });
		this.state = undefined; this.lockedReason = ""; this.emit();
	}
	shutdown(): void { this.alive = false; this.epoch++; this.lifecycle.abort(); }
	status(): string { return this.lockedReason || (this.state ? [`${PHASE_LABELS[this.state.phase]} · ${this.state.status}`, this.state.activity, this.state.blockedReason, ...lifecycleLines(this.state), "Detalle: /omi-progress"].filter(Boolean).join("\n") : "Sin harness activo. Pedí un cambio en el chat o elegí un issue en Issues. /omi-work resume | approve | pause | refresh | pr | stop"); }
}
