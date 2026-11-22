// /omi-work ship: verifica la entrega del merge observado en cada destino aceptado, con recibos y provenance.
// Fallo, ausencia o desconocido nunca son éxito; la recuperación (stop/rollback/fix-forward) la decide una persona.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowV2 } from "../harness/model.ts";
import { reserveLifecycleOperation, type EnabledLifecycle } from "../harness/lifecycle-state.ts";
import { currentLifecyclePin } from "../harness/lifecycle-budget.ts";
import { recordShipVerification, completeShip } from "../harness/ship-state.ts";
import type { ShipVerification } from "../harness/ship-schema.ts";
import type { LifecycleTarget } from "../harness/lifecycle-config.ts";
import { createGhaShipPorts } from "../harness/gha-ship-io.ts";
import { verifyGhaRelease, observeGhaShipReceipt, dispatchGhaShip } from "../harness/lifecycle-gha-ship.ts";
import { verifyOmiShip } from "../harness/lifecycle-omi-ship.ts";
import { tuiGuard } from "../guardrails/surfaces.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { currentSubject, decide, enabledWork, githubClient, newIntent, OWN_REPO } from "./development-lifecycle.ts";

const SHIP_TIMEOUT_SECONDS = 1800;
const OUTCOMES = { verified: "Entrega verificada en todos los destinos aplicables.", "externally-attested": "Entrega atestiguada por una persona; el origen no quedó demostrado.", "not-applicable": "Ship no aplica: el lifecycle terminó sin entrega que verificar.", "manual-attested": "Entrega declarada a mano por una persona; OMI no la verificó." } as const;
function pendingTargets(s: EnabledLifecycle, targets: LifecycleTarget[]): LifecycleTarget[] {
	return targets.filter(t => !s.deliveries?.some(d => d.targetId === t.id && d.subjectId === s.currentSubject && d.configHash === s.pinHash && ["verified", "not-applicable"].includes(d.result.state)));
}
function describe(target: LifecycleTarget): string {
	const p = target.provider;
	return p.kind === "gha" ? `${p.mode === "dispatch" ? "Dispara" : "Observa"} ${p.workflow}@${p.ref} · evidencia ${target.evidence.kind}` : `OMI ${p.service}/${p.environment} · ${p.mode} · health/version y origen del commit`;
}
async function verify(session: DevelopmentSession, ctx: ExtensionContext, reserved: WorkflowV2, operationId: string, target: LifecycleTarget): Promise<ShipVerification> {
	const signal = session.lifecycle.signal, store = { checkout: reserved.checkout, issue: reserved.source.number, operationId };
	if (target.provider.kind === "gha") {
		const ports = session.lifecyclePorts.ghaShip?.(reserved, operationId) ?? createGhaShipPorts(reserved, operationId, { client: githubClient(session, reserved), signal, ...(session.githubRunner ? { runner: session.githubRunner } : {}), beforeDispatch: async () => {}, workflowStore: store });
		if (target.evidence.kind === "github-release") return verifyGhaRelease(reserved, operationId, ports);
		return target.provider.mode === "dispatch" ? dispatchGhaShip(reserved, operationId, ports) : observeGhaShipReceipt(reserved, operationId, ports);
	}
	const version = (await ctx.ui.input(`Versión OMI desplegada en ${target.provider.service}/${target.provider.environment}`, "por ejemplo 1.1.0", { signal }))?.trim();
	if (!version) return { state: "unknown", proof: null, reason: "Sin versión a verificar: no se consultó OMI" };
	const omi = session.lifecyclePorts.omi?.(ctx);
	const runtime = omi?.runtime ?? { io: { ...session.io, cwd: reserved.checkout.root }, runner: session.runner, guard: tuiGuard({ stageAuthorized: false }, ctx.hasUI ? ctx.ui : undefined), signal };
	return verifyOmiShip(reserved, operationId, { runtime, version, signal, timeoutSeconds: target.timeoutSeconds, now: () => performance.now(), ...(omi?.fetch ? { fetch: omi.fetch } : {}),
		beforeMutation: async () => { throw new Error("Ship observe no muta OMI"); }, workflowStore: store });
}
export async function shipLifecycle(session: DevelopmentSession, ctx: ExtensionContext): Promise<void> {
	const { s } = enabledWork(session, ctx); const config = currentLifecyclePin(s).accepted.block, subject = currentSubject(s);
	if (s.stage !== "ship" || !subject.mergedSha) throw new Error(s.completion ? `Ship ya terminó: ${OUTCOMES[s.completion.outcome]}` : "Ship espera el merge observado: /omi-work land.");
	const ship = config.ship;
	if (ship.status === "unconfigured") throw new Error("Ship sin configurar: el merge está hecho pero la entrega no se verifica. Configuralo con omi init --development.");
	if (ship.status === "manual") {
		const description = `Merge ${subject.mergedSha.slice(0, 12)} del PR #${subject.number}. Declarás que el cambio está entregado; OMI no lo verifica y queda como entrega manual.`;
		if (!(await session.confirm(ctx, "Declarar la entrega manual", description))) { ctx.ui.notify("No se declaró nada.", "info"); return; }
		await session.update(ctx, saved => completeShip(saved, session.now(), { source: "person", subjectId: subject.id, integratedSha: subject.mergedSha, configHash: s.pinHash, reason: "Declarada por la persona con /omi-work ship", at: session.now() }));
	} else if (ship.status === "configured") {
		for (const target of pendingTargets(s, ship.targets)) {
			const provider = target.provider;
			if (provider.kind === "omi" && provider.mode !== "observe") throw new Error(`Ship OMI ${provider.mode} (publicar/desplegar) no está conectado: desplegá con omi y verificá con un destino observe.`);
			const now = enabledWork(session, ctx).s, intent = newIntent(now, "ship", target.id);
			const human = provider.kind === "gha" && provider.mode === "dispatch" && now.root.repo === OWN_REPO;
			const decision = await decide(session, ctx, intent, now, `Ship ${target.id}`, `${describe(target)}\nMerge ${subject.mergedSha.slice(0, 12)} · intento ${now.budget.attemptsUsed + 1}/${config.budget.maxAttempts}. Sin recibo y provenance no hay entrega.`, { mode: target.mode, human });
			const reserved = await session.update(ctx, saved => {
				if (saved.lifecycle.status !== "enabled") throw new Error("lifecycle deshabilitado");
				return { ...saved, lifecycle: reserveLifecycleOperation(saved.lifecycle, intent, decision, session.owner, session.now()) };
			});
			session.emit(`Ship ${target.id}: verificando`);
			let result: ShipVerification;
			try { result = await verify(session, ctx, reserved, intent.id, { ...target, timeoutSeconds: Math.min(target.timeoutSeconds, SHIP_TIMEOUT_SECONDS) }); }
			catch { result = { state: "unknown", proof: null, reason: "Verificación Ship interrumpida; observar sin repetir" }; }
			await session.update(ctx, saved => recordShipVerification(saved, intent.id, result, session.now()));
			if (result.state !== "verified" && result.state !== "not-applicable") {
				ctx.ui.notify(`Ship ${target.id}: ${result.state}. ${result.reason}\nEl merge sigue hecho y la entrega no está verificada. Stop, rollback o fix-forward los decide una persona; no se repite solo.\n${session.status()}`, "warning"); return;
			}
		}
		await session.update(ctx, saved => completeShip(saved, session.now()));
	} else await session.update(ctx, saved => completeShip(saved, session.now()));
	const done = enabledWork(session, ctx).s;
	ctx.ui.notify(`${done.completion ? OUTCOMES[done.completion.outcome] : "Ship sin resultado"}\n${session.status()}`, "info");
}
