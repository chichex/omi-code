// Subcomandos del ciclo de proyecto: adaptadores delgados sobre el catálogo de tools.

import { UsageError } from "../../core/errors.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { runToolCommand } from "../tool-command.ts";

const SERVICE = { service: { type: "string" } } as const;
const YES = { yes: { type: "boolean" } } as const;
const ENV = { env: { type: "string" } } as const;

function toInteger(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new UsageError(`${flag} necesita un número`);
	return parsed;
}

export async function statusCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, SERVICE);
	return runToolCommand("omi_project_status", { service: values.service }, io, values);
}

function parseAssignment(text: string): { name: string; value: string } {
	const separator = text.indexOf("=");
	if (separator < 1) throw new UsageError(`se esperaba NOMBRE=valor: ${text}`);
	return { name: text.slice(0, separator), value: text.slice(separator + 1) };
}

function parseSecret(text: string): { name: string; fromEnv?: string } {
	const separator = text.indexOf("=");
	return separator < 0 ? { name: text } : { name: text.slice(0, separator), fromEnv: text.slice(separator + 1) };
}

export async function envCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, {
		...SERVICE,
		...ENV,
		...YES,
		unset: { type: "string", multiple: true },
		secret: { type: "string", multiple: true },
	});
	const [action, ...assignments] = positionals;
	if (action === "list") return runToolCommand("omi_env_list", { service: values.service, environment: values.env }, io, values);
	if (action !== "set") throw new UsageError("uso: omi env <list|set> --env <stage|prod>");
	return runToolCommand(
		"omi_env_set",
		{
			service: values.service,
			environment: values.env,
			set: assignments.length === 0 ? undefined : assignments.map(parseAssignment),
			unset: values.unset,
			secrets: values.secret?.map(parseSecret),
		},
		io,
		values,
	);
}

export async function resourcesCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, {
		...ENV,
		...YES,
		slug: { type: "string" },
		mode: { type: "string" },
		"resource-id": { type: "string" },
		"connection-env": { type: "string" },
		"pg-version": { type: "string" },
		size: { type: "string" },
		disk: { type: "string" },
	});
	const [kind, action] = positionals;
	if (kind === "list") return runToolCommand("omi_resources_list", { environment: values.env }, io, values);
	if (kind !== "postgres" || action === undefined) throw new UsageError("uso: omi resources <list|postgres <create|replace|delete|retry|recover>>");
	return runToolCommand(
		"omi_postgres_manage",
		{
			action,
			environment: values.env,
			slug: values.slug,
			mode: values.mode,
			resourceId: values["resource-id"],
			connectionFromEnv: values["connection-env"],
			version: values["pg-version"],
			size: values.size,
			diskGib: toInteger(values.disk, "--disk"),
		},
		io,
		values,
	);
}

const JOB_ACTIONS: Readonly<Record<string, string>> = { template: "handler_template", check: "handler_check" };

export async function jobsCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, {
		...SERVICE,
		...ENV,
		...YES,
		path: { type: "string" },
		schedule: { type: "string" },
		timezone: { type: "string" },
		timeout: { type: "string" },
		language: { type: "string" },
	});
	const [action, target] = positionals;
	if (action === undefined) throw new UsageError("uso: omi jobs <list|get|runs|create|update|delete|run|pause|resume|template|check>");
	const isCheck = action === "check";
	const onlyService = action === "create" && values.service === undefined ? await singleService(io) : values.service;
	return runToolCommand(
		"omi_jobs_manage",
		{
			action: JOB_ACTIONS[action] ?? action,
			name: isCheck ? undefined : target,
			file: isCheck ? target : undefined,
			service: onlyService,
			path: values.path,
			schedule: values.schedule,
			timezone: values.timezone,
			timeoutSeconds: toInteger(values.timeout, "--timeout"),
			environment: values.env,
			language: values.language,
		},
		io,
		values,
	);
}

async function singleService(io: Io): Promise<string | undefined> {
	const { readProjectLink } = await import("../../project/link.ts");
	const { services } = await readProjectLink(io.cwd);
	return services.length === 1 ? services[0]?.name : undefined;
}

export async function publishCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { ...SERVICE, ...YES, version: { type: "string" }, via: { type: "string" }, timeout: { type: "string" }, "wait-only": { type: "boolean" } });
	return runToolCommand(
		"omi_publish_version",
		{ service: values.service, version: values.version, via: values.via, timeoutSeconds: toInteger(values.timeout, "--timeout"), waitOnly: values["wait-only"] },
		io,
		values,
	);
}

export async function deployCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { ...SERVICE, ...ENV, ...YES, version: { type: "string" } });
	return runToolCommand("omi_deploy", { service: values.service, environment: values.env, version: values.version }, io, values);
}

export async function promoteCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { ...SERVICE, ...YES });
	return runToolCommand("omi_promote", { service: values.service }, io, values);
}

export async function logsCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, {
		...SERVICE,
		...ENV,
		lines: { type: "string" },
		duration: { type: "string" },
		crash: { type: "boolean" },
		id: { type: "string" },
		deployment: { type: "string" },
	});
	if (values.crash === true) {
		return runToolCommand("omi_crash_logs", { service: values.service, environment: values.env, instanceLogId: values.id, deploymentId: values.deployment }, io, values);
	}
	return runToolCommand(
		"omi_logs_tail",
		{ service: values.service, environment: values.env, lines: toInteger(values.lines, "--lines"), durationSeconds: toInteger(values.duration, "--duration") },
		io,
		values,
		{ streamProgress: true },
	);
}
