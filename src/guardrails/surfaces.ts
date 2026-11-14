// Cómo pregunta cada cara. La política es una sola; cambia quién responde.

import type { Io } from "../cli/io.ts";
import type { Guard, GuardedAction } from "./policy.ts";

/** Marca que hereda todo proceso lanzado por la TUI: ahí quien escribe puede ser el modelo. */
export const AGENT_SESSION_ENV = "OMI_AGENT_SESSION";

export function isAgentSession(io: Io): boolean {
	return io.env[AGENT_SESSION_ENV] !== undefined;
}

function sessionGuard(fields: Pick<Guard, "surface" | "canAsk" | "preApproved" | "ask">, stageAuthorized: boolean): Guard {
	let stage = stageAuthorized;
	return {
		...fields,
		get stageAuthorized() {
			return stage;
		},
		grantStage() {
			stage = true;
		},
	};
}

export interface CliGuardOptions {
	/** `--yes`: aprueba de antemano lo autónomo de stage, nunca lo que exige un humano. */
	yes: boolean;
	/** Flag que pide la operación sin aprobarla, como `--create`. */
	requestFlag?: string;
}

export function cliGuard(io: Io, options: CliGuardOptions): Guard {
	const agent = isAgentSession(io);
	const ignoredFlag = options.yes ? "--yes" : options.requestFlag;
	return sessionGuard(
		{
			surface: "cli",
			canAsk: io.interactive && !agent,
			preApproved: options.yes && !agent,
			ask: async (action: GuardedAction) => {
				io.err(`\n${action.summary}\n${action.diff}\n`);
				// Fuera de una sesión agéntica stage ya está autorizado: acá sólo llega lo que exige un humano.
				if (ignoredFlag !== undefined) io.err(`${ignoredFlag} no aprueba esta operación: exige tu confirmación.`);
				return /^s/i.test((await io.prompt("¿Confirmás? [s/N] ")).trim());
			},
		},
		!agent,
	);
}

export interface ConfirmUi {
	confirm(title: string, message: string): Promise<boolean>;
}

/** La autorización de stage vive en la sesión; la UI puede cambiar entre llamadas. */
export function tuiGuard(state: { stageAuthorized: boolean }, ui: ConfirmUi | undefined): Guard {
	return {
		surface: "tui",
		canAsk: ui !== undefined,
		preApproved: false,
		get stageAuthorized() {
			return state.stageAuthorized;
		},
		grantStage() {
			state.stageAuthorized = true;
		},
		ask: async (action) => (ui === undefined ? false : ui.confirm(action.summary, action.diff)),
	};
}

export interface McpGuardOptions {
	stageAuthorized: boolean;
	/** Se conoce recién al inicializar, por las capacidades del cliente. */
	canElicit(): boolean;
	/** Pregunta al usuario del cliente MCP. Nunca lo responde el modelo. */
	elicit(message: string): Promise<boolean>;
}

export function mcpGuard(options: McpGuardOptions): Guard {
	let stage = options.stageAuthorized;
	return {
		surface: "mcp",
		preApproved: false,
		get canAsk() {
			return options.canElicit();
		},
		get stageAuthorized() {
			return stage;
		},
		grantStage() {
			stage = true;
		},
		ask: (action) => options.elicit(`${action.summary}\n\n${action.diff}`),
	};
}
