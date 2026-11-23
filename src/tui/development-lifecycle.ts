// Host del lifecycle post-PR: comandos humanos /omi-work adopt | review | fix | land | ship sobre el mismo trabajo.
// Cada efecto remoto pasa por una decisión (ask pregunta; auto avisa) y por las funciones de src/harness.
// El modelo no tiene tools para esto: ni bash ni omi_workflow pueden reservar, mergear, despachar ni desplegar.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { issueRepository, type WorkflowV2 } from "../harness/model.ts";
import { recipeApprovalHash } from "../harness/state.ts";
import { inspectCheckout } from "../harness/git.ts";
import { evaluateLifecycle, lifecycleDiff, readLifecycle, type LifecycleEvaluation } from "../harness/lifecycle-kb.ts";
import { lifecycleTrustDir, readLifecycleTrust, type LifecycleKey } from "../harness/lifecycle-trust.ts";
import { GitHubReadClient } from "../harness/lifecycle-github-read.ts";
import { PullSchema, githubChecked } from "../harness/lifecycle-github-schema.ts";
import { readGitHubReview } from "../harness/lifecycle-github-review.ts";
import { readGitHubLand } from "../harness/lifecycle-github-land.ts";
import { adoptPostPrWorkflow } from "../harness/lifecycle-corrections.ts";
import { applyLifecyclePin, type EnabledLifecycle, type LifecycleDecision, type LifecycleIntent } from "../harness/lifecycle-state.ts";
import type { LifecyclePin, OperationKind } from "../harness/lifecycle-state-schema.ts";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import { subjectIdentity } from "../harness/lifecycle-invariants.ts";
import { performLifecycleOperation, type LifecycleActivityControls } from "../harness/lifecycle-operations.ts";
import { recordLifecycleReview, type ReviewFacts } from "../harness/lifecycle-review-facts.ts";
import { reviewLocalChange } from "../harness/lifecycle-local-review.ts";
import { resolveGhaReviewRequest, createGhaReviewPorts } from "../harness/gha-review-io.ts";
import { startGhaReview } from "../harness/lifecycle-gha-review.ts";
import { landReadiness, prepareLand, landPullRequest, acceptObservedMerge } from "../harness/lifecycle-land.ts";
import { markDraftReady } from "../harness/draft-ready.ts";
import { lifecycleBlocks } from "../harness/lifecycle-progress.ts";
import { stackUnsupportedText } from "../harness/continuity-pause-text.ts";
import type { GhaShipDeps } from "../harness/ship-context.ts";
import type { ToolRuntime } from "../tools/types.ts";
import { createLocalReviewCall } from "./development-local-review.ts";
import { HARNESS_KB_URL } from "./defaults.ts";
import type { DevelopmentSession } from "./development-session.ts";
import type { ChainConsent } from "./development-lifecycle-chain.ts";

/** Puertos de prueba. Sin ellos se usan los transportes acotados de src/harness. */
export interface LifecyclePorts {
	monotonic?: () => number;
	ghaShip?: (state: WorkflowV2, operationId: string) => GhaShipDeps;
	omi?: (ctx: ExtensionContext) => { runtime: ToolRuntime; fetch?: typeof fetch };
}
/** En este repo merge y dispatch son siempre de una persona: ninguna perilla auto los concede. */
export const OWN_REPO = "chichex/omi-code";
export const LIFECYCLE_COMMANDS = ["adopt", "review", "fix", "land", "ship"] as const;
/** Un no de la persona: se informa, no es un error ni deja efectos. */
export class LifecycleDeclined extends Error {}

export function lifecycleRepo(state: WorkflowV2): string { return issueRepository(state.source.url, state.source.number).toLowerCase(); }
export function githubClient(session: DevelopmentSession, state: WorkflowV2): GitHubReadClient {
	return new GitHubReadClient({ repo: lifecycleRepo(state), cwd: state.checkout.root, ...(session.githubRunner ? { runner: session.githubRunner } : {}) });
}
export async function readPull(client: GitHubReadClient, number: number, signal: AbortSignal) {
	return githubChecked(PullSchema, await client.json(`repos/${client.repo}/pulls/${number}`, signal));
}
export function enabledWork(session: DevelopmentSession, ctx: ExtensionContext): { state: WorkflowV2; s: EnabledLifecycle } {
	const state = session.current(ctx);
	if (state.version !== 2 || state.lifecycle.status !== "enabled") throw new Error("El lifecycle no está habilitado en este trabajo. Con el PR draft abierto, /omi-work adopt.");
	if (session.offline) throw new Error("El lifecycle necesita leer GitHub; quitá --offline o PI_OFFLINE.");
	return { state, s: state.lifecycle };
}
export function currentSubject(s: EnabledLifecycle) {
	const subject = s.subjects.find(x => x.id === s.currentSubject); if (!subject) throw new Error("Falta el sujeto adoptado del PR"); return subject;
}
// En la TUI, lo que falta configurar o aceptar se resuelve con /omi-setup; la terminal queda para lo que el setup no corre.
const UNREADY: Record<Exclude<LifecycleEvaluation["status"], "accepted">, string> = {
	missing: "sin configurar para {repo}: configuralo con /omi-setup",
	pending: "con cambios sin aceptar para {repo}: aceptalo con /omi-setup",
	unavailable: "no disponible para {repo}: revisá el login de la KB en /mcp o la red",
	invalid: "inválido para {repo}: revisá el bloque lifecycle de las perillas en la KB o corré omi init --development en una terminal",
};
/** La configuración aceptada vigente (KB + aceptación local). Pendiente, ausente o caída nunca inicia efectos. */
export async function acceptedPin(session: DevelopmentSession, state: WorkflowV2): Promise<LifecyclePin> {
	const repo = lifecycleRepo(state);
	const key: LifecycleKey = { kbUrl: session.kb?.url ?? HARNESS_KB_URL, product: repo.split("/")[1] ?? "", repo };
	const reading = await readLifecycle(session.kb, key, state.checkout.root, session.lifecycle.signal);
	const evaluation = evaluateLifecycle(reading, await readLifecycleTrust(lifecycleTrustDir(session.io.homeDir), key));
	if (!evaluation.canStartEffects || !evaluation.observationPin) {
		const status = evaluation.status === "accepted" ? "invalid" : evaluation.status;
		throw new Error(`Lifecycle ${UNREADY[status].replace("{repo}", repo)}. No se inició ningún efecto.`);
	}
	return { key, accepted: evaluation.observationPin };
}
/** Fija la revisión aceptada vigente antes de un efecto; cambiar de KB/repo no se acepta. */
export async function freshPin(session: DevelopmentSession, ctx: ExtensionContext): Promise<void> {
	const validate = session.continuationGuard(ctx);
	const { state, s } = enabledWork(session, ctx); const pin = await acceptedPin(session, state);
	validate();
	if (pin.accepted.blockHash === s.pinHash) return;
	await session.update(ctx, saved => { validate(); return { ...saved, lifecycle: applyLifecyclePin(saved.lifecycle, pin) }; });
	ctx.ui.notify("Lifecycle: se fijó la revisión aceptada vigente de la configuración.", "info");
}
/** Retry sólo de un efecto confirmado como fallido; pendiente o incierto lo rechaza la reserva (reconciliar). */
function retryOf(s: EnabledLifecycle, kind: OperationKind, targetId: string | null): string | null {
	const subject = currentSubject(s), key = JSON.stringify(kind === "land" ? [kind, subject.repo, subject.number] : [kind, subjectIdentity(subject), targetId]);
	const previous = s.operations.findLast(o => { const sub = s.subjects.find(x => x.id === o.subjectId); return !!sub && JSON.stringify(o.kind === "land" ? [o.kind, sub.repo, sub.number] : [o.kind, subjectIdentity(sub), o.targetId]) === key; });
	return previous?.status === "confirmed" && previous.receipt.outcome === "failed" ? previous.id : null;
}
export function newIntent(s: EnabledLifecycle, kind: OperationKind, targetId: string | null = null): LifecycleIntent {
	const id = randomUUID(); return { id: `${kind}:${id}`, key: `${kind}:${id}`, kind, subjectId: currentSubject(s).id, targetId, correlationId: id, retryOf: retryOf(s, kind, targetId) };
}
/** `chain`: el sí de continuidad ask pendiente de la etapa. Lo resuelve este diálogo si pregunta; si no, se pregunta aparte. */
export interface DecideOptions { mode: "ask" | "auto" | undefined; human?: boolean; effectHash?: string; activity?: LifecycleActivityControls; chain?: ChainConsent | undefined }
/** ask (o un efecto que siempre es humano) pregunta; auto sólo avisa. Esperar a la persona no gasta tiempo activo. */
export async function decide(session: DevelopmentSession, ctx: ExtensionContext, intent: LifecycleIntent, s: EnabledLifecycle, title: string, description: string, options: DecideOptions): Promise<LifecycleDecision> {
	const human = options.human === true || options.mode !== "auto", chain = options.chain;
	if (human || chain?.pending) {
		await options.activity?.setMode("human-wait");
		let approved = true;
		try {
			if (human) approved = chain ? await chain.confirmEffect(title, description) : await session.confirm(ctx, title, description);
			// El efecto no pregunta: la continuidad pendiente se pide sola y no se vuelve permiso del efecto.
			else await chain?.ensure();
		} finally { await options.activity?.setMode("active"); }
		if (!approved) throw new LifecycleDeclined(`${title}: no. No se ejecutó nada.`);
	}
	if (!human) ctx.ui.notify(`Lifecycle · ${intent.kind} auto: ${title}, sin preguntar.`, "info");
	return { id: `decision:${randomUUID()}`, kind: intent.kind, subjectId: intent.subjectId, targetId: intent.targetId, configHash: s.pinHash, source: human ? "person" : "policy", ...(options.effectHash ? { effectHash: options.effectHash } : {}), at: session.now() };
}
/** Actividad → decisión → reserva → una invocación → recibo, por el coordinador raíz. El estado vuelve siempre a la sesión. */
export async function operate(session: DevelopmentSession, ctx: ExtensionContext, intent: LifecycleIntent,
	authorize: (activity: LifecycleActivityControls) => Promise<LifecycleDecision>, execute: (reserved: WorkflowV2) => Promise<unknown>): Promise<void> {
	const state = session.current(ctx), validate = session.continuationGuard(ctx);
	try {
		validate();
		await performLifecycleOperation({ checkout: state.checkout, issue: state.source.number, owner: session.owner, now: session.now, monotonic: session.lifecyclePorts.monotonic ?? (() => performance.now()), signal: AbortSignal.any([session.lifecycle.signal, ...(ctx.signal ? [ctx.signal] : [])]),
			authorize: async (_state, _intent, activity) => { validate(); const decision = await authorize(activity); validate(); return decision; }, execute: (reserved) => { validate(); return execute(reserved); } }, intent);
	} finally { await session.reload(ctx); }
}
export const receipt = (intent: LifecycleIntent, externalId: string, at: string, outcome: "succeeded" | "failed" = "succeeded") =>
	({ operationId: intent.id, correlationId: intent.correlationId, subjectId: intent.subjectId, targetId: intent.targetId, externalId: externalId.slice(0, 256), outcome, verifiedSubjectId: intent.subjectId, at });

/** Qué sigue al habilitar a mano: con continuity.review auto o ask, la cadena sigue con Review después del sí. */
function afterManualAdopt(review: "auto" | "ask" | "manual" | undefined): string {
	if (review === "auto") return "Al habilitar, la continuidad sigue sola con Review (continuity.review: auto). ";
	if (review === "ask") return "Al habilitar, la continuidad pregunta antes de seguir con Review (continuity.review: ask). ";
	return "Habilitar no ejecuta nada ahora. ";
}
/** `consent`: entrada ask. Su único sí es el de la adopción, con lo que se fija, y va antes de leer GitHub. */
export async function adoptLifecycle(session: DevelopmentSession, ctx: ExtensionContext, publication?: { head: string; number: number; revision: number; pinHash: string }, consent?: ChainConsent): Promise<boolean> {
	const state = session.current(ctx); const signal = session.lifecycle.signal;
	const origin = session.observationOrigin();
	if (state.version !== 2) throw new Error("Estado del harness sin migrar; retomalo con /omi-work resume.");
	if (state.lifecycle.status === "enabled") { ctx.ui.notify(session.status(), "info"); return false; }
	if (state.phase !== "done" || state.publication.status !== "opened" || state.pullRequest?.ownership !== "unadopted") throw new Error("Adoptar requiere el PR draft que abrió este trabajo (etapa «PR draft abierto»).");
	if (state.publication.stack) throw new Error(stackUnsupportedText(state.publication.stack.length));
	if (session.offline) throw new Error("Adoptar necesita leer el PR en GitHub; quitá --offline.");
	const pin = await acceptedPin(session, state), client = githubClient(session, state), pr = state.pullRequest;
	if (publication && publication.pinHash !== pin.accepted.blockHash) throw new Error("La configuración de entrada cambió; hay que revisar su continuidad antes de adoptar.");
	// PR, rama, base y HEAD del trabajo: la lectura de GitHub de abajo exige los mismos antes de adoptar.
	const title = `Habilitar Review, Land y Ship en el PR #${pr.number}`;
	const description = [`PR #${pr.number} · ${state.checkout.branch} → ${pr.base} · HEAD ${pr.head.slice(0, 12)}`, "", "Configuración aceptada:", lifecycleDiff(undefined, pin.accepted.block, pin.key), "",
		`${consent ? "" : afterManualAdopt(pin.accepted.block.continuity?.review)}Review, correcciones, push, merge y Ship piden su propio permiso según esta configuración (ask pregunta antes). En chichex/omi-code merge y dispatch son siempre humanos.`].join("\n");
	if (consent?.pending) {
		if (!(await consent.confirmEffect(title, description))) throw new LifecycleDeclined(`${title}: no. No se habilitó nada.`);
		// El sí vale para la configuración mostrada: si cambió mientras esperaba, no se adopta con otra.
		if ((await acceptedPin(session, state)).accepted.blockHash !== pin.accepted.blockHash) throw new Error("La configuración de entrada cambió mientras esperaba el sí; no se adopta.");
		await session.assertUnchanged(state, ctx);
	}
	const pull = await readPull(client, pr.number, signal), snapshot = await inspectCheckout(state.checkout, session.runner, signal);
	if (pull.state !== "open" || pull.merged || pull.number !== pr.number || pull.head.sha !== pr.head || pull.head.ref !== state.checkout.branch || pull.base.ref !== pr.base || pull.base.repo.full_name.toLowerCase() !== client.repo || pull.head.repo?.full_name.toLowerCase() !== client.repo)
		throw new Error(`El PR #${pr.number} cambió (HEAD, rama, base o estado) desde que se abrió; no se adopta.`);
	if (!snapshot.clean || snapshot.head !== pull.head.sha) throw new Error("El checkout no está limpio o no coincide con el HEAD del PR; no se adopta.");
	signal.throwIfAborted(); ctx.signal?.throwIfAborted();
	if (session.observationOrigin()?.epoch !== origin?.epoch) throw new Error("La sesión cambió mientras se comprobaba el draft; no se adopta.");
	const subject = { id: `pr:${pr.number}:${pull.head.sha}`, repo: client.repo, number: pr.number, branch: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha, baseSha: pull.base.sha, contentHash: snapshot.fingerprint, mergedSha: null };
	if (!publication && !(await session.confirm(ctx, title, description))) { ctx.ui.notify("No se habilitó nada.", "info"); return false; }
	await session.update(ctx, saved => adoptPostPrWorkflow(saved, pin, subject, { id: `adopt:${randomUUID()}`, source: publication ? "publication" : "person", at: session.now() }, publication));
	ctx.ui.notify(`${session.status()}\nSeguí con /omi-work review.`, "info");
	return true;
}

async function reviewFacts(session: DevelopmentSession, ctx: ExtensionContext, reserved: WorkflowV2, intent: Pick<LifecycleIntent, "id">): Promise<{ externalId: string; facts: Omit<ReviewFacts, "operationId" | "at"> }> {
	const s = reserved.lifecycle; if (s.status !== "enabled") throw new Error("lifecycle deshabilitado");
	const config = currentLifecyclePin(s).accepted.block, provider = config.review.provider, subject = currentSubject(s), signal = session.lifecycle.signal, client = githubClient(session, reserved);
	const store = { checkout: reserved.checkout, issue: reserved.source.number, operationId: intent.id };
	if (provider.kind === "github") {
		const observed = await readGitHubReview(client, { repo: subject.repo, number: subject.number, headSha: subject.headSha, baseSha: subject.baseSha, branch: subject.branch, base: subject.base, contentHash: subject.contentHash }, provider.reviewers, config.land.requiredChecks, signal);
		if (!observed.complete) throw new Error(observed.problems.join("; ") || "Review GitHub incompleta");
		return { externalId: `github:${subject.number}:${subject.headSha}`, facts: { provider: "github",
			findings: observed.findings.map(f => ({ externalId: f.externalId, text: f.body, severity: "unknown", resolved: f.resolved === true, outdated: f.outdated })),
			checks: observed.checks.map(c => ({ context: c.context, appId: c.appId, state: c.state, externalId: `${c.source}:${c.id}` })),
			approval: observed.approval === "unknown" ? null : { reviewer: provider.reviewers.join(","), state: observed.approval, externalId: `github:${subject.number}:${subject.headSha}` } } };
	}
	if (provider.kind === "local") {
		const model = ctx.model; if (!model) throw new Error("Review local: elegí un modelo autenticado");
		const result = await reviewLocalChange(reserved, intent.id, { model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow }, timeoutSeconds: config.review.timeoutSeconds, signal, now: () => performance.now(), beforeReview: async () => {},
			snapshot: async (abort) => { const snap = await inspectCheckout(reserved.checkout, session.runner, abort); return { repo: subject.repo, pr: subject.number, headSha: snap.head, baseSha: subject.baseSha, contentHash: snap.fingerprint, clean: snap.clean }; },
			call: createLocalReviewCall(ctx.modelRegistry, model), workflowStore: store });
		if (result.status === "unknown" || !result.receipt) throw new Error(result.reason);
		const local = result.receipt;
		return { externalId: `local:${local.materialHash}`, facts: { provider: "local", checks: [], findings: local.findings.map(f => ({ externalId: f.id, text: f.message, severity: f.severity, resolved: false, outdated: false })),
			approval: { reviewer: `${model.provider}/${model.id}`, state: local.verdict === "pass" ? "approved" : "changes-requested", externalId: `local:${intent.id}` } } };
	}
	const request = await resolveGhaReviewRequest(reserved, intent.id, client, signal);
	const result = await startGhaReview(reserved, request, createGhaReviewPorts(request, { client, timeoutSeconds: config.review.timeoutSeconds, signal, ...(session.githubRunner ? { runner: session.githubRunner } : {}), beforeDispatch: async () => {}, workflowStore: store }));
	if (result.status === "unknown" || !result.receipt) throw new Error(result.reason);
	const gha = result.receipt;
	return { externalId: `run:${gha.runId}:${gha.runAttempt}`, facts: { provider: "gha", checks: [], findings: gha.findings.map(f => ({ externalId: f.id, text: f.message, severity: f.severity, resolved: false, outdated: false })),
		approval: { reviewer: request.workflow.path, state: gha.verdict === "pass" ? "approved" : "changes-requested", externalId: `run:${gha.runId}:${gha.runAttempt}` } } };
}
export interface ObservedLifecycleReview { operationId: string; subjectId: string }
export async function reviewLifecycle(session: DevelopmentSession, ctx: ExtensionContext, chain?: ChainConsent): Promise<ObservedLifecycleReview> {
	await freshPin(session, ctx);
	const { s } = enabledWork(session, ctx); const config = currentLifecyclePin(s).accepted.block, subject = currentSubject(s), provider = config.review.provider;
	if (s.stage !== "review") throw new Error(`Review corre en la etapa Review; ahora: ${s.stage}.`);
	// GitHub sólo se lee: con una Review ya confirmada de este HEAD, releer comentarios y checks no es otro efecto.
	const done = s.operations.findLast(o => o.kind === "review" && o.subjectId === subject.id && o.status === "confirmed" && o.receipt.outcome === "succeeded");
	if (provider.kind === "github" && done && done.status === "confirmed") {
		await chain?.ensure(); // Releer no pregunta: si la cadena llegó con ask pendiente, se pide antes de avanzar.
		const { state } = enabledWork(session, ctx);
		const { facts } = await reviewFacts(session, ctx, state, done);
		await session.update(ctx, saved => ({ ...saved, lifecycle: recordLifecycleReview(saved.lifecycle, { ...facts, operationId: done.id, at: session.now() }) }));
		ctx.ui.notify(`Relectura de GitHub del mismo HEAD: sin otro intento.\n${session.status()}`, "info"); return { operationId: done.id, subjectId: subject.id };
	}
	const intent = newIntent(s, "review"); let observed: Omit<ReviewFacts, "operationId" | "at"> | undefined;
	const dispatch = provider.kind === "gha";
	await operate(session, ctx, intent,
		activity => decide(session, ctx, intent, s, `Review del PR #${subject.number}`, `${provider.kind === "github" ? `Lee reviews, comentarios y checks de GitHub (${provider.reviewers.join(", ")})` : provider.kind === "local" ? `Revisor aislado con ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"} sobre el diff fijo` : `Dispara ${provider.workflow}@${provider.ref} (workflow_dispatch) y espera su recibo`} para HEAD ${subject.headSha.slice(0, 12)}. Consume 1 intento del presupuesto.`,
			{ mode: config.review.mode, human: dispatch && s.root.repo === OWN_REPO, activity, chain }),
		async reserved => { const result = await reviewFacts(session, ctx, reserved, intent); observed = result.facts; return receipt(intent, result.externalId, session.now()); });
	if (!observed) throw new Error("Review sin hechos observados");
	const facts = observed;
	const next = await session.update(ctx, saved => ({ ...saved, lifecycle: recordLifecycleReview(saved.lifecycle, { ...facts, operationId: intent.id, at: session.now() }) }));
	const blocks = lifecycleBlocks(next);
	ctx.ui.notify(`${session.status()}\n${blocks.length ? "Con hallazgos pendientes: /omi-work fix." : "Sin hallazgos pendientes: /omi-work land cuando checks y reviews estén listos."}`, blocks.length ? "warning" : "info");
	return { operationId: intent.id, subjectId: subject.id };
}

export async function landLifecycle(session: DevelopmentSession, ctx: ExtensionContext, chain?: ChainConsent): Promise<boolean> {
	await freshPin(session, ctx);
	let { state, s } = enabledWork(session, ctx); const config = currentLifecyclePin(s).accepted.block, signal = session.lifecycle.signal, client = githubClient(session, state);
	if (!["review", "ready", "land"].includes(s.stage)) throw new Error(s.merges?.length ? "El merge ya se observó: seguí con /omi-work ship." : `Land no corresponde en la etapa ${s.stage}.`);
	const subject = currentSubject(s);
	const pull = await readPull(client, subject.number, signal);
	if (pull.merged) {
		await chain?.ensure(); // Registrar un merge externo no pregunta, pero la cadena no pasa de Land sin el sí de continuidad.
		await session.update(ctx, saved => acceptObservedMerge(saved, pull, { source: "external", at: session.now() }));
		ctx.ui.notify(`Merge externo observado: Land hecho, la entrega todavía no está verificada. /omi-work ship.\n${session.status()}`, "info"); return true;
	}
	const blocks = lifecycleBlocks(state);
	if (blocks.length) throw new Error(`Land bloqueado por hallazgos u operaciones pendientes: ${blocks.join("; ")}. Usá /omi-work fix o /omi-work review.`);
	if (pull.draft) {
		const intent = newIntent(s, "ready");
		await operate(session, ctx, intent, activity => decide(session, ctx, intent, s, `Marcar el PR #${subject.number} listo para review`, "Sale de draft. No mergea ni autoriza el merge.", { mode: config.land.mode, activity, chain }),
			async reserved => {
				const result = await markDraftReady(reserved, intent.id, { ...(session.githubRunner ? { runner: session.githubRunner } : {}), signal, beforeReady: async () => {}, readPull: abort => client.json(`repos/${client.repo}/pulls/${subject.number}`, abort), workflowStore: { checkout: reserved.checkout, issue: reserved.source.number, operationId: intent.id } });
				if (result.status !== "ready") throw new Error(result.reason);
				return receipt(intent, `ready:${subject.number}:${subject.headSha}`, session.now());
			});
		({ state, s } = enabledWork(session, ctx));
	}
	const observed = await readGitHubLand(client, state, { signal, ...(session.githubRunner ? { runner: session.githubRunner } : {}) });
	if (observed.status !== "observed") throw new Error(observed.reason);
	const risk = { risk: state.recipe?.classification.risk ?? "unknown", source: state.approval?.by === "foundations" ? "policy" as const : "person" as const, scopeHash: recipeApprovalHash(state) };
	const readiness = landReadiness(state, observed.facts, risk);
	if (!readiness.ready) throw new Error(`Land no está listo: ${readiness.reasons.join("; ")}`);
	await session.update(ctx, saved => prepareLand(saved, observed.facts, risk, session.now()));
	({ state, s } = enabledWork(session, ctx));
	const intent = newIntent(s, "land"); let merged: unknown;
	const description = [...readiness.attention.flatMap(reason => [`${reason}.`, ""]), `${client.repo} PR #${subject.number} · ${config.land.method} · HEAD ${subject.headSha.slice(0, 12)} → ${subject.base}`, `Checks: ${observed.facts.checks.map(c => `${c.context} ${c.state}`).join(", ") || "ninguno"}`, `Reviews: ${observed.facts.reviews.map(r => `${r.user?.login ?? "?"} ${r.state}`).join(", ") || "ninguna"}`, "", "Mergear integra el cambio; no lo entrega. Ship se verifica después."].join("\n");
	try {
		await operate(session, ctx, intent, activity => decide(session, ctx, intent, s, `Mergear el PR #${subject.number}`, description, { mode: config.land.mode, human: !readiness.auto || s.root.repo === OWN_REPO, effectHash: readiness.hash, activity, chain }),
			async reserved => {
				const result = await landPullRequest(reserved, intent.id, { ...(session.githubRunner ? { runner: session.githubRunner } : {}), signal, beforeLand: async () => {},
					readFacts: async () => { const again = await readGitHubLand(client, reserved, { signal, ...(session.githubRunner ? { runner: session.githubRunner } : {}) }); return again.status === "observed" ? again.facts : undefined; },
					readPull: abort => client.json(`repos/${client.repo}/pulls/${subject.number}`, abort), workflowStore: { checkout: reserved.checkout, issue: reserved.source.number, operationId: intent.id } });
				if (result.status !== "merged") throw new Error(result.reason);
				merged = result.pull; return receipt(intent, `merge:${subject.number}:${subject.headSha}`, session.now());
			});
	} catch (error) { if (error instanceof LifecycleDeclined) { ctx.ui.notify(`${error.message} El PR quedó listo para merge (no es permiso).`, "info"); return false; } throw error; }
	await session.update(ctx, saved => acceptObservedMerge(saved, merged, { source: "operation", operationId: intent.id, at: session.now() }));
	ctx.ui.notify(`Merge confirmado por lectura del PR/SHA. Integrado, todavía no entregado: /omi-work ship.\n${session.status()}`, "info");
	return true;
}
