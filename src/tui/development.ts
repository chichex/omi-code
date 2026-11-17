// Harness opt-in sobre el runtime de Pi. Mantiene /omi-triage como preparación sin ejecución.
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { isInside } from "../core/files.ts";
import { workflowToolAllowed, workflowWritePath, WORKFLOW_TOOLS } from "../harness/permissions.ts";
import { referenceDigest } from "../harness/references.ts";
import { developmentInstructions } from "./development-view.ts";
import { DevelopmentSession, type DevelopmentDeps } from "./development-session.ts";
import { registerDevelopmentTools } from "./development-tools.ts";

async function checkWriteTarget(root: string, path: string): Promise<void> {
	const target = workflowWritePath(root, path);
	try { if ((await lstat(target)).isSymbolicLink()) throw new Error("No se escribe a través de un symlink"); }
	catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
	let ancestor = target;
	for (;;) {
		try { if (!isInside(root, await realpath(ancestor))) throw new Error("La escritura sale del checkout por un symlink"); return; }
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(ancestor) === ancestor) throw error;
			ancestor = dirname(ancestor);
		}
	}
}
export function developmentHarnessExtension(io: Io, args: readonly string[], deps: DevelopmentDeps = {}): InlineExtension {
	return { name: "omi-development", factory: (pi: ExtensionAPI) => {
		const session = new DevelopmentSession(pi, io, args, deps);
		let originalTools: string[] | undefined;
		const readsInFlight = new Map<string, { path: string; digest: string; start: number; limit: number }>();
		const loadout = () => {
			if (!session.state && !session.lockedReason) {
				if (originalTools) { pi.setActiveTools(originalTools); originalTools = undefined; }
				return;
			}
			originalTools ??= pi.getActiveTools();
			const names = new Set([...originalTools, "read", "grep", "find", "ls", "subagent", ...WORKFLOW_TOOLS]);
			pi.setActiveTools([...names].filter((name) => name === "subagent" || WORKFLOW_TOOLS.includes(name) || (session.state ? workflowToolAllowed(session.state, name, {}) : ["read", "grep", "find", "ls"].includes(name))));
		};
		session.onChange = loadout;
		registerDevelopmentTools(pi, session);
		pi.registerCommand("omi-work", {
			description: "Harness de desarrollo: start, resume, approve, pause, refresh, pr, status, stop",
			handler: async (input, ctx) => {
				try {
					const command = input.trim() || "status";
					if (command === "status") { ctx.ui.notify(session.status(), "info"); return; }
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Esperá a que termine el turno antes de cambiar el trabajo");
					if (command === "start") await session.start(ctx);
					else if (command === "resume") {
						await session.restore(ctx, true); session.current(ctx);
						if (!session.offline && !(await session.fresh(ctx))) { loadout(); return; }
						if (session.state?.status === "paused") await session.apply({ type: "resume" }, ctx);
					} else if (command === "approve") await session.approve(ctx);
					else if (command === "pause") await session.apply({ type: "pause", reason: "Pausado por la persona" }, ctx);
					else if (command === "refresh") {
						if (await session.fresh(ctx)) await session.apply({ type: "source_changed", source: session.current(ctx).source }, ctx);
						session.reads.clear(); session.approvedCommands.clear();
					} else if (command === "pr") await session.publish(ctx);
					else if (command === "stop") await session.stop(ctx);
					else throw new Error("Uso: /omi-work start | resume | approve | pause | refresh | pr | status | stop");
					loadout();
					if (["start", "resume", "approve", "refresh"].includes(command) && session.state && session.state.status !== "paused" && session.state.status !== "complete") {
						if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) { ctx.ui.notify("Trabajo guardado. Elegí un modelo autenticado para continuar.", "warning"); return; }
						pi.sendUserMessage("Continuá el harness de desarrollo activo desde su etapa persistida. Respetá sus bloqueos y pedí los permisos pendientes; no saltees etapas.");
					} else ctx.ui.notify(session.status(), "info");
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudo ejecutar el harness", "error"); }
			},
		});
		pi.on("session_start", async (_event, ctx) => { await session.restore(ctx); loadout(); });
		pi.on("session_tree", async (_event, ctx) => { await session.restore(ctx); loadout(); });
		pi.on("session_shutdown", () => { readsInFlight.clear(); session.shutdown(); });
		pi.on("before_agent_start", (event) => {
			if (session.lockedReason) {
				event.systemPromptOptions.sections ??= {};
				event.systemPromptOptions.sections.omi_development = `Harness bloqueado: ${session.lockedReason}. No cambiar archivos ni ejecutar comandos. Pedí recuperación humana con /omi-work resume.`;
			} else if (session.state) {
				event.systemPromptOptions.sections ??= {};
				event.systemPromptOptions.sections.omi_development = developmentInstructions(session.state);
			}
		});
		pi.on("tool_call", async (event, ctx) => {
			if (!session.state && !session.lockedReason) return;
			if (session.lockedReason && !["read", "grep", "find", "ls", ...WORKFLOW_TOOLS].includes(event.toolName)) return { block: true, reason: session.lockedReason };
			if (session.state && !workflowToolAllowed(session.state, event.toolName, event.input)) return { block: true, reason: `Harness: ${event.toolName} no está habilitada en esta etapa. Usá omi_workflow y omi_workflow_check; no eludas la receta, evidencia ni permisos.` };
			if (session.state && event.toolName === "read" && typeof event.input.path === "string") {
				try {
					const path = await realpath(resolve(session.state.checkout.root, event.input.path.replace(/^@/, "")));
					const digest = isInside(session.state.checkout.root, path) ? await referenceDigest(path) : undefined;
					if (digest) readsInFlight.set(event.toolCallId, { path, digest, start: typeof event.input.offset === "number" ? event.input.offset : 1, limit: typeof event.input.limit === "number" ? event.input.limit : 2000 });
				} catch { /* El lector nativo informa su propio error; no se emite un recibo. */ }
			}
			if (session.state && (event.toolName === "write" || event.toolName === "edit")) {
				if (typeof event.input.path !== "string") return { block: true, reason: "Falta el path del cambio" };
				try { session.checkContext(ctx); await checkWriteTarget(session.state.checkout.root, event.input.path); }
				catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Escritura fuera del checkout" }; }
			}
		});
		pi.on("tool_execution_start", (event) => {
			if (!session.state || !["read", "grep", "find", "ls", "write", "edit"].includes(event.toolName)) return;
			const path = event.args && typeof event.args === "object" && "path" in event.args && typeof event.args.path === "string" ? event.args.path : "repositorio";
			session.emit(`${event.toolName} · ${path}`);
		});
		pi.on("tool_execution_end", async (event) => {
			const receipt = readsInFlight.get(event.toolCallId); readsInFlight.delete(event.toolCallId);
			if (!session.state || !receipt || event.isError) return;
			try {
				if (await referenceDigest(receipt.path) !== receipt.digest) return;
				const raw: unknown = event.result.content;
				const content = Array.isArray(raw) ? raw.filter((part: unknown): part is { type: "text"; text: string } => !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("\n") : "";
				let lines = content ? Math.min(receipt.limit, content.split("\n").length) : 0;
				const details: unknown = event.result.details;
				if (details && typeof details === "object" && "truncation" in details && details.truncation && typeof details.truncation === "object") {
					const truncation = details.truncation;
					if ("firstLineExceedsLimit" in truncation && truncation.firstLineExceedsLimit || "lastLinePartial" in truncation && truncation.lastLinePartial) return;
					if ("truncated" in truncation && truncation.truncated) {
						if (!("outputLines" in truncation) || typeof truncation.outputLines !== "number" || !Number.isSafeInteger(truncation.outputLines) || truncation.outputLines < 1) return;
						lines = Math.min(lines, truncation.outputLines);
					}
				}
				if (!lines) return;
				const end = receipt.start + lines - 1;
				const previous = session.reads.get(receipt.path);
				session.reads.set(receipt.path, { digest: receipt.digest, ranges: [...(previous?.digest === receipt.digest ? previous.ranges : []), [receipt.start, end]] });
				session.emit(`Leído · ${receipt.path}`);
			} catch { /* Una lectura inválida no acredita una referencia. */ }
		});
		pi.on("user_bash", () => {
			if (!session.state && !session.lockedReason) return;
			return { result: { output: "Harness activo: usá omi_workflow_check para comandos observados y autorizados, o /omi-work stop para salir explícitamente del flujo.", exitCode: 1, cancelled: false, truncated: false } };
		});
	} };
}
