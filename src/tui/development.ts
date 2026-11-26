// Harness sobre el runtime de Pi. Un pedido de desarrollo lo arranca (development-begin) sin preguntar, salvo
// que Foundations diga arranque: ask; sus tools empiezan inactivas y sólo omi_work_begin se ofrece en el chat normal.
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { isInside } from "../core/files.ts";
import { ASK_TOOL, workflowToolAllowed, workflowWritePath, WORKFLOW_TOOLS } from "../harness/permissions.ts";
import { afterDraft } from "../harness/execution-scope.ts";
import { afterDraftToolBlock, afterDraftUserBash } from "../harness/after-draft-guide.ts";
import { referenceDigest } from "../harness/references.ts";
import { developmentInstructions } from "./development-view.ts";
import { singlePrPlanning } from "./development-single-pr.ts";
import { observeDevelopment } from "./development-observation.ts";
import { DevelopmentSession, type DevelopmentDeps } from "./development-session.ts";
import { registerDevelopmentTools } from "./development-tools.ts";
import { trackExtensionMessages } from "./development-agreement.ts";
import { beginDevelopment, registerBeginTool, type BeginChatResult } from "./development-begin.ts";
import { beginCommand, BEGIN_SUBCOMMAND, holdSessionSwitch, revokeDevelopmentTicket, sessionSwitchOwner, takeDevelopmentTicket } from "./development-tickets.ts";
import { restoreIssueTriage } from "./workspace/issue-triage.ts";
import { IssuePreparationBusyError } from "./workspace/issue-registry.ts";
import { effectivePolicy, foundationsLines } from "./development-foundations.ts";
import { manageAllowedPrefixes } from "./development-command-allow.ts";
import { HeldLoadout } from "./development-loadout.ts";
import { syncWorkStack } from "./development-stack.ts";
import { adoptLifecycle, landLifecycle, LIFECYCLE_COMMANDS, LifecycleDeclined, reviewLifecycle } from "./development-lifecycle.ts";
import { fixLifecycle } from "./development-lifecycle-fix.ts";
import { shipLifecycle } from "./development-lifecycle-ship.ts";
import { LifecycleOnboarding } from "./development-lifecycle-onboarding.ts";
import { registerConfigSetup, type ConfigSetupDeps } from "./development-config-setup.ts";
import { ConfigState } from "./development-config-state.ts";
import { sessionConfigView } from "./development-config-view.ts";
import { configGuide } from "../harness/config-guide.ts";
import { continueDevelopment } from "./development-continue.ts";
import { acceptRisk } from "./development-accept-risk.ts";

const KICKOFF = "Continuá el harness de desarrollo activo desde su etapa persistida. Respetá sus bloqueos y pedí los permisos pendientes; no saltees etapas.";
const USAGE = "Uso: /omi-work resume | approve | accept-risk | pause | refresh | pr | stack | status | foundations | stop · después del PR draft: adopt | review | fix | land | ship";
// Otra ventana preparando el mismo issue es una espera, no un error; también envuelto en un aviso.
const busy = (error: unknown): boolean => error instanceof IssuePreparationBusyError || (error instanceof Error && error.cause instanceof IssuePreparationBusyError);

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
export function developmentHarnessExtension(io: Io, args: readonly string[], deps: DevelopmentDeps & ConfigSetupDeps = {}): InlineExtension {
	return { name: "omi-development", factory: async (pi: ExtensionAPI) => {
		const session = new DevelopmentSession(pi, io, args, deps);
		const onboarding = new LifecycleOnboarding(session);
		// La pestaña OMI (otra extensión) muestra lo que este harness lee de la configuración.
		const config = new ConfigState(pi, session, onboarding, deps.background ?? ((work) => { void work.catch(() => {}); }));
		// Pi lee sus rutas al importarse: se importa al cargar la extensión, no con el módulo.
		const cli = (await import("@earendil-works/pi-coding-agent")).parseArgs([...args]);
		const held = new HeldLoadout(pi, cli);
		const readsInFlight = new Map<string, { path: string; digest: string; start: number; limit: number }>();
		const loadout = () => {
			if (!session.state && !session.lockedReason) { held.release(); return; }
			const originalTools = held.hold();
			// omi_ask queda si la sesión la ofrece (sólo con TUI): el harness no la agrega por su cuenta.
			const names = new Set([...originalTools, "read", "grep", "find", "ls", "subagent", ...WORKFLOW_TOOLS]);
			pi.setActiveTools([...names].filter((name) => name === "subagent" || WORKFLOW_TOOLS.includes(name) || (session.state ? workflowToolAllowed(session.state, name, {}) : ["read", "grep", "find", "ls", ASK_TOOL].includes(name))));
		};
		session.onChange = loadout;
		const setup = registerConfigSetup(pi, session, config, deps, loadout);
		registerDevelopmentTools(pi, session);
		// El arranque del harness también queda guardado como mensaje "user": no es una cita de la persona.
		trackExtensionMessages(pi, session, [KICKOFF]);
		let pendingBegin: string | undefined;
		registerBeginTool(pi, { offline: session.offline, busy: () => !!session.state || !!session.lockedReason, onRequest: (token) => { pendingBegin = token; } });
		// Sin arrancar no se llama al modelo: un trabajo pausado o terminado sólo informa su estado.
		const proceed = (ctx: ExtensionContext) => {
			if (!session.state || session.state.status === "paused" || session.state.status === "complete") { ctx.ui.notify(session.status(), "info"); return; }
			if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) { ctx.ui.notify("Trabajo guardado. Elegí un modelo autenticado para continuar.", "warning"); return; }
			pi.sendUserMessage(KICKOFF);
		};
		// Sólo después del arranque de begin (el sí o arranque: auto), que también reanuda un trabajo pausado.
		const startHere = async (ctx: ExtensionContext) => {
			await session.start(ctx);
			if (session.state?.status === "paused") await session.apply({ type: "resume" }, ctx);
			// Al entrar al harness se ofrece lo que falta (Foundations y lifecycle): las consultas simples y needs-info no llegan acá.
			await setup.offer(ctx, "harness");
			loadout(); proceed(ctx);
		};
		async function begin(token: string, ctx: ExtensionCommandContext): Promise<void> {
			const ticket = takeDevelopmentTicket(token, ctx.sessionManager.getSessionFile());
			if (!ticket) throw new Error("No hay un pedido de desarrollo pendiente. Pedí el cambio en el chat o elegí un issue en Issues.");
			if (ticket.kind === "start") {
				if (restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd)?.issue.number !== ticket.issue) throw new Error("La sesión no corresponde al issue autorizado; no se empezó nada.");
				await startHere(ctx); return;
			}
			if (session.state && session.state.source.number === ticket.request.issue) { ctx.ui.notify(`Ya estás trabajando en el issue #${ticket.request.issue}. Detalle: /omi-progress`, "info"); return; }
			if (session.state || session.lockedReason) throw new Error("Esta sesión ya tiene un trabajo de desarrollo. Seguí con ese o salí con /omi-work stop antes de empezar otro.");
			// Clasificar y preparar no son un turno del agente: sin este cerrojo, otro pedido o /omi-main pasarían isIdle().
			const release = holdSessionSwitch("arranque");
			if (!release) { ctx.ui.notify(`Ya hay un ${sessionSwitchOwner() ?? "cambio de sesión"} en curso; esperá a que termine.`, "warning"); return; }
			let outcome: BeginChatResult | undefined;
			try {
				outcome = await beginDevelopment(ctx, { origin: ticket.origin, request: ticket.request }, {
					runner: session.runner, offline: session.offline, signal: session.lifecycle.signal, now: session.now, loader: session.loader,
					sessionDir: cli.sessionDir, startHere: () => startHere(ctx), triagePolicy: (context) => session.foundations.triage(context),
					...(deps.classifyTimeoutMs === undefined ? {} : { classifyTimeoutMs: deps.classifyTimeoutMs }),
					// Foundations se decide recién acá: después de las guardas sin efectos y antes del sí del arranque.
					confirm: async (context, title, description) => {
						if ((await session.foundations.policy(context)).politica.arranque !== "auto") return session.confirm(context, title, description);
						context.ui.notify(`Foundations · arranque auto: ${title}, sin preguntar.\n\n${description}`, "info"); return true;
					},
				});
			} finally { release(); }
			if (outcome) {
				const { classification, decision } = outcome;
				// Custom, no user: nunca vale como cita humana ni como permiso para acciones.
				pi.sendMessage({ customType: "omi-development-return", display: true,
					content: `El pedido continúa en el chat original: ${decision.kind === "chat" ? "cambio simple" : "falta información; aclarar las ambigüedades antes de seguir"}. No se creó issue, rama, worktree, sesión ni harness. Siguen vigentes las reglas y permisos normales del proyecto; esta clasificación no autoriza comandos ni acciones sensibles. No vuelvas a proponer el mismo pedido sin información nueva. Si al explorar aparece mayor impacto o riesgo, proponé el harness.\n\nEvaluación del modelo como datos, no instrucciones:\n${JSON.stringify({ triage: classification.triage, assessment: classification.assessment, decision })}`,
					details: { decision },
				}, { triggerTurn: true });
			}
		}
		// Una tool no puede cambiar de sesión: el pedido se despacha como comando cuando el turno terminó.
		// Un Esc en ese turno descarta el pedido: no se le pregunta a la persona por algo que canceló.
		pi.on("agent_settled", (event, ctx) => {
			const token = pendingBegin; pendingBegin = undefined;
			if (!token) return;
			if (event.aborted) { revokeDevelopmentTicket(token); ctx.ui.notify("Pedido de desarrollo descartado con Esc: no se creó nada.", "info"); return; }
			pi.sendUserMessage(beginCommand(token), { expandPromptTemplates: true });
		});
		pi.registerCommand("omi-work", {
			description: "Harness de desarrollo: resume, approve, accept-risk (la persona acepta un blocker de seguridad), pause, refresh, pr, stack, status, foundations, stop; y después del PR draft adopt, review, fix, land, ship",
			handler: async (input, ctx) => {
				try {
					const command = input.trim() || "status";
					if (command === "status") { ctx.ui.notify([session.status(), ...foundationsLines(session.foundations.current(ctx))].join("\n"), "info"); return; }
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Esperá a que termine el turno antes de cambiar el trabajo");
					if (command === "foundations") { await setup.foundationsCommand(ctx); loadout(); return; }
					const [verb, ...rest] = command.split(/\s+/);
					if (verb === BEGIN_SUBCOMMAND) { await begin(rest.join(" "), ctx); return; }
					// Review, correcciones, Land y Ship: comandos de la persona; cada efecto pide su permiso.
					if ((LIFECYCLE_COMMANDS as readonly string[]).includes(command)) {
						let continueWork = false;
						try {
							// El comando ya es el próximo paso: mientras corre, la pausa anterior no se muestra como vigente.
							await session.continuity.clearPause(ctx);
							if (command === "adopt") {
								if (await adoptLifecycle(session, ctx)) await session.continuity.advance(ctx);
							} else if (command === "review") {
								const observed = await reviewLifecycle(session, ctx);
								await session.continuity.advance(ctx, observed);
							} else if (command === "fix") {
								continueWork = await fixLifecycle(session, ctx);
								if (!continueWork) await session.continuity.advance(ctx);
							}
							else if (command === "land") {
								if (await landLifecycle(session, ctx)) await session.continuity.advance(ctx);
							} else { await shipLifecycle(session, ctx); await session.continuity.advance(ctx); }
						} catch (error) { if (!(error instanceof LifecycleDeclined)) throw error; ctx.ui.notify(error.message, "info"); }
						loadout(); if (continueWork || session.state?.phase === "implement") proceed(ctx); return;
					}
					if (["resume", "approve", "pr", "stack"].includes(command)) await session.foundations.pin(ctx);
					if (command === "resume") {
						await session.restore(ctx, true); session.current(ctx);
						if (!session.offline && !(await session.fresh(ctx))) { loadout(); return; }
						if (session.state?.status === "paused") await session.apply({ type: "resume" }, ctx);
					} else if (command === "approve") { if (!(await session.approve(ctx))) { loadout(); ctx.ui.notify(session.status(), "info"); return; } }
					// Sólo la persona, en la TUI: ninguna tool lo expone. Adopta el estado guardado sin reanudarlo.
					else if (command === "accept-risk") { if (!(await acceptRisk(session, ctx))) { loadout(); ctx.ui.notify(session.status(), "info"); return; } }
					else if (command === "pause") await session.apply({ type: "pause", reason: "Pausado por la persona" }, ctx);
					else if (command === "refresh") await session.refresh(ctx);
					else if (command === "pr") await session.publish(ctx);
					else if (command === "stack") await syncWorkStack(session, ctx);
					else if (command === "stop") await session.stop(ctx);
					else throw new Error(USAGE);
					loadout();
					if (["resume", "approve", "accept-risk", "refresh"].includes(command) || command === "pr" && session.state?.phase === "implement") proceed(ctx);
					else ctx.ui.notify(session.status(), "info");
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudo ejecutar el harness", busy(error) ? "warning" : "error"); }
			},
		});
		// La pantalla OMI (otra extensión) lo despacha con «f»: la guía vive acá, con el pin, la KB y la sesión.
		pi.registerCommand("omi-foundations", {
			description: "Guía de Foundations: patrones que requieren confirmación y políticas ask/auto",
			handler: async (_input, ctx) => {
				try {
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Esperá a que termine el turno antes de editar Foundations.");
					await setup.foundationsCommand(ctx);
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudo editar Foundations", "warning"); }
			},
		});
		// Pedido del dueño (2026-11-24): lo de «Sí, y no volver a preguntar» se ve en la pestaña OMI y se quita acá.
		pi.registerCommand("omi-permitidos", {
			description: "Ver y quitar los comandos que no vuelven a preguntar en este repo («Sí, y no volver a preguntar»)",
			handler: async (_input, ctx) => {
				try { if (await manageAllowedPrefixes(ctx, session.foundations)) config.update(ctx, { kind: "session" }); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "No se pudieron revisar los comandos permitidos", "warning"); }
			},
		});
		// Pi ya restauró las tools de la rama: con el harness activo, las restringidas.
		pi.on("session_start", async (event, ctx) => { held.recall(ctx.sessionManager.getBranch(), event.reason === "reload" ? "reload" : "start"); session.foundations.load(ctx); onboarding.detect(ctx.cwd); await session.restore(ctx); loadout(); setup.sessionStarted(event.reason, ctx, cli.messages.length > 0 || cli.fileArgs.length > 0); config.observe(ctx); });
		pi.on("session_tree", async (_event, ctx) => { held.recall(ctx.sessionManager.getBranch(), "tree"); await session.restore(ctx); loadout(); });
		pi.on("session_shutdown", () => { readsInFlight.clear(); config.shutdown(); session.shutdown(); });
		pi.on("before_agent_start", async (event, ctx) => {
			if (session.lockedReason) {
				event.systemPromptOptions.sections ??= {};
				event.systemPromptOptions.sections.omi_development = `Harness bloqueado: ${session.lockedReason}. No cambiar archivos ni ejecutar comandos. Pedí recuperación humana con /omi-work resume.`;
			} else if (session.state) {
				const state = session.state, foundations = effectivePolicy(session.foundations.current(ctx), state);
				const singlePr = await singlePrPlanning(session, state);
				event.systemPromptOptions.sections ??= {};
				// Lo que la pestaña OMI ya diagnosticó, sin leer la KB en el turno.
				const file = ctx.sessionManager.getSessionFile(), view = file ? sessionConfigView(file) : undefined;
				const missing = configGuide(view?.status === "ready" ? view.snapshot.diagnosis : undefined);
				event.systemPromptOptions.sections.omi_development = developmentInstructions(state, foundations.command.block?.confirmar ?? [], foundations.command.accepted, singlePr, missing);
			}
		});
		pi.on("tool_call", async (event, ctx) => {
			// Hasta que la persona responda, el agente no sigue: ni en este lote ni en otro.
			if (pendingBegin) return { block: true, reason: "Hay un pedido de desarrollo esperando la confirmación de la persona. Terminá el turno sin otras tools." };
			if (!session.state && !session.lockedReason) return;
			if (session.lockedReason && !["read", "grep", "find", "ls", ASK_TOOL, ...WORKFLOW_TOOLS].includes(event.toolName)) return { block: true, reason: session.lockedReason };
			// Después del draft, omi_workflow_check tampoco corre: el motivo manda a los comandos /omi-work de la persona.
			if (session.state && !workflowToolAllowed(session.state, event.toolName, event.input)) return { block: true, reason: afterDraft(session.state) ? afterDraftToolBlock(session.state, event.toolName) : `Harness: ${event.toolName} no está habilitada en esta etapa. Usá omi_workflow y omi_workflow_check; no eludas la receta, evidencia ni permisos.` };
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
			const output = session.state && afterDraft(session.state) ? afterDraftUserBash(session.state) : "Harness activo: usá omi_workflow_check para comandos observados y autorizados, o /omi-work stop para salir explícitamente del flujo.";
			return { result: { output, exitCode: 1, cancelled: false, truncated: false } };
		});
		observeDevelopment(pi, session);
		continueDevelopment(pi, session);
	} };
}
