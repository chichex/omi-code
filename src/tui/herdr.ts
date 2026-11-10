// Integración propia: Herdr conoce a omi, no al Pi que corre por debajo.
// No se descubren extensiones del usuario ni se requiere Herdr fuera de sus panes.

import { createConnection } from "node:net";
import type { Args, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";

type State = "idle" | "working" | "blocked";
export interface HerdrReport {
	id: string;
	method: "pane.report_agent" | "pane.release_agent";
	params: {
		pane_id: string;
		source: "omi";
		agent: "omi";
		seq: number;
		state?: State;
		message?: string;
		agent_session_path?: string;
		resume_argv?: string[];
	};
}
export type HerdrSend = (socketPath: string, report: HerdrReport) => Promise<void>;

/** JSONL sobre Unix socket / named pipe. Una conexión caída nunca debe frenar al agente. */
export const sendHerdrReport: HerdrSend = (socketPath, report) => new Promise((resolve) => {
	const endpoint = process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const socket = createConnection(endpoint);
	const finish = (): void => { clearTimeout(timeout); socket.destroy(); resolve(); };
	const timeout = setTimeout(finish, 500);
	socket.on("error", finish);
	socket.on("close", finish);
	socket.on("connect", () => socket.write(`${JSON.stringify(report)}\n`));
	// Sólo necesitamos el acuse; no conservar ni imprimir respuestas del servidor.
	socket.on("data", finish);
});

/** Sólo opciones de ejecución conocidas: nunca el prompt inicial, archivos adjuntos o API keys. */
function resumeOptions(args: Args): string[] {
	const result: string[] = [];
	const values = {
		"--tools": args.tools?.join(","), "--exclude-tools": args.excludeTools?.join(","),
		"--models": args.models?.join(","), "--system-prompt": args.systemPrompt,
		"--use-theme": args.useTheme, "--tui-mode": args.tuiMode,
	};
	for (const [flag, value] of Object.entries(values)) if (value !== undefined) result.push(flag, value);
	const lists = {
		"--extension": args.extensions, "--skill": args.skills, "--prompt-template": args.promptTemplates,
		"--theme": args.themes, "--append-system-prompt": args.appendSystemPrompt,
	};
	for (const [flag, values] of Object.entries(lists)) for (const value of values ?? []) result.push(flag, value);
	const switches = {
		"--no-tools": args.noTools, "--no-builtin-tools": args.noBuiltinTools,
		"--no-extensions": args.noExtensions, "--no-mcp": args.noMcp, "--no-skills": args.noSkills,
		"--no-prompt-templates": args.noPromptTemplates, "--no-themes": args.noThemes,
		"--no-context-files": args.noContextFiles, "--offline": args.offline,
		"--approve": args.projectTrustOverride === true, "--no-approve": args.projectTrustOverride === false,
	};
	for (const [flag, enabled] of Object.entries(switches)) if (enabled) result.push(flag);
	return result;
}

function resumeCommand(ctx: ExtensionContext, options: string[]): string[] | undefined {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return undefined; // --no-session: no prometer una restauración imposible.
	const args = ["omi", ...options, "--session", file];
	if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	if (ctx.thinkingLevel !== undefined) args.push("--thinking", ctx.thinkingLevel);
	// Herdr rechaza el reporte entero si resume_argv no cumple estos límites.
	if (args.length > 64 || args.some((arg) => /['\p{Cc}]/u.test(arg)) ||
		args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) > 8192) return undefined;
	return args;
}

export function herdrExtension(io: Io, args: string[], send: HerdrSend = sendHerdrReport): InlineExtension {
	const { HERDR_ENV, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: socket } = io.env;
	// La cola y la secuencia sobreviven al reemplazo del runtime (/new, /resume, /reload, /fork).
	let sequence = 0;
	let pending: HerdrReport | undefined;
	let inFlight: Promise<void> | undefined;
	const drain = (): Promise<void> => {
		inFlight ??= Promise.resolve().then(async () => {
			while (pending) {
				const next = pending;
				pending = undefined;
				try { await send(socket!, next); } catch { /* Herdr nunca rompe omi. */ }
			}
		}).finally(() => {
			inFlight = undefined;
			if (pending) return drain();
		});
		return inFlight;
	};
	const enqueue = (method: HerdrReport["method"], params: Omit<HerdrReport["params"], "pane_id" | "source" | "agent" | "seq"> = {}): Promise<void> => {
		sequence = Math.max(Date.now() * 1000, sequence + 1);
		pending = { id: `omi:${sequence}`, method, params: { pane_id: pane!, source: "omi", agent: "omi", seq: sequence, ...params } };
		return drain();
	};

	return { name: "omi-herdr", factory: async (pi) => {
		if (HERDR_ENV !== "1" || !pane || !socket) return;
		// Importar Pi sólo después de que launchTui haya fijado sus rutas.
		const { parseArgs } = await import("@earendil-works/pi-coding-agent");
		const options = resumeOptions(parseArgs(args));
		let active = false;
		let working = false;
		let waiting = false;
		let message: string | undefined;

		const report = (ctx: ExtensionContext): void => {
			if (!active) return;
			const state: State = waiting ? "blocked" : working ? "working" : "idle";
			const resume = resumeCommand(ctx, options);
			void enqueue("pane.report_agent", {
				state,
				...(waiting && message ? { message } : {}),
				...(resume ? { agent_session_path: ctx.sessionManager.getSessionFile()!, resume_argv: resume } : {}),
			});
		};

		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return; // RPC también tiene hasUI; no debe apropiarse del pane padre.
			active = true;
			working = !ctx.isIdle();
			report(ctx);
		});
		pi.on("before_agent_start", (_event, ctx) => { working = true; report(ctx); });
		pi.on("agent_start", (_event, ctx) => { working = true; report(ctx); });
		// agent_end no es final: puede haber reintentos, compactación o mensajes encolados.
		pi.on("agent_settled", (_event, ctx) => { working = false; report(ctx); });
		pi.on("ui_prompt_start", (event, ctx) => {
			waiting = true;
			message = event.title;
			report(ctx);
		});
		pi.on("ui_prompt_end", (_event, ctx) => { waiting = false; message = undefined; report(ctx); });
		pi.on("model_select", (_event, ctx) => report(ctx));
		pi.on("thinking_level_select", (_event, ctx) => report(ctx));
		pi.on("session_shutdown", (event) => {
			if (!active) return;
			active = false;
			if (event.reason === "quit") return enqueue("pane.release_agent");
		});
	} };
}
