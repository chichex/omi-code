// Tabla de subcomandos. Cada entrada es un adaptador delgado sobre el core.

import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.ts";
import { initCommand } from "./commands/init.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import {
	deployCommand,
	envCommand,
	jobsCommand,
	logsCommand,
	promoteCommand,
	publishCommand,
	resourcesCommand,
	statusCommand,
} from "./commands/workload.ts";
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

/** Uso de cada subcomando. `--json` y `--api <url>` valen en todos. */
export const USAGE: Readonly<Record<string, string>> = {
	login: "omi login [--email <email>] [--password-stdin]",
	logout: "omi logout",
	whoami: "omi whoami",
	init: "omi init --project <slug> --service <nombre[:ruta[:puerto[:dockerfile]]]> [--org <slug>] [--name <nombre>] [--port <n>] [--env stage,prod] [--create]",
	status: "omi status [--service <nombre>]",
	env: "omi env list --env <stage|prod> [--service <nombre>]\nomi env set --env <stage|prod> [NOMBRE=valor...] [--unset NOMBRE] [--secret NOMBRE[=VARIABLE_LOCAL]] [--yes]",
	resources: "omi resources list [--env <stage|prod>]\nomi resources postgres <create|replace|delete|retry|recover> [--env <e>] [--slug <s>] [--mode <externa|local>] [--resource-id <id>] [--connection-env <VARIABLE>] [--pg-version <v>] [--size <S|M|L>] [--yes]",
	jobs: "omi jobs <list|get|runs|create|update|delete|run|pause|resume> [nombre] [--service <s>] [--path </ruta>] [--schedule <cron>] [--timezone <iana>] [--timeout <s>] [--env <e>] [--yes]\nomi jobs template --language <go|ts|python> [--path </ruta>]\nomi jobs check <archivo>",
	publish: "omi publish --version <X.Y.Z> [--service <nombre>] [--via <tag|direct>] [--timeout <s>] [--wait-only] [--yes]",
	deploy: "omi deploy --env <stage|prod> --version <X.Y.Z> [--service <nombre>] [--yes]",
	promote: "omi promote [--service <nombre>] [--yes]",
	logs: "omi logs --env <stage|prod> [--service <nombre>] [--lines <n>] [--duration <s>]\nomi logs --env <stage|prod> --crash [--id <ilog>] [--deployment <dep>]",
	upgrade: "omi upgrade [--check]",
	mcp: "omi mcp [--authorize-stage]",
};

export const COMMANDS: Readonly<Record<string, Command | undefined>> = {
	login: loginCommand,
	logout: logoutCommand,
	whoami: whoamiCommand,
	init: initCommand,
	status: statusCommand,
	env: envCommand,
	resources: resourcesCommand,
	jobs: jobsCommand,
	publish: publishCommand,
	deploy: deployCommand,
	promote: promoteCommand,
	logs: logsCommand,
	upgrade: upgradeCommand,
};
