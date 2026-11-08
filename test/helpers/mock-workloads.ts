// Rutas de variables, recursos y jobs del doble de omi-api, con la semántica del censo.

import { Problem, type MockOmi, type MockRequest, type MockResponse } from "./mock-omi.ts";
import { requireProjectFor, requireServiceFor, requireSessionFor, strictBodyOf } from "./mock-omi.ts";

export interface WorkloadState {
	/** Valores de secretos tal como llegaron: sólo para que el test mire el PUT. */
	secrets: Map<string, string>;
	jobs: Map<string, Record<string, unknown>>;
	resources: Map<string, Record<string, unknown>>;
	previews: Map<string, Record<string, unknown>>;
	operations: Map<string, { view: Record<string, unknown>; polls: number; terminal: string }>;
	operationOutcome: string;
	pendingConfiguration: boolean;
	/** Versión que el barrido del registry detecta tras N consultas. */
	scan: { tag: string; afterRefreshes: number; refreshes: number } | null;
	deployments: Map<string, Record<string, unknown>[]>;
	/** Pasos que emite un deploy, uno por consulta. */
	deploySteps: { kind: string; instance?: string }[];
	deployOutcome: { status: string; error?: string; instance_log_id?: string; rollback?: string };
	instanceLogs: { id: string; deployment_id?: string; lines: string[] }[];
	/** Marcos SSE crudos del stream de logs. */
	logFrames: string[];
	/** Deja el stream abierto después de los marcos, para probar el corte por tiempo. */
	logStaysOpen: boolean;
}

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const JOB_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEDULE = /^\S+ \S+ \S+ \S+ \S+$/;

type Variable = { name: string; secret: boolean; value: string | null };

function environmentOf(params: Record<string, string>, mock: MockOmi): Record<string, unknown> & { variables: Variable[] } {
	const service = requireServiceFor(params, mock);
	const environment = service.view.environments.find((candidate) => candidate.name === params.environmentName);
	if (environment === undefined) throw new Problem(404, "environment_not_found", "el ambiente no existe");
	return environment as Record<string, unknown> & { variables: Variable[] };
}

function setVariables(request: MockRequest, params: Record<string, string>, mock: MockOmi, state: WorkloadState): MockResponse {
	requireSessionFor(request, mock);
	const environment = environmentOf(params, mock);
	const body = strictBodyOf(request, ["variables"]);
	const inputs = (body.variables ?? []) as { name: string; secret?: boolean; value?: string | null }[];
	const next: Variable[] = [];
	for (const input of inputs) {
		if (!VARIABLE_NAME.test(input.name)) throw new Problem(400, "invalid_variable_name", "nombre inválido");
		if (input.name === "PORT" || input.name.startsWith("OMI_")) throw new Problem(400, "reserved_variable", `${input.name} la inyecta OMI`);
		const value = input.value ?? null;
		const secret = input.secret === true;
		const previous = environment.variables.find((candidate) => candidate.name === input.name);
		if (value === null && !(secret && previous?.secret === true)) {
			throw new Problem(400, "variable_value_required", `${input.name} necesita un valor`);
		}
		if (secret && value !== null) state.secrets.set(`${params.environmentName}/${input.name}`, value);
		next.push({ name: input.name, secret, value: secret ? null : value });
	}
	environment.variables = next.sort((a, b) => a.name.localeCompare(b.name));
	return { status: 200, body: environment };
}

function jobView(job: Record<string, unknown>): Record<string, unknown> {
	return { ...job };
}

function jobEnvironments(mock: MockOmi, params: Record<string, string>, service: string): Record<string, unknown>[] {
	const view = requireProjectFor(params, mock).services.get(service)?.view;
	if (view === undefined) throw new Problem(404, "service_not_found", "el service no existe");
	return view.environments.map((environment) => ({
		name: environment.name,
		deployed: environment.current_version !== undefined,
		paused: false,
		last_run: null,
	}));
}

function saveJob(request: MockRequest, params: Record<string, string>, mock: MockOmi, state: WorkloadState, name: string): Record<string, unknown> {
	const body = strictBodyOf(request, ["name", "service", "path", "schedule", "timezone", "timeout_seconds"]);
	if (!JOB_NAME.test(name)) throw new Problem(400, "invalid_job_name", "nombre inválido");
	if (!String(body.path).startsWith("/")) throw new Problem(400, "invalid_job_path", "path inválido");
	if (!SCHEDULE.test(String(body.schedule))) throw new Problem(400, "invalid_schedule", "cron inválido");
	const timezone = String(body.timezone ?? "") || "UTC";
	const timeout = Number(body.timeout_seconds ?? 0) || 600;
	const service = String(body.service);
	const job = {
		name,
		service,
		path: body.path,
		schedule: body.schedule,
		timezone,
		timeout_seconds: timeout,
		environments: jobEnvironments(mock, params, service),
		created_at: "2026-09-21T12:00:00Z",
	};
	state.jobs.set(name, job);
	return job;
}

function requireJob(state: WorkloadState, params: Record<string, string>): Record<string, unknown> {
	const job = state.jobs.get(params.jobName ?? "");
	if (job === undefined) throw new Problem(404, "job_not_found", "el job no existe");
	return job;
}

function createPreview(request: MockRequest, params: Record<string, string>, mock: MockOmi, state: WorkloadState): MockResponse {
	requireSessionFor(request, mock);
	requireProjectFor(params, mock);
	const body = strictBodyOf(request, ["action", "resource_id", "environment", "slug", "connection", "mode", "version", "size", "disk_gib"]);
	const action = String(body.action);
	const resource = body.resource_id === undefined ? undefined : state.resources.get(String(body.resource_id));
	if (action !== "create" && resource === undefined) throw new Problem(404, "resource_not_found", "el recurso no existe");
	const mode = String(body.mode ?? resource?.mode ?? "externa");
	if (action === "create" && mode === "externa" && body.connection === undefined) {
		throw new Problem(400, "invalid_postgres_connection", "conexión inválida");
	}
	if (action === "create" && mode === "local" && body.connection !== undefined) {
		throw new Problem(400, "invalid_resource_connection", "una base local no lleva conexión");
	}
	if (action === "delete" && body.connection !== undefined) {
		throw new Problem(400, "invalid_resource_connection", "una baja no lleva conexión");
	}
	const slug = String(body.slug ?? resource?.slug);
	const environment = String(body.environment ?? resource?.environment);
	const variable = `POSTGRES_URL_${slug.toUpperCase().replaceAll("-", "_")}`;
	const id = `rpv_${state.previews.size + 1}`;
	const view = {
		id,
		action,
		resource_id: resource?.id ?? "",
		environment,
		slug,
		variable,
		services: [
			{
				name: "api",
				environment_id: "env_api_stage",
				version: "1.0.0",
				digest: "sha256:aaa",
				pending_configuration: state.pendingConfiguration,
				changes: [{ name: variable, secret: true, change: action === "delete" ? "retirada" : "nueva" }],
			},
		],
		pending_configuration: state.pendingConfiguration,
		expires_at: "2026-09-21T12:15:00Z",
		mode,
	};
	state.previews.set(id, view);
	return { status: 201, body: view };
}

function confirmPreview(request: MockRequest, params: Record<string, string>, mock: MockOmi, state: WorkloadState): MockResponse {
	requireSessionFor(request, mock);
	requireProjectFor(params, mock);
	const preview = state.previews.get(params.previewID ?? "");
	if (preview === undefined) throw new Problem(404, "preview_not_found", "la vista previa no existe");
	const body = strictBodyOf(request, ["include_pending_configuration", "confirmation_name"]);
	if (preview.pending_configuration === true && body.include_pending_configuration !== true) {
		throw new Problem(409, "pending_configuration_confirmation_required", "hay configuración pendiente");
	}
	if (preview.action === "delete" && body.confirmation_name !== preview.slug) {
		throw new Problem(409, "confirmation_name_required", "escribí el nombre del recurso");
	}
	const id = `rop_${state.operations.size + 1}`;
	const resourceID = String(preview.resource_id || `res_${preview.slug}`);
	const view = {
		id,
		resource_id: resourceID,
		slug: preview.slug,
		environment: preview.environment,
		action: preview.action,
		state: "probando",
		services: [],
		created_at: "2026-09-21T12:00:00Z",
	};
	state.operations.set(id, { view, polls: 0, terminal: state.operationOutcome });
	if (preview.action === "delete") state.resources.delete(resourceID);
	else {
		state.resources.set(resourceID, {
			id: resourceID,
			environment: preview.environment,
			slug: preview.slug,
			category: "relacional",
			engine: "postgres",
			mode: preview.mode,
			variable: preview.variable,
			state: "lista",
			revision: 1,
			active_revision: 1,
			created_at: "2026-09-21T12:00:00Z",
		});
	}
	return { status: 202, body: { operation_id: id, state: "probando" } };
}

function deploymentView(service: string, environment: string, from: string | undefined, to: string, id: string, created: string): Record<string, unknown> {
	return {
		id,
		service,
		environment,
		...(from === undefined ? {} : { from_version: from }),
		to_version: to,
		strategy: "rolling",
		status: "en_curso",
		requested_by: "Ada",
		automatic: false,
		steps: [{ kind: "inicio", at: created }],
		target_instances: 1,
		created_at: created,
	};
}

function advance(deployment: Record<string, unknown>, state: WorkloadState, environment: Record<string, unknown>): void {
	if (deployment.status !== "en_curso") return;
	const steps = deployment.steps as { kind: string; instance?: string; at: string }[];
	const next = state.deploySteps[steps.length - 1];
	if (next !== undefined) {
		steps.push({ ...next, at: "2026-09-21T12:00:05Z" });
		return;
	}
	steps.push({ kind: "fin", at: "2026-09-21T12:00:09Z" });
	Object.assign(deployment, state.deployOutcome);
	if (state.deployOutcome.status === "exitoso") {
		environment.current_version = deployment.to_version;
		environment.state = "corriendo";
	}
}

function installDeployments(mock: MockOmi, state: WorkloadState): void {
	const service = "/api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}";
	const env = `${service}/environments/{environmentName}`;
	const key = (params: Record<string, string>): string => `${params.serviceName}/${params.environmentName}`;

	mock.route(`POST ${service}/versions/refresh`, (request, params) => {
		requireSessionFor(request, mock);
		strictBodyOf(request, []);
		const view = requireServiceFor(params, mock).view;
		const versions = view.versions as { tag: string }[];
		if (state.scan !== null) {
			state.scan.refreshes += 1;
			if (state.scan.refreshes >= state.scan.afterRefreshes && !versions.some((version) => version.tag === state.scan?.tag)) {
				versions.unshift({ tag: state.scan.tag });
			}
		}
		return { status: 200, body: { versions } };
	});
	mock.route(`POST ${env}/deployments`, (request, params) => {
		requireSessionFor(request, mock);
		const environment = environmentOf(params, mock) as Record<string, unknown>;
		const body = strictBodyOf(request, ["version", "strategy"]);
		const versions = requireServiceFor(params, mock).view.versions as { tag: string }[];
		if (!versions.some((version) => version.tag === body.version)) throw new Problem(404, "version_not_found", "la versión no existe");
		const list = state.deployments.get(key(params)) ?? [];
		if (list.some((deployment) => deployment.status === "en_curso")) throw new Problem(409, "deployment_in_progress", "ya hay un deploy en curso");
		const deployment = deploymentView(params.serviceName ?? "", params.environmentName ?? "", environment.current_version as string | undefined, String(body.version), `dep_${list.length + 1}`, "2026-09-21T12:00:00Z");
		list.unshift(deployment);
		state.deployments.set(key(params), list);
		return mock.queued(202, deployment);
	});
	mock.route(`GET ${env}/deployments`, (request, params) => {
		requireSessionFor(request, mock);
		const environment = environmentOf(params, mock) as Record<string, unknown>;
		const list = state.deployments.get(key(params)) ?? [];
		for (const deployment of list) advance(deployment, state, environment);
		return { status: 200, body: { deployments: list } };
	});
	mock.route(`GET ${env}/instance-logs`, (request, params) => {
		requireSessionFor(request, mock);
		environmentOf(params, mock);
		const instance_logs = state.instanceLogs.map(({ lines: _lines, ...log }) => instanceLogView(log));
		return { status: 200, body: { instance_logs } };
	});
	mock.route(`GET ${env}/instance-logs/{instanceLogID}`, (request, params) => {
		requireSessionFor(request, mock);
		const log = state.instanceLogs.find((candidate) => candidate.id === params.instanceLogID);
		if (log === undefined) throw new Problem(404, "instance_log_not_found", "no existe");
		const { lines, ...rest } = log;
		return { status: 200, body: { ...instanceLogView(rest), lines } };
	});
	mock.route(`GET ${env}/logs`, (request, params) => {
		requireSessionFor(request, mock);
		environmentOf(params, mock);
		return {
			status: 200,
			stream: (response) => {
				response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
				for (const frame of state.logFrames) response.write(frame);
				if (!state.logStaysOpen) response.end();
			},
		};
	});
}

function instanceLogView(log: { id: string; deployment_id?: string }): Record<string, unknown> {
	return { ...log, pod: "api-abc", container: "app", reason: "deploy_fallido", exit_code: 1, restart_count: 2, finished_at: "2026-09-21T12:00:00Z", captured_at: "2026-09-21T12:00:01Z" };
}

export function installWorkloads(mock: MockOmi): WorkloadState {
	const state: WorkloadState = {
		secrets: new Map(),
		jobs: new Map(),
		resources: new Map(),
		previews: new Map(),
		operations: new Map(),
		operationOutcome: "exitoso",
		pendingConfiguration: false,
		scan: null,
		deployments: new Map(),
		deploySteps: [
			{ kind: "instancia_creada", instance: "api-abc" },
			{ kind: "instancia_lista", instance: "api-abc" },
			{ kind: "instancia_bajada", instance: "api-old" },
		],
		deployOutcome: { status: "exitoso" },
		instanceLogs: [],
		logFrames: ["retry: 3000\n\n", "event: attached\ndata: 1\n\n"],
		logStaysOpen: false,
	};
	installDeployments(mock, state);
	const env = "/api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/environments/{environmentName}";
	const project = "/api/v1/organizations/{organizationID}/projects/{projectSlug}";

	mock.route(`PUT ${env}/variables`, (request, params) => setVariables(request, params, mock, state));

	mock.route(`GET ${project}/jobs`, (request, params) => {
		requireSessionFor(request, mock);
		requireProjectFor(params, mock);
		return { status: 200, body: { jobs: [...state.jobs.values()].map(jobView) } };
	});
	mock.route(`POST ${project}/jobs`, (request, params) => {
		requireSessionFor(request, mock);
		requireProjectFor(params, mock);
		const name = String((request.body as { name?: string } | undefined)?.name);
		if (state.jobs.has(name)) throw new Problem(409, "job_name_exists", "ya existe");
		return { status: 201, body: saveJob(request, params, mock, state, name) };
	});
	mock.route(`GET ${project}/jobs/{jobName}`, (request, params) => {
		requireSessionFor(request, mock);
		return { status: 200, body: requireJob(state, params) };
	});
	mock.route(`PUT ${project}/jobs/{jobName}`, (request, params) => {
		requireSessionFor(request, mock);
		requireJob(state, params);
		return { status: 200, body: saveJob(request, params, mock, state, params.jobName ?? "") };
	});
	mock.route(`DELETE ${project}/jobs/{jobName}`, (request, params) => {
		requireSessionFor(request, mock);
		requireJob(state, params);
		state.jobs.delete(params.jobName ?? "");
		return { status: 204 };
	});
	mock.route(`GET ${project}/jobs/{jobName}/runs`, (request, params) => {
		requireSessionFor(request, mock);
		requireJob(state, params);
		if (!/[?&]environment=(prod|stage)/.test(request.path)) throw new Problem(404, "environment_not_found", "el ambiente no existe");
		return { status: 200, body: { runs: [] } };
	});
	mock.route(`POST ${project}/jobs/{jobName}/environments/{environmentName}/run`, (request, params) => {
		requireSessionFor(request, mock);
		requireJob(state, params);
		strictBodyOf(request, []);
		return { status: 202, body: { id: "run_1", environment: params.environmentName, state: "pendiente", started_at: "2026-09-21T12:00:00Z", manual: true } };
	});
	for (const verb of ["pause", "resume"] as const) {
		mock.route(`POST ${project}/jobs/{jobName}/environments/{environmentName}/${verb}`, (request, params) => {
			requireSessionFor(request, mock);
			const job = requireJob(state, params);
			strictBodyOf(request, []);
			for (const environment of job.environments as { name: string; paused: boolean }[]) {
				if (environment.name === params.environmentName) environment.paused = verb === "pause";
			}
			return { status: 200, body: job };
		});
	}

	mock.route(`GET ${project}/resources`, (request, params) => {
		requireSessionFor(request, mock);
		requireProjectFor(params, mock);
		const environment = /[?&]environment=(prod|stage)/.exec(request.path)?.[1];
		const resources = [...state.resources.values()].filter((resource) => environment === undefined || resource.environment === environment);
		return { status: 200, body: { resources } };
	});
	mock.route(`POST ${project}/resource-previews`, (request, params) => createPreview(request, params, mock, state));
	mock.route(`POST ${project}/resource-previews/{previewID}/confirm`, (request, params) => confirmPreview(request, params, mock, state));
	mock.route(`GET ${project}/resource-operations/{operationID}`, (request, params) => {
		requireSessionFor(request, mock);
		const operation = state.operations.get(params.operationID ?? "");
		if (operation === undefined) throw new Problem(404, "resource_operation_not_found", "no existe");
		operation.polls += 1;
		operation.view.state = operation.polls < 2 ? "aplicando" : operation.terminal;
		if (operation.terminal === "fallido" && operation.polls >= 2) operation.view.error = "SELECT 1 falló";
		return { status: 200, body: operation.view };
	});
	return state;
}
