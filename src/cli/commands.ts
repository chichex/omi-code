// Tabla de subcomandos. Cada entrada es un adaptador delgado sobre el core.

import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.ts";
import { importCommand } from "./commands/import.ts";
import { initCommand } from "./commands/init.ts";
import { registryCommand, visibilityCommand } from "./commands/platform.ts";
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
	["registry", "registry de la organización"],
	["visibility", "visibilidad de un ambiente"],
	["jobs", "jobs cron"],
	["publish", "publica una versión"],
	["deploy", "despliega una versión"],
	["promote", "promueve a prod la versión de stage"],
	["logs", "logs en vivo y crash logs"],
	["upgrade", "actualiza omi"],
	["import", "trae credenciales, ajustes y grills de Pi"],
	["mcp", "servidor MCP por stdio"],
];

/** Cierra la nota de uso de lo que exige un humano. */
const CONFIRM = "pide confirmación en una terminal interactiva; --yes no la reemplaza.";

/** Uso de cada subcomando. `--json` y `--api <url>` valen en todos. */
export const USAGE: Readonly<Record<string, string>> = {
	login: "omi login [--email <email>] [--password-stdin]",
	logout: "omi logout",
	whoami: "omi whoami",
	init: `omi init --project <slug> --service <nombre[:ruta[:puerto[:dockerfile]]]> [--org <slug>] [--name <nombre>] [--port <n>] [--env stage,prod] [--create]\n--create pide crear el proyecto o los services que falten, no lo aprueba: crear pide confirmación en una terminal interactiva.\nomi init --development [--check] [--json]\nSin flags, en una terminal, elige el módulo. --development configura Review, Land y Ship en la KB con resumen y un sí explícito; --check sólo lee.`,
	status: "omi status [--service <nombre>]",
	env: `omi env list --env <stage|prod> [--service <nombre>]\nomi env set --env <stage|prod> [NOMBRE=valor...] [--unset NOMBRE] [--secret NOMBRE[=VARIABLE_LOCAL]] [--yes]\nTocar prod o un secreto ${CONFIRM}`,
	resources: `omi resources list [--env <stage|prod>]\nomi resources postgres <create|replace|delete|retry|recover> [--env <e>] [--slug <s>] [--mode <externa|local>] [--resource-id <id>] [--connection-env <VARIABLE>] [--pg-version <v>] [--size <S|M|L>] [--yes]\nomi resources postgres query --env <stage|prod> [--slug <s>] [--resource-id <id>] [--max-rows <n>] [--timeout <s>] [--file <archivo|->] "<sql>"\nomi resources postgres exec --env <stage|prod> [--slug <s>] [--resource-id <id>] [--max-rows <n>] [--timeout <s>] [--file <archivo|->] "<sql>"\nGestionar un Postgres siempre ${CONFIRM}\nConsultar es de sólo lectura y no pide confirmación en ningún ambiente: Postgres mismo impide que escriba. Por defecto devuelve hasta 500 filas y corta a los 10 s; --max-rows y --timeout sólo pueden pedir menos.\nEjecutar SQL siempre ${CONFIRM}`,
	registry: `omi registry <status|hosts|create|retry-route> [--host <id>] [--org <slug>] [--yes]\nCrear el registry o reintentar su ruta siempre ${CONFIRM}`,
	visibility: `omi visibility set <privado|organizacion|publico> --env <stage|prod> [--service <nombre>] [--yes]\nCambiar la visibilidad siempre ${CONFIRM}`,
	jobs: `omi jobs <list|get|runs|create|update|delete|run|pause|resume> [nombre] [--service <s>] [--path </ruta>] [--schedule <cron>] [--timezone <iana>] [--timeout <s>] [--env <e>] [--yes]\nomi jobs template --language <go|ts|python> [--path </ruta>]\nomi jobs check <archivo>\nUn job que alcanza prod ${CONFIRM}`,
	publish: "omi publish --version <X.Y.Z> [--service <nombre>] [--via <tag|direct>] [--timeout <s>] [--wait-only] [--yes]",
	deploy: `omi deploy --env <stage|prod> --version <X.Y.Z> [--service <nombre>] [--yes]\nEl deploy a prod ${CONFIRM}`,
	promote: `omi promote [--service <nombre>] [--yes]\nPromover siempre ${CONFIRM}`,
	logs: "omi logs --env <stage|prod> [--service <nombre>] [--lines <n>] [--duration <s>]\nomi logs --env <stage|prod> --crash [--id <ilog>] [--deployment <dep>]",
	upgrade: "omi upgrade [--check]",
	import: "omi import pi",
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
	registry: registryCommand,
	visibility: visibilityCommand,
	jobs: jobsCommand,
	publish: publishCommand,
	deploy: deployCommand,
	promote: promoteCommand,
	logs: logsCommand,
	upgrade: upgradeCommand,
	import: importCommand,
};
