// /omi-work fix: correcciones post-PR en el mismo PR. La persona valida el grupo de hallazgos; el agente corrige
// con TDD y todos los D; el push al mismo PR pide su propio sí. Nunca otro PR, force ni push a la base.
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowV2 } from "../harness/model.ts";
import { recipeApprovalHash } from "../harness/state.ts";
import { fixedReviewMaterial } from "../harness/review-material.ts";
import { createLocalReviewCall } from "./development-local-review.ts";
import { assessCorrectionScope, correctionScopeMatches, type CorrectionScopeAssessment } from "./development-correction-scope.ts";
import { inspectCheckout } from "../harness/git.ts";
import { currentCorrection } from "../harness/execution-scope.ts";
import { disposeLifecycleFinding, reserveLifecycleOperation, type EnabledLifecycle } from "../harness/lifecycle-state.ts";
import { preparePostPrCorrection, activatePostPrCorrection, verifyPostPrCorrection } from "../harness/lifecycle-corrections.ts";
import { pushPostPrCorrection, acceptCorrectionPush } from "../harness/correction-push.ts";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { currentSubject, decide, enabledWork, githubClient, LifecycleDeclined, newIntent } from "./development-lifecycle.ts";
import type { ChainConsent } from "./development-lifecycle-chain.ts";

const pending = (s: EnabledLifecycle) => s.ledger.filter(f => {
	const o = f.observations.at(-1), d = f.dispositions.at(-1);
	return !(d && o && d.subjectId === s.currentSubject && d.observationHash === o.hash && d.observationSequence === f.observations.length && ["corrected", "refuted-with-evidence"].includes(d.status));
});
async function ancestor(session: DevelopmentSession, state: WorkflowV2, older: string, newer: string): Promise<boolean> {
	const result = await session.runner.run("git", ["-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", older, newer], { cwd: state.checkout.root, signal: session.lifecycle.signal });
	return result.code === 0;
}
/** Hallazgos ya corregidos y verificados en el HEAD actual que otra Review volvió a observar: los confirma la persona. */
async function confirmCorrected(session: DevelopmentSession, ctx: ExtensionContext, s: EnabledLifecycle, found: EnabledLifecycle["ledger"], chain: ChainConsent | undefined): Promise<boolean> {
	const verification = s.evidence.findLast(e => e.subjectId === s.currentSubject && e.kind === "verification" && e.outcome === "pass");
	const carried = found.filter(f => f.observations.at(-1)?.subjectId === s.currentSubject && f.dispositions.some(d => d.status === "corrected"));
	if (!verification || !carried.length) return false;
	const list = carried.map(f => `· ${f.id}: ${f.observations.at(-1)?.text.slice(0, 200) ?? ""}`).join("\n");
	const title = `Ya corregidos: ${carried.length} hallazgo(s)`, description = `Se corrigieron y verificaron con todos los D en el HEAD actual (${verification.id}); otra Review los volvió a observar.\n${list}\n\nConfirmarlos no gasta otra ronda ni hace push.`;
	if (!(await (chain ? chain.confirmEffect(title, description) : session.confirm(ctx, title, description)))) throw new LifecycleDeclined("No se confirmó nada.");
	await session.update(ctx, saved => {
		if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		let lifecycle = saved.lifecycle;
		for (const f of carried) lifecycle = disposeLifecycleFinding(lifecycle, { findingId: f.id, subjectId: s.currentSubject, observationHash: f.observations.at(-1)!.hash, status: "corrected", evidenceIds: [verification.id], reason: "Corregido y verificado en el HEAD actual; confirmado por la persona", at: session.now() });
		return { ...saved, lifecycle };
	});
	return true;
}
/** Agrupa los hallazgos del HEAD actual, reserva una ronda y abre un paso C nuevo para el agente. */
async function startRound(session: DevelopmentSession, ctx: ExtensionContext, state: WorkflowV2, s: EnabledLifecycle, found: EnabledLifecycle["ledger"], source: "manual" | "chain", chain: ChainConsent | undefined): Promise<void> {
	const origin = session.observationOrigin();
	const assertCurrent = () => {
		session.lifecycle.signal.throwIfAborted(); ctx.signal?.throwIfAborted();
		const now = session.observationOrigin();
		if (!origin || now?.epoch !== origin.epoch || now.id !== origin.id) throw new Error("La sesión cambió durante la evaluación; no se habilitó código.");
	};
	const current = found.filter(f => f.observations.at(-1)?.subjectId === s.currentSubject);
	if (current.length !== found.length) throw new Error("Hay hallazgos de un HEAD anterior: corré /omi-work review sobre el HEAD actual antes de corregir.");
	const config = currentLifecyclePin(s).accepted.block, subject = currentSubject(s);
	if (s.budget.roundsUsed >= config.corrections.maxRounds) throw new Error(`Se agotaron las rondas de corrección (${s.budget.roundsUsed}/${config.corrections.maxRounds}): decide una persona.`);
	const intent = newIntent(s, "correction");
	const list = current.map(f => `· ${f.id} (${f.observations.at(-1)?.severity}): ${f.observations.at(-1)?.text.slice(0, 300) ?? ""}`).join("\n");
	const automatic = source === "chain" && !!config.continuity && config.corrections.mode === "auto";
	let assessment: CorrectionScopeAssessment | undefined;
	if (automatic) {
		assessment = await assessLifecycleCorrectionScope(session, ctx);
		assertCurrent();
		if (assessment.status !== "safe") throw new Error(assessment.reason);
		await session.assertUnchanged(state, ctx);
	}
	const authorization = await decide(session, ctx, intent, s, `Corregir ${current.length} hallazgo(s) en el PR #${subject.number}`, `${list}\n\nRonda ${s.budget.roundsUsed + 1}/${config.corrections.maxRounds} · intentos ${s.budget.attemptsUsed + 1}/${config.budget.maxAttempts}. El agente corrige con rojo, verde, commit y todos los D; el push conserva su permiso independiente.`, { mode: automatic ? "auto" : "ask", chain });
	const decision = assessment?.status === "safe" ? { ...authorization, authorityHash: assessment.authorityHash } : authorization;
	assertCurrent();
	await session.update(ctx, saved => {
		assertCurrent();
		if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		if (automatic && (!assessment || !correctionScopeMatches(saved, assessment))) throw new Error("Cambió receta/pin/sujeto/grupo después de evaluar el alcance; requiere nueva evaluación explícita.");
		let lifecycle = saved.lifecycle; const at = session.now();
		for (const f of current) lifecycle = disposeLifecycleFinding(lifecycle, { findingId: f.id, subjectId: subject.id, observationHash: f.observations.at(-1)!.hash, status: "accepted", evidenceIds: [], reason: automatic ? "Evaluador aislado acreditó alcance aprobado y riesgo bajo del grupo actual" : "Validado por la persona para corregir en el mismo PR", at });
		const scope = assessment?.status === "safe" ? { source: "policy", scopeHash: assessment.scopeHash, authorityHash: assessment.authorityHash, withinScope: true, risk: "low" }
			: { source: "person", scopeHash: recipeApprovalHash(saved), withinScope: true, risk: saved.recipe?.classification.risk ?? "unknown" };
		let next = preparePostPrCorrection({ ...saved, lifecycle }, { operationId: intent.id, findingIds: current.map(f => f.id), scope, at });
		if (next.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		next = { ...next, lifecycle: reserveLifecycleOperation(next.lifecycle, intent, decision, session.owner, at) };
		return activatePostPrCorrection(next, intent.id, at);
	});
}
async function push(session: DevelopmentSession, ctx: ExtensionContext, chain: ChainConsent | undefined): Promise<void> {
	const { state, s } = enabledWork(session, ctx), subject = currentSubject(s), client = githubClient(session, state), signal = session.lifecycle.signal;
	const round = s.corrections?.findLast(r => r.status === "verified"); if (!round || round.status !== "verified") throw new Error("No hay una corrección verificada para publicar");
	const intent = newIntent(s, "push");
	// Continuidad no concede push. Consultar Foundations por separado y ligar la decisión a su autoridad.
	// Sin opt-in se conserva el permiso humano del flujo previo.
	const foundations = await session.foundations.policy(ctx, state);
	const mode = currentLifecyclePin(s).accepted.block.continuity ? foundations.politica.push_pr : "ask";
	const authorization = await decide(session, ctx, intent, s, `Push de la corrección al PR #${subject.number}`, `${subject.branch}: ${round.startHead.slice(0, 12)} → ${subject.headSha.slice(0, 12)} · push normal al mismo PR, sin force ni PR nuevo. Después hace falta otra Review del HEAD nuevo.`, { mode, chain });
	const decision = authorization.source === "policy" ? { ...authorization,
		authorityHash: foundations.hash ?? createHash("sha256").update(JSON.stringify({ authority: "foundations-default", repo: s.root.repo, policy: foundations.politica })).digest("hex"),
	} : authorization;
	const reserved = await session.update(ctx, saved => {
		if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		return { ...saved, lifecycle: reserveLifecycleOperation(saved.lifecycle, intent, decision, session.owner, session.now()) };
	});
	const snapshot = async () => { const snap = await inspectCheckout(state.checkout, session.runner, signal); return { head: snap.head, fingerprint: snap.fingerprint, branch: snap.branch, clean: snap.clean, ancestor: await ancestor(session, state, round.startHead, snap.head) }; };
	const result = await pushPostPrCorrection(reserved, intent.id, { ...(session.githubRunner ? { runner: session.githubRunner } : {}), signal, beforePush: async () => {},
		repository: abort => client.json(`repos/${client.repo}`, abort), currentPr: abort => client.json(`repos/${client.repo}/pulls/${subject.number}`, abort), snapshot,
		workflowStore: { checkout: state.checkout, issue: state.source.number, operationId: intent.id } });
	await session.reload(ctx);
	if (result.status !== "confirmed") throw new Error(`${result.reason}. No se repite el push.`);
	const observed = await client.json(`repos/${client.repo}/pulls/${subject.number}`, signal);
	await session.update(ctx, saved => acceptCorrectionPush(saved, intent.id, observed, session.now()));
	ctx.ui.notify(`Push al mismo PR confirmado. Corré /omi-work review sobre el HEAD nuevo.\n${session.status()}`, "info");
}
/** Usa sólo el modelo seleccionado y un diff fijo; sin tools/settings/conversación del implementador. */
export async function assessLifecycleCorrectionScope(session: DevelopmentSession, ctx: ExtensionContext): Promise<CorrectionScopeAssessment> {
	const { state, s } = enabledWork(session, ctx), subject = currentSubject(s), model = ctx.model;
	if (!model) return { status: "paused", reason: "Alcance automático: falta modelo seleccionado compatible; requiere persona." };
	try {
		return await assessCorrectionScope(state, { model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
			signal: AbortSignal.any([session.lifecycle.signal, ...(ctx.signal ? [ctx.signal] : [])]), timeoutSeconds: currentLifecyclePin(s).accepted.block.review.timeoutSeconds,
			snapshot: async signal => { const snap = await inspectCheckout(state.checkout, session.runner, signal); return { head: snap.head, fingerprint: snap.fingerprint, clean: snap.clean }; },
			material: signal => fixedReviewMaterial(state.checkout.root, { repo: subject.repo, pr: subject.number, headSha: subject.headSha, baseSha: subject.baseSha, correlationId: `scope:${s.pinHash}` }, signal),
			call: createLocalReviewCall(ctx.modelRegistry, model),
		});
	} catch { return { status: "paused", reason: "Evaluación aislada de alcance falló/cancelada; requiere persona. No se habilitó código." }; }
}
/** Verifica la corrección terminada en PR (o toma la ya verificada) y la publica en el mismo PR. No abre rondas. */
export async function pushLifecycleCorrection(session: DevelopmentSession, ctx: ExtensionContext, chain?: ChainConsent): Promise<void> {
	const { state, s } = enabledWork(session, ctx); const round = currentCorrection(state);
	if (round?.status === "coding" && state.phase === "pr") {
		const snap = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal), subject = currentSubject(s);
		const input = { id: `pr:${subject.number}:${snap.head}`, repo: subject.repo, number: subject.number, branch: subject.branch, base: subject.base, headSha: snap.head, baseSha: subject.baseSha, contentHash: snap.fingerprint, mergedSha: null };
		const observedGit = { clean: snap.clean, ancestor: await ancestor(session, state, round.startHead, snap.head) };
		await session.update(ctx, saved => verifyPostPrCorrection(saved, round.operationId, input, observedGit, session.now()));
	} else if (round?.status !== "verified") throw new Error("No hay una corrección verificada para publicar");
	await push(session, ctx, chain);
}
/** true si quedó una ronda activa para el agente (el host la continúa con el turno). */
export async function fixLifecycle(session: DevelopmentSession, ctx: ExtensionContext, options: { source: "manual" | "chain"; chain?: ChainConsent | undefined } = { source: "manual" }): Promise<boolean> {
	const { state, s } = enabledWork(session, ctx); const round = currentCorrection(state);
	if (round?.status === "coding" && state.phase !== "pr") throw new Error("La corrección sigue en curso: el agente termina el paso con rojo, verde, commit y verified; después /omi-work fix verifica y pide el push.");
	if (round?.status === "coding" || round?.status === "verified") { await pushLifecycleCorrection(session, ctx, options.chain); return false; }
	if (round) throw new Error(`Ronda de corrección ${round.status} sin reserva vigente: reconciliar antes de otra.`);
	if (s.stage !== "review") throw new Error(`Las correcciones parten de Review; ahora: ${s.stage}.`);
	const found = pending(s);
	if (!found.length) { ctx.ui.notify("No hay hallazgos pendientes para corregir.", "info"); return false; }
	// Auto no transforma hallazgos repetidos en un permiso humano implícito ni abre un diálogo de disposición.
	const automatic = options.source === "chain" && !!currentLifecyclePin(s).accepted.block.continuity && currentLifecyclePin(s).accepted.block.corrections.mode === "auto";
	if (!automatic && await confirmCorrected(session, ctx, s, found, options.chain)) {
		const after = enabledWork(session, ctx), left = pending(after.s), { maxRounds } = currentLifecyclePin(after.s).accepted.block.corrections;
		// En la cadena, confirmar ya es progreso: los que quedan siguen en una ronda, con el mismo sí de continuidad y el
		// propio de «Corregir». Sin rondas, vuelve al selector, que pausa por rondas.
		if (options.source === "chain" && left.length && after.s.budget.roundsUsed < maxRounds) {
			await startRound(session, ctx, after.state, after.s, left, "chain", options.chain);
			ctx.ui.notify(`Ronda de corrección autorizada para los ${left.length} hallazgo(s) que quedan: el agente sigue con el paso nuevo.\n${session.status()}`, "info");
			return true;
		}
		ctx.ui.notify(!left.length ? `Sin hallazgos pendientes.\n${session.status()}` : after.s.budget.roundsUsed < maxRounds ? `Quedan ${left.length} hallazgo(s): /omi-work fix para corregirlos.`
			: `Quedan ${left.length} hallazgo(s) y se agotaron las rondas de corrección (${after.s.budget.roundsUsed}/${maxRounds}): decide una persona.`, "info");
		return false;
	}
	await startRound(session, ctx, state, s, found, options.source, options.chain);
	ctx.ui.notify(`Ronda de corrección autorizada: el agente sigue con el paso nuevo.\n${session.status()}`, "info");
	return true;
}
