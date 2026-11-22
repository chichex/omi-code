// /omi-work fix: correcciones post-PR en el mismo PR. La persona valida el grupo de hallazgos; el agente corrige
// con TDD y todos los D; el push al mismo PR pide su propio sí. Nunca otro PR, force ni push a la base.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowV2 } from "../harness/model.ts";
import { recipeApprovalHash } from "../harness/state.ts";
import { inspectCheckout } from "../harness/git.ts";
import { currentCorrection } from "../harness/execution-scope.ts";
import { disposeLifecycleFinding, reserveLifecycleOperation, type EnabledLifecycle } from "../harness/lifecycle-state.ts";
import { preparePostPrCorrection, activatePostPrCorrection, verifyPostPrCorrection } from "../harness/lifecycle-corrections.ts";
import { pushPostPrCorrection, acceptCorrectionPush } from "../harness/correction-push.ts";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { currentSubject, decide, enabledWork, githubClient, LifecycleDeclined, newIntent } from "./development-lifecycle.ts";

const pending = (s: EnabledLifecycle) => s.ledger.filter(f => {
	const o = f.observations.at(-1), d = f.dispositions.at(-1);
	return !(d && o && d.subjectId === s.currentSubject && d.observationHash === o.hash && d.observationSequence === f.observations.length && ["corrected", "refuted-with-evidence"].includes(d.status));
});
async function ancestor(session: DevelopmentSession, state: WorkflowV2, older: string, newer: string): Promise<boolean> {
	const result = await session.runner.run("git", ["-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", older, newer], { cwd: state.checkout.root, signal: session.lifecycle.signal });
	return result.code === 0;
}
/** Hallazgos ya corregidos y verificados en el HEAD actual que otra Review volvió a observar: los confirma la persona. */
async function confirmCorrected(session: DevelopmentSession, ctx: ExtensionContext, s: EnabledLifecycle, found: EnabledLifecycle["ledger"]): Promise<boolean> {
	const verification = s.evidence.findLast(e => e.subjectId === s.currentSubject && e.kind === "verification" && e.outcome === "pass");
	const carried = found.filter(f => f.observations.at(-1)?.subjectId === s.currentSubject && f.dispositions.some(d => d.status === "corrected"));
	if (!verification || !carried.length) return false;
	const list = carried.map(f => `· ${f.id}: ${f.observations.at(-1)?.text.slice(0, 200) ?? ""}`).join("\n");
	if (!(await session.confirm(ctx, `Ya corregidos: ${carried.length} hallazgo(s)`, `Se corrigieron y verificaron con todos los D en el HEAD actual (${verification.id}); otra Review los volvió a observar.\n${list}\n\nConfirmarlos no gasta otra ronda ni hace push.`))) throw new LifecycleDeclined("No se confirmó nada.");
	await session.update(ctx, saved => {
		if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		let lifecycle = saved.lifecycle;
		for (const f of carried) lifecycle = disposeLifecycleFinding(lifecycle, { findingId: f.id, subjectId: s.currentSubject, observationHash: f.observations.at(-1)!.hash, status: "corrected", evidenceIds: [verification.id], reason: "Corregido y verificado en el HEAD actual; confirmado por la persona", at: session.now() });
		return { ...saved, lifecycle };
	});
	return true;
}
/** Agrupa los hallazgos del HEAD actual, reserva una ronda y abre un paso C nuevo para el agente. */
async function startRound(session: DevelopmentSession, ctx: ExtensionContext, state: WorkflowV2, s: EnabledLifecycle, found: EnabledLifecycle["ledger"]): Promise<void> {
	const current = found.filter(f => f.observations.at(-1)?.subjectId === s.currentSubject);
	if (current.length !== found.length) throw new Error("Hay hallazgos de un HEAD anterior: corré /omi-work review sobre el HEAD actual antes de corregir.");
	const config = currentLifecyclePin(s).accepted.block, subject = currentSubject(s);
	if (s.budget.roundsUsed >= config.corrections.maxRounds) throw new Error(`Se agotaron las rondas de corrección (${s.budget.roundsUsed}/${config.corrections.maxRounds}): decide una persona.`);
	const intent = newIntent(s, "correction");
	const list = current.map(f => `· ${f.id} (${f.observations.at(-1)?.severity}): ${f.observations.at(-1)?.text.slice(0, 300) ?? ""}`).join("\n");
	// Validar el alcance es siempre humano (correcciones auto no lo reemplaza): el sí cubre el grupo y la ronda.
	const decision = await decide(session, ctx, intent, s, `Corregir ${current.length} hallazgo(s) en el PR #${subject.number}`, `${list}\n\nDentro del alcance aprobado y de riesgo ${state.recipe?.classification.risk ?? "?"}. Ronda ${s.budget.roundsUsed + 1}/${config.corrections.maxRounds} · intentos ${s.budget.attemptsUsed + 1}/${config.budget.maxAttempts}. El agente corrige con rojo, verde, commit y todos los D; el push al mismo PR pide otro sí.`, { mode: "ask" });
	await session.update(ctx, saved => {
		if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		let lifecycle = saved.lifecycle; const at = session.now();
		for (const f of current) lifecycle = disposeLifecycleFinding(lifecycle, { findingId: f.id, subjectId: subject.id, observationHash: f.observations.at(-1)!.hash, status: "accepted", evidenceIds: [], reason: "Validado por la persona para corregir en el mismo PR", at });
		let next = preparePostPrCorrection({ ...saved, lifecycle }, { operationId: intent.id, findingIds: current.map(f => f.id), scope: { source: "person", scopeHash: recipeApprovalHash(saved), withinScope: true, risk: saved.recipe?.classification.risk ?? "unknown" }, at });
		if (next.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
		next = { ...next, lifecycle: reserveLifecycleOperation(next.lifecycle, intent, decision, session.owner, at) };
		return activatePostPrCorrection(next, intent.id, at);
	});
}
async function push(session: DevelopmentSession, ctx: ExtensionContext): Promise<void> {
	const { state, s } = enabledWork(session, ctx), subject = currentSubject(s), client = githubClient(session, state), signal = session.lifecycle.signal;
	const round = s.corrections?.findLast(r => r.status === "verified"); if (!round || round.status !== "verified") throw new Error("No hay una corrección verificada para publicar");
	const intent = newIntent(s, "push");
	const decision = await decide(session, ctx, intent, s, `Push de la corrección al PR #${subject.number}`, `${subject.branch}: ${round.startHead.slice(0, 12)} → ${subject.headSha.slice(0, 12)} · push normal al mismo PR, sin force ni PR nuevo. Después hace falta otra Review del HEAD nuevo.`, { mode: "ask" });
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
/** true si quedó una ronda activa para el agente (el host la continúa con el turno). */
export async function fixLifecycle(session: DevelopmentSession, ctx: ExtensionContext): Promise<boolean> {
	const { state, s } = enabledWork(session, ctx); const round = currentCorrection(state);
	if (round?.status === "coding") {
		if (state.phase !== "pr") throw new Error("La corrección sigue en curso: el agente termina el paso con rojo, verde, commit y verified; después /omi-work fix verifica y pide el push.");
		const snap = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal), subject = currentSubject(s);
		const input = { id: `pr:${subject.number}:${snap.head}`, repo: subject.repo, number: subject.number, branch: subject.branch, base: subject.base, headSha: snap.head, baseSha: subject.baseSha, contentHash: snap.fingerprint, mergedSha: null };
		const observedGit = { clean: snap.clean, ancestor: await ancestor(session, state, round.startHead, snap.head) };
		await session.update(ctx, saved => verifyPostPrCorrection(saved, round.operationId, input, observedGit, session.now()));
		await push(session, ctx); return false;
	}
	if (round?.status === "verified") { await push(session, ctx); return false; }
	if (round) throw new Error(`Ronda de corrección ${round.status} sin reserva vigente: reconciliar antes de otra.`);
	if (s.stage !== "review") throw new Error(`Las correcciones parten de Review; ahora: ${s.stage}.`);
	const found = pending(s);
	if (!found.length) { ctx.ui.notify("No hay hallazgos pendientes para corregir.", "info"); return false; }
	if (await confirmCorrected(session, ctx, s, found)) {
		const after = enabledWork(session, ctx).s, left = pending(after);
		ctx.ui.notify(left.length ? `Quedan ${left.length} hallazgo(s): /omi-work fix para corregirlos.` : `Sin hallazgos pendientes.\n${session.status()}`, "info"); return false;
	}
	await startRound(session, ctx, state, s, found);
	ctx.ui.notify(`Ronda de corrección autorizada: el agente sigue con el paso nuevo.\n${session.status()}`, "info");
	return true;
}
