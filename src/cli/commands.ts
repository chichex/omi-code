// Tabla de subcomandos. Cada entrada es un adaptador delgado sobre el core.

import { EXIT_ERROR } from "../core/errors.ts";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.ts";
import { initCommand } from "./commands/init.ts";
import type { Io } from "./io.ts";

export type Command = (args: string[], io: Io) => Promise<number>;

export const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
	["login", "abre una sesión en OMI"],
	["logout", "revoca la sesión y borra las credenciales"],
	["whoami", "muestra la sesión activa"],
	["init", "vincula el repo con un proyecto de OMI"],
	["status", "estado del proyecto, services y ambientes"],
	["env", "variables y secretos de un ambiente"],
	["resources", "recursos Postgres"],
	["jobs", "jobs cron"],
	["publish", "publica una versión"],
	["deploy", "despliega una versión"],
	["promote", "promueve a prod la versión de stage"],
	["logs", "logs en vivo y crash logs"],
	["upgrade", "actualiza omi"],
	["mcp", "servidor MCP por stdio"],
];

export const COMMANDS: Readonly<Record<string, Command | undefined>> = {
	...Object.fromEntries(HELP_ROWS.filter(([name]) => name !== "mcp").map(([name]) => [name, notImplemented(name)])),
	login: loginCommand,
	logout: logoutCommand,
	whoami: whoamiCommand,
	init: initCommand,
};

function notImplemented(name: string): Command {
	return async (_args, io) => {
		io.err(`omi: ${name} todavía no está disponible`);
		return EXIT_ERROR;
	};
}
