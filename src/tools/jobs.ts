// omi_jobs_manage: jobs cron del proyecto, más la plantilla y el chequeo del handler firmado.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { JobRunSchema, JobRunsSchema, JobSchema, JobsSchema } from "../client/views.ts";
import { OmiError, UsageError } from "../core/errors.ts";
import { enforce, type EnvironmentName } from "../guardrails/policy.ts";
import { checkHandler, handlerTemplate, languageOf, type HandlerLanguage } from "../jobs/handler.ts";
import { openScope, readService, type Scope } from "./scope.ts";
import { defineTool, type ToolResult, type ToolRuntime } from "./types.ts";

const Parameters = Type.Object({
	action: Type.Union(
		["list", "get", "runs", "create", "update", "delete", "run", "pause", "resume", "handler_template", "handler_check"].map((name) => Type.Literal(name)),
	),
	name: Type.Optional(Type.String()),
	service: Type.Optional(Type.String()),
	path: Type.Optional(Type.String({ description: "Empieza con /" })),
	schedule: Type.Optional(Type.String({ description: "Cron de 5 campos" })),
	timezone: Type.Optional(Type.String({ description: "IANA. Por defecto: UTC" })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
	environment: Type.Optional(Type.Union([Type.Literal("stage"), Type.Literal("prod")])),
	language: Type.Optional(Type.Union([Type.Literal("go"), Type.Literal("ts"), Type.Literal("python")])),
	file: Type.Optional(Type.String({ description: "Archivo del repo a verificar" })),
});

type Params = Static<typeof Parameters>;

function required<T>(value: T | undefined, what: string, action: string): T {
	if (value === undefined) throw new UsageError(`${action} necesita ${what}`);
	return value;
}

function jobPath(scope: Scope, name: string): string {
	return `${scope.projectPath}/jobs/${encodeURIComponent(name)}`;
}

/** Un job se aplica a todo ambiente desplegado de su service: con prod arriba, toca prod. */
async function reachedEnvironment(scope: Scope, service: string): Promise<EnvironmentName> {
	const view = await readService(scope, service);
	const prod = view.environments.find((environment) => environment.name === "prod");
	return prod?.current_version === undefined ? "stage" : "prod";
}

async function guardJob(action: string, name: string, environment: EnvironmentName, runtime: ToolRuntime, diff: string): Promise<void> {
	await enforce({ operation: "jobs", environment, summary: `Job ${name}: ${action}`, diff }, runtime.guard);
}

async function saveJob(scope: Scope, params: Params, runtime: ToolRuntime): Promise<ToolResult> {
	const name = required(params.name, "name", params.action);
	const creating = params.action === "create";
	const current = creating ? undefined : await scope.client.request("GET", jobPath(scope, name), JobSchema);
	const body = {
		service: required(params.service ?? current?.service, "service", params.action),
		path: required(params.path ?? current?.path, "path", params.action),
		schedule: required(params.schedule ?? current?.schedule, "schedule", params.action),
		timezone: params.timezone ?? current?.timezone ?? "",
		timeout_seconds: params.timeoutSeconds ?? current?.timeout_seconds ?? 0,
	};
	const diff = `${creating ? "+" : "~"} ${name}: ${body.schedule} ${body.timezone} POST ${body.service}${body.path} (${body.timeout_seconds}s)`;
	await guardJob(params.action, name, await reachedEnvironment(scope, body.service), runtime, diff);
	const job = creating
		? await scope.client.request("POST", `${scope.projectPath}/jobs`, JobSchema, { body: { name, ...body } })
		: await scope.client.request("PUT", jobPath(scope, name), JobSchema, { body });
	return { text: `Job ${job.name}: ${job.schedule} (${job.timezone})`, data: job };
}

async function deleteJob(scope: Scope, params: Params, runtime: ToolRuntime): Promise<ToolResult> {
	const name = required(params.name, "name", "delete");
	const job = await scope.client.request("GET", jobPath(scope, name), JobSchema);
	await guardJob("delete", name, await reachedEnvironment(scope, job.service), runtime, `- ${name}`);
	await scope.client.requestEmpty("DELETE", jobPath(scope, name));
	return { text: `Job ${name} borrado`, data: { deleted: name } };
}

async function controlJob(scope: Scope, params: Params, runtime: ToolRuntime): Promise<ToolResult> {
	const name = required(params.name, "name", params.action);
	const environment = required(params.environment, "environment", params.action);
	await guardJob(params.action, name, environment, runtime, `${params.action} ${name} en ${environment}`);
	const path = `${jobPath(scope, name)}/environments/${environment}/${params.action}`;
	const data =
		params.action === "run"
			? await scope.client.request("POST", path, JobRunSchema, { body: {} })
			: await scope.client.request("POST", path, JobSchema, { body: {} });
	return { text: `Job ${name}: ${params.action} en ${environment}`, data };
}

async function readJobs(scope: Scope, params: Params): Promise<ToolResult> {
	if (params.action === "list") {
		const { jobs } = await scope.client.request("GET", `${scope.projectPath}/jobs`, JobsSchema);
		return { text: jobs.map((job) => `${job.name}: ${job.schedule} POST ${job.service}${job.path}`).join("\n") || "El proyecto no tiene jobs", data: { jobs } };
	}
	const name = required(params.name, "name", params.action);
	if (params.action === "get") {
		const job = await scope.client.request("GET", jobPath(scope, name), JobSchema);
		return { text: `${job.name}: ${job.schedule} POST ${job.service}${job.path}`, data: job };
	}
	const environment = required(params.environment, "environment", "runs");
	const { runs } = await scope.client.request("GET", `${jobPath(scope, name)}/runs?environment=${environment}`, JobRunsSchema);
	return { text: runs.map((run) => `${run.started_at} ${run.state}`).join("\n") || "Sin corridas", data: { runs } };
}

async function checkFile(params: Params, runtime: ToolRuntime): Promise<ToolResult> {
	const file = required(params.file, "file", "handler_check");
	const language: HandlerLanguage | null = params.language ?? languageOf(file);
	if (language === null) throw new UsageError(`no sé qué lenguaje es ${file}: indicá language`);
	const missing = checkHandler(await readFile(join(runtime.io.cwd, file), "utf8"), language);
	if (missing.length > 0) {
		throw new OmiError("handler_unsigned", `${file} no verifica la firma: falta ${missing.join(", ")}`, {
			hint: "`handler_template` trae una base correcta",
		});
	}
	return { text: `${file} verifica la firma de OMI`, data: { file, language, missing } };
}

export const jobsManageTool = defineTool({
	name: "omi_jobs_manage",
	label: "OMI: gestionar jobs",
	description: "Consulta y gestiona jobs cron del proyecto, y entrega o verifica el handler HTTP firmado que los recibe.",
	parameters: Parameters,
	run: async (params, runtime) => {
		if (params.action === "handler_template") {
			const template = handlerTemplate(required(params.language, "language", "handler_template"), params.path ?? "/jobs/nombre");
			return { text: template, data: { template } };
		}
		if (params.action === "handler_check") return checkFile(params, runtime);
		const scope = await openScope(runtime);
		switch (params.action) {
			case "list":
			case "get":
			case "runs":
				return readJobs(scope, params);
			case "create":
			case "update":
				return saveJob(scope, params, runtime);
			case "delete":
				return deleteJob(scope, params, runtime);
			default:
				return controlJob(scope, params, runtime);
		}
	},
});
