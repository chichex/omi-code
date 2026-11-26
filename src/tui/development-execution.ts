// Comandos observados y commits por paso. El modelo nunca aporta exit codes ni evidencias ya hechas.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInside } from "../core/files.ts";
import type { Evidence, EvidenceKind, Workflow } from "../harness/model.ts";
import { commandAuthorization } from "../harness/authorization.ts";
import { afterDraftCheckError } from "../harness/after-draft-guide.ts";
import { expectedFailure, isApproved, recipeApprovalHash, successful } from "../harness/state.ts";
import { inspectCheckout, assertStepCommit, type CheckoutSnapshot } from "../harness/git.ts";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS, runWorkflowCommand, type WorkflowCommandResult } from "../harness/commands.ts";
import { takeCheckTurn, type CheckTurn } from "../harness/check-queue.ts";
import { heavyCheck, lastCompleteMs, plannedTimeout, timeoutNote } from "../harness/check-timing.ts";
import { workflowWritePath } from "../harness/permissions.ts";
import { afterDraft, assertCorrectionHead, assertCorrectionExecution } from "../harness/execution-scope.ts";
import type { DevelopmentSession } from "./development-session.ts";
import { authorizeProjectCommand } from "./development-command-authorization.ts";

export interface CheckInput { kind: EvidenceKind | "setup"; command: string; stepId?: string; caseId?: string; timeoutSeconds?: number }
/** notes: lo que el host ajustó o vio al correrlo (turno de checks, timeout), para la salida de la tool. */
export type CheckObservation = ({ evidence: Evidence } | { setup: WorkflowCommandResult }) & { notes: string[] };
/** En qué etapa corre cada etiqueta. Setup no acredita nada: prepara el checkout en cualquier etapa activa hasta el PR
 * draft; después, sólo durante una corrección en curso. */
function assertCheckPhase(state: Workflow, kind: CheckInput["kind"]): void {
	assertCorrectionExecution(state);
	if (afterDraft(state)) throw new Error(afterDraftCheckError(state));
	if (state.status === "paused" || state.status === "complete") throw new Error("El trabajo no está activo");
	if (kind === "setup") return;
	// Resolver inferencias admite volver a registrar explored: también puede volver a reproducir.
	if (kind === "reproduction") {
		if (!["explore", "decide", "diagnose"].includes(state.phase)) throw new Error("La reproducción corresponde a Explorar, Resolver inferencias o Diagnóstico");
		return;
	}
	if (!isApproved(state)) throw new Error("Primero hace falta aprobar la receta vigente");
	if ((kind === "red" || kind === "green") && state.phase !== "implement") throw new Error("Ese comando corresponde a Implementar");
	if ((kind === "verification" || kind === "gate") && state.phase !== "verify") throw new Error("Ese comando corresponde a Verificar");
}
// El progreso dice a quién se espera, sólo cuando cambia; al terminar la espera, deja de esperar.
async function waitForCheckTurn(session: DevelopmentSession, state: Workflow, input: CheckInput, signal: AbortSignal): Promise<CheckTurn> {
	let shown = "";
	try {
		return await takeCheckTurn(state.checkout, { kind: input.kind, command: input.command }, signal, session.checkTurn, (owner) => {
			const activity = `Esperando turno de checks · ${owner}`;
			if (activity !== shown) { shown = activity; session.emit(activity, true); }
		});
	} finally { if (shown) session.emit(); }
}
export async function executeCheck(session: DevelopmentSession, input: CheckInput, ctx: ExtensionContext, signal: AbortSignal, run = runWorkflowCommand): Promise<CheckObservation> {
	signal = AbortSignal.any([signal, session.lifecycle.signal]);
	signal.throwIfAborted();
	const state = session.current(ctx);
	assertCheckPhase(state, input.kind);
	if (input.kind === "red" || input.kind === "green") {
		const step = state.steps.find((s) => s.id === input.stepId && s.status === "active");
		if (!step) throw new Error("Activá el paso C antes de registrar rojo/verde");
		const red = state.evidence.find((e) => e.id === step.red);
		if (input.kind === "green" && (!red || red.command !== input.command)) throw new Error("El verde debe ejecutar el mismo comando que el rojo observado");
	}
	if (input.kind === "verification" && !state.recipe?.cases.some((c) => c.id === input.caseId && c.command === input.command)) throw new Error("La verificación debe usar el caso D y comando exactos de la receta aprobada");
	// La etiqueta y la receta no dispensan confirmaciones: decidir por v2 aceptada, sintaxis y grant exacto.
	const authorized = commandAuthorization(state, input.command, (await session.foundations.policy(ctx, state)).command) === "ask"
		? await authorizeProjectCommand(session, ctx, { state, command: input.command, kind: input.kind, signal }) : state;
	const known = lastCompleteMs(state, input.command);
	const timeout = plannedTimeout(input.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS, known);
	const notes = timeout.note ? [timeout.note] : [];
	// Antes de la foto: una espera larga no invalida el fingerprint y startedAt cuenta desde que corre.
	const turn = heavyCheck(state, input.kind, input.command) ? await waitForCheckTurn(session, state, input, signal) : undefined;
	if (turn?.notice) notes.push(turn.notice);
	let before: CheckoutSnapshot; let startedAt: string; let result: WorkflowCommandResult;
	try {
		before = await inspectCheckout(state.checkout, session.runner, signal);
		assertCorrectionHead(state, before.head);
		await session.assertUnchanged(authorized, ctx);
		signal.throwIfAborted();
		startedAt = session.now(); session.emit(`${input.kind} · ${input.caseId ?? input.stepId ?? "comando"} · ${input.command}`);
		result = await run(state.checkout, input.command, signal, timeout.seconds);
	} finally { await turn?.release(); }
	if (result.timedOut) notes.push(timeoutNote(timeout.seconds, known));
	const after = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal);
	const current = session.current(ctx);
	if (current.id !== state.id || current.source.hash !== state.source.hash || recipeApprovalHash(current) !== recipeApprovalHash(state)) throw new Error("El pedido o la receta cambió durante el comando; su resultado no acredita este trabajo");
	if (input.kind === "setup") {
		session.emit();
		// Fuera de Implementar, un setup prepara lo que Git ignora (por ejemplo, node_modules). Es una detección con el
		// fingerprint, no un sandbox: un comando autorizado todavía puede esconderle cambios a Git.
		if (state.phase !== "implement" && (before.fingerprint !== after.fingerprint || before.head !== after.head)) throw new Error(`El setup cambió el checkout fuera de Implementar: modificó archivos versionados, no ignorados o HEAD. Setup no acredita nada y fuera de Implementar no debe escribir código; el cambio no se revirtió: revisalo con git status. Exit ${result.exitCode ?? "—"}.`);
		return { setup: result, notes };
	}
	const interrupted = result.interrupted || signal.aborted || result.exitCode === null || result.exitCode >= 128 || before.fingerprint !== after.fingerprint || before.head !== after.head;
	const evidence: Evidence = {
		id: randomUUID(), kind: input.kind, command: input.command, stepId: input.stepId ?? null, caseId: input.caseId ?? null,
		exitCode: result.exitCode, outcome: interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed",
		output: result.output.slice(-12000), fingerprint: after.fingerprint, head: after.head, startedAt, finishedAt: session.now(),
	};
	const invalidAttempt = input.kind === "red" && !expectedFailure(evidence) || input.kind === "green" && !successful(evidence) || input.kind === "reproduction" && !successful(evidence) && !expectedFailure(evidence);
	await session.apply({ type: invalidAttempt ? "check_failed" : "evidence", evidence }, ctx); return { evidence, notes };
}

export async function commitStep(session: DevelopmentSession, input: { stepId: string; message: string; paths: string[] }, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const state = session.current(ctx);
	assertCorrectionExecution(state);
	if (state.phase !== "implement" || state.status !== "active" || !isApproved(state)) throw new Error("No hay permiso de implementar la receta vigente");
	const step = state.steps.find((s) => s.id === input.stepId && s.status === "active");
	const green = state.evidence.find((e) => e.id === step?.green && e.kind === "green" && e.outcome === "passed" && e.exitCode === 0);
	if (!step || !green) throw new Error("El paso necesita rojo y verde observados antes del commit");
	assertCorrectionHead(state, green.head);
	if (!/^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert)(\([a-z0-9-]+\))?!?: .+/.test(input.message) || /[\r\n]/.test(input.message)) throw new Error("Usá un mensaje de commit convencional de una línea");
	let snapshot = await inspectCheckout(state.checkout, session.runner, signal);
	if (snapshot.fingerprint !== green.fingerprint) throw new Error("El contenido cambió después del verde; ejecutá el test otra vez");
	if (!snapshot.clean) {
		if (snapshot.head !== green.head) throw new Error("HEAD cambió desde la prueba; revisá el commit existente antes de continuar");
		if (!input.paths.length) throw new Error("Elegí paths explícitos para el commit del paso");
		const paths: string[] = [];
		for (const path of input.paths) {
			const absolute = workflowWritePath(state.checkout.root, path);
			let parent: string;
			try { parent = await realpath(absolute); } catch { parent = await realpath(dirname(absolute)); }
			if (!isInside(state.checkout.root, parent)) throw new Error("Un path del commit sale del checkout por un symlink");
			paths.push(relative(state.checkout.root, absolute));
		}
		// Paths literales: `:(top)` o un glob no pueden ampliar lo que se stagea.
		const git = async (args: string[]) => {
			const result = await session.runner.run("git", ["--literal-pathspecs", ...args], { cwd: state.checkout.root, signal });
			if (result.code !== 0) throw new Error(`git ${args[0]} falló: ${result.stderr.slice(-2000)}`);
			return result.stdout;
		};
		session.emit(`Commit de ${step.id}`);
		await git(["add", "--", ...paths]);
		const staged = (await git(["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
		try {
			for (const path of staged) workflowWritePath(state.checkout.root, path);
			if (staged.some((path) => !paths.some((selected) => path === selected || path.startsWith(`${selected}/`)))) throw new Error("Hay archivos staged fuera de los paths seleccionados; no se comitean a ciegas");
		} catch (error) {
			// Deshacer lo que stageó este intento: si no, el próximo commit válido vuelve a fallar.
			await git(["reset", "-q", "--", ...paths]).catch(() => {}); throw error;
		}
		await git(["commit", "-m", input.message]);
		snapshot = await inspectCheckout(state.checkout, session.runner, signal);
	}
	await assertStepCommit(state.checkout, green, snapshot.head, session.runner, signal);
	await session.apply({ type: "step_completed", id: step.id, commit: snapshot.head, fingerprint: snapshot.fingerprint }, ctx);
}
