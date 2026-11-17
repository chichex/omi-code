// Comandos observados y commits por paso. El modelo nunca aporta exit codes ni evidencias ya hechas.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInside } from "../core/files.ts";
import { artifactHash, type Evidence, type EvidenceKind } from "../harness/model.ts";
import { expectedFailure, isApproved, recipeApprovalHash, successful } from "../harness/state.ts";
import { inspectCheckout, assertStepCommit } from "../harness/git.ts";
import { runWorkflowCommand, type WorkflowCommandResult } from "../harness/commands.ts";
import { workflowWritePath } from "../harness/permissions.ts";
import type { DevelopmentSession } from "./development-session.ts";

export interface CheckInput { kind: EvidenceKind | "setup"; command: string; stepId?: string; caseId?: string; timeoutSeconds?: number }
export async function executeCheck(session: DevelopmentSession, input: CheckInput, ctx: ExtensionContext, signal: AbortSignal, run = runWorkflowCommand): Promise<Evidence | { setup: WorkflowCommandResult }> {
	const state = session.current(ctx);
	if (state.status === "paused" || state.status === "complete") throw new Error("El trabajo no está activo");
	if (input.kind === "reproduction") {
		if (!["explore", "diagnose"].includes(state.phase)) throw new Error("La reproducción corresponde a Explorar o Diagnóstico");
	} else {
		if (!isApproved(state)) throw new Error("Primero hace falta aprobar la receta vigente");
		if (["red", "green", "setup"].includes(input.kind) && state.phase !== "implement") throw new Error("Ese comando corresponde a Implementar");
		if (["verification", "gate"].includes(input.kind) && state.phase !== "verify") throw new Error("Ese comando corresponde a Verificar");
	}
	if (input.kind === "red" || input.kind === "green") {
		const step = state.steps.find((s) => s.id === input.stepId && s.status === "active");
		if (!step) throw new Error("Activá el paso C antes de registrar rojo/verde");
		const red = state.evidence.find((e) => e.id === step.red);
		if (input.kind === "green" && (!red || red.command !== input.command)) throw new Error("El verde debe ejecutar el mismo comando que el rojo observado");
	}
	if (input.kind === "verification" && !state.recipe?.cases.some((c) => c.id === input.caseId && c.command === input.command)) throw new Error("La verificación debe usar el caso D y comando exactos de la receta aprobada");
	const commandKey = artifactHash({ id: state.id, source: state.source.hash, approval: state.approval, command: input.command });
	const included = input.kind !== "reproduction" && input.kind !== "setup" && state.recipe?.cases.some((c) => c.command === input.command) && isApproved(state);
	if (!included && !session.approvedCommands.has(commandKey)) {
		if (!(await session.confirm(ctx, "Autorizar comando del proyecto", `${input.kind} · ${state.checkout.root}\n\n${input.command}\n\nEjecuta código del proyecto con permisos de tu usuario. No es una operación de sólo lectura ni un sandbox. No autoriza otros comandos.`))) throw new Error("Comando no autorizado; no se ejecutó");
		session.approvedCommands.add(commandKey);
	}
	const before = await inspectCheckout(state.checkout, session.runner, signal);
	const startedAt = session.now(); session.emit(`${input.kind} · ${input.caseId ?? input.stepId ?? "comando"} · ${input.command}`);
	const result = await run(state.checkout, input.command, signal, input.timeoutSeconds);
	const after = await inspectCheckout(state.checkout, session.runner, session.lifecycle.signal);
	const current = session.current(ctx);
	if (current.id !== state.id || current.source.hash !== state.source.hash || recipeApprovalHash(current) !== recipeApprovalHash(state)) throw new Error("El pedido o la receta cambió durante el comando; su resultado no acredita este trabajo");
	if (input.kind === "setup") { session.emit(); return { setup: result }; }
	const interrupted = result.interrupted || signal.aborted || result.exitCode === null || result.exitCode >= 128 || before.fingerprint !== after.fingerprint || before.head !== after.head;
	const evidence: Evidence = {
		id: randomUUID(), kind: input.kind, command: input.command, stepId: input.stepId ?? null, caseId: input.caseId ?? null,
		exitCode: result.exitCode, outcome: interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed",
		output: result.output.slice(-12000), fingerprint: after.fingerprint, head: after.head, startedAt, finishedAt: session.now(),
	};
	const invalidAttempt = input.kind === "red" && !expectedFailure(evidence) || input.kind === "green" && !successful(evidence) || input.kind === "reproduction" && !successful(evidence) && !expectedFailure(evidence);
	await session.apply({ type: invalidAttempt ? "check_failed" : "evidence", evidence }, ctx); return evidence;
}

export async function commitStep(session: DevelopmentSession, input: { stepId: string; message: string; paths: string[] }, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const state = session.current(ctx);
	if (state.phase !== "implement" || state.status !== "active" || !isApproved(state)) throw new Error("No hay permiso de implementar la receta vigente");
	const step = state.steps.find((s) => s.id === input.stepId && s.status === "active");
	const green = state.evidence.find((e) => e.id === step?.green && e.kind === "green" && e.outcome === "passed" && e.exitCode === 0);
	if (!step || !green) throw new Error("El paso necesita rojo y verde observados antes del commit");
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
		for (const path of staged) workflowWritePath(state.checkout.root, path);
		if (staged.some((path) => !paths.some((selected) => path === selected || path.startsWith(`${selected}/`)))) throw new Error("Hay archivos staged fuera de los paths seleccionados; no se comitean a ciegas");
		await git(["commit", "-m", input.message]);
		snapshot = await inspectCheckout(state.checkout, session.runner, signal);
	}
	await assertStepCommit(state.checkout, green, snapshot.head, session.runner, signal);
	await session.apply({ type: "step_completed", id: step.id, commit: snapshot.head, fingerprint: snapshot.fingerprint }, ctx);
}
