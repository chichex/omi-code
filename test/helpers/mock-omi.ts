// Doble de omi-api: reproduce el contrato de chichex/omi en un puerto efímero.
// Copia sus reglas: JSON estricto, errores { error: { code, message } } y 404/405 en texto.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { renderKit } from "./kit.ts";

export interface MockRequest {
	method: string;
	path: string;
	body: unknown;
	authorization: string | undefined;
	idempotencyKey: string | undefined;
	/** Valor de X-Omi-Session-Token: con `body`, el login entrega el token en el cuerpo. */
	sessionToken: string | undefined;
}

export interface MockResponse {
	status: number;
	body?: unknown;
	/** Texto plano en vez de JSON, como los 404 y 405 de http.ServeMux. */
	text?: string;
	headers?: Record<string, string>;
	/** Respuesta en streaming: escribe directo sobre la conexión. */
	stream?: (response: ServerResponse) => void;
}

export class Problem {
	readonly status: number;
	readonly code: string;
	readonly message: string;

	constructor(status: number, code: string, message: string) {
		this.status = status;
		this.code = code;
		this.message = message;
	}
}

interface Params {
	[key: string]: string;
}

export type RouteHandler = (request: MockRequest, params: Params, mock: MockOmi) => MockResponse | Promise<MockResponse>;

export interface MockService {
	view: Record<string, unknown> & { name: string; environments: Record<string, unknown>[] };
}

export interface MockProject {
	id: string;
	name: string;
	slug: string;
	services: Map<string, MockService>;
}

export interface MockOmi {
	readonly url: string;
	readonly requests: MockRequest[];
	readonly projects: Map<string, MockProject>;
	readonly sessions: Map<string, "active" | "expired">;
	readonly organization: { organization_id: string; name: string; slug: string; role: string };
	/** Registra o pisa una ruta: `GET /api/v1/...{param}`. */
	route(spec: string, handler: RouteHandler): void;
	/** Hace que las próximas N mutaciones en cola respondan con recibo 202. */
	queueNext(count: number): void;
	/** Responde el éxito, o el recibo 202 si hay mutaciones en cola pendientes. */
	queued(status: number, body: unknown): MockResponse;
	close(): Promise<void>;
}

const PASSWORD = "correct horse battery";
export const MOCK_EMAIL = "ada@omi.test";
export const MOCK_PASSWORD = PASSWORD;

function principal(mock: MockOmi): Record<string, unknown> {
	return { user_id: "usr_ada", name: "Ada", email: MOCK_EMAIL, organizations: [mock.organization] };
}

function requireSession(request: MockRequest, mock: MockOmi): void {
	const header = request.authorization;
	if (header === undefined) throw new Problem(401, "authentication_required", "se requiere una sesión");
	const match = /^Bearer (.+)$/.exec(header);
	if (match?.[1] === undefined) throw new Problem(401, "authentication_required", "se requiere una sesión");
	const session = mock.sessions.get(match[1]);
	if (session === undefined) throw new Problem(401, "authentication_required", "se requiere una sesión");
	if (session === "expired") throw new Problem(401, "session_expired", "la sesión venció");
}

function requireOrganization(params: Params, mock: MockOmi): void {
	if (params.organizationID !== mock.organization.organization_id) {
		throw new Problem(404, "organization_not_found", "la organización no existe");
	}
}

function requireProject(params: Params, mock: MockOmi): MockProject {
	requireOrganization(params, mock);
	const project = mock.projects.get(params.projectSlug ?? "");
	if (project === undefined) throw new Problem(404, "project_not_found", "el proyecto no existe");
	return project;
}

function requireService(params: Params, mock: MockOmi): MockService {
	const service = requireProject(params, mock).services.get(params.serviceName ?? "");
	if (service === undefined) throw new Problem(404, "service_not_found", "el service no existe");
	return service;
}

function strictBody(request: MockRequest, allowed: readonly string[]): Record<string, unknown> {
	const body = request.body;
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Problem(400, "invalid_json", "el cuerpo JSON no es válido");
	}
	for (const key of Object.keys(body)) {
		if (!allowed.includes(key)) throw new Problem(400, "invalid_json", "el cuerpo JSON no es válido");
	}
	return body as Record<string, unknown>;
}

export function environmentView(name: string, serviceName: string, org: string, project: string): Record<string, unknown> {
	return {
		id: `env_${serviceName}_${name}`,
		name,
		namespace: `${org}-${project}-${name}`,
		region: "ar-bue",
		size: "M",
		min_instances: name === "prod" ? 2 : 1,
		max_instances: name === "prod" ? 2 : 1,
		visibility: "privado",
		hostname: `${serviceName}-${name}-${org}.ohmyinfra.test`,
		state: "sin_version",
		variables: [],
		managed_variables: [],
		visibility_apply: { state: "aplicada" },
		access: { state: "pendiente" },
		...(name === "prod" ? { promotion: { blocked_reason: "stage_missing" } } : {}),
		created_at: "2026-09-21T12:00:00Z",
	};
}

export function serviceView(project: MockProject, name: string, port: number, environment: string, org: string): MockService {
	return {
		view: {
			id: `svc_${name}`,
			name,
			port,
			project: { name: project.name, slug: project.slug },
			repository: `${org}/${project.slug}/${name}`,
			auto_publish_stage: false,
			environments: [environmentView(environment, name, org, project.slug)],
			versions: [],
			version_scan: { state: "sin_barrido", last_attempt_at: null, last_complete_at: null, failed_services: 0, interval_seconds: 60 },
			kit: renderKit(org, project.slug, name, port),
			created_at: "2026-09-21T12:00:00Z",
			state: "activo",
		},
	};
}

function projectView(project: MockProject): Record<string, unknown> {
	return {
		id: project.id,
		name: project.name,
		slug: project.slug,
		created_at: "2026-09-21T12:00:00Z",
		services: [...project.services.values()].map((service) => ({
			name: service.view.name,
			state: "activo",
			port: service.view.port,
			environments: service.view.environments.map((environment) => ({
				name: environment.name,
				state: environment.state,
				visibility: environment.visibility,
				hostname: environment.hostname,
			})),
		})),
		state: "activo",
	};
}

interface QueueState {
	pending: number;
	nextReceipt: number;
	receipts: Map<string, { state: string; result?: unknown; polls: number }>;
}

const SERVICE_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function queuedResponder(queue: QueueState): (status: number, body: unknown) => MockResponse {
	return (status, body) => {
		if (queue.pending === 0) return { status, body };
		queue.pending -= 1;
		queue.nextReceipt += 1;
		const id = `mutation_${queue.nextReceipt}`;
		queue.receipts.set(id, { state: "en_espera", result: body, polls: 0 });
		return { status: 202, body: { mutation_id: id, state: "en_espera" } };
	};
}

function baseRoutes(queue: QueueState): [string, RouteHandler][] {
	const maybeQueued = queuedResponder(queue);
	return [
		[
			"POST /api/v1/sessions",
			(request, _params, mock) => {
				const body = strictBody(request, ["email", "password"]);
				if (String(body.email).trim().toLowerCase() !== MOCK_EMAIL || body.password !== PASSWORD) {
					throw new Problem(401, "invalid_credentials", "email o contraseña incorrectos");
				}
				const token = `prs_${mock.sessions.size + 1}`;
				mock.sessions.set(token, "active");
				// Como omi-api: la sesión se abre siempre, pero el token sólo viaja a quien lo pide.
				const requested = request.sessionToken?.trim().toLowerCase() === "body";
				return { status: 200, body: { ...principal(mock), ...(requested ? { token } : {}), expires_at: "2026-11-12T00:00:00Z" } };
			},
		],
		[
			"DELETE /api/v1/sessions/current",
			(request, _params, mock) => {
				const token = request.authorization?.replace(/^Bearer /, "");
				if (token !== undefined) mock.sessions.delete(token);
				return { status: 204 };
			},
		],
		[
			"GET /api/v1/me",
			(request, _params, mock) => {
				requireSession(request, mock);
				return { status: 200, body: principal(mock) };
			},
		],
		[
			"GET /api/v1/organizations/{organizationID}/projects/{projectSlug}",
			(request, params, mock) => {
				requireSession(request, mock);
				return { status: 200, body: projectView(requireProject(params, mock)) };
			},
		],
		[
			"POST /api/v1/organizations/{organizationID}/projects",
			(request, params, mock) => {
				requireSession(request, mock);
				requireOrganization(params, mock);
				const body = strictBody(request, ["name", "slug"]);
				const slug = String(body.slug);
				if (!SLUG.test(slug)) throw new Problem(400, "invalid_project_slug", "slug inválido");
				if (mock.projects.has(slug)) throw new Problem(409, "project_slug_exists", "ya existe un proyecto con ese slug");
				const project: MockProject = { id: `prj_${slug}`, name: String(body.name), slug, services: new Map() };
				mock.projects.set(slug, project);
				return { status: 201, body: projectView(project) };
			},
		],
		[
			"GET /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}",
			(request, params, mock) => {
				requireSession(request, mock);
				return { status: 200, body: requireService(params, mock).view };
			},
		],
		[
			"POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services",
			(request, params, mock) => {
				requireSession(request, mock);
				const project = requireProject(params, mock);
				const body = strictBody(request, ["name", "port", "environment"]);
				const name = String(body.name);
				if (!SERVICE_NAME.test(name)) throw new Problem(400, "invalid_service_name", "nombre inválido");
				const environment = body.environment as { name?: string } | undefined;
				if (environment?.name !== "prod" && environment?.name !== "stage") {
					throw new Problem(400, "invalid_environment", "ambiente inválido");
				}
				if (project.services.has(name)) throw new Problem(409, "service_name_exists", "ya existe");
				const service = serviceView(project, name, Number(body.port), environment.name, mock.organization.slug);
				project.services.set(name, service);
				return maybeQueued(201, service.view);
			},
		],
		[
			"POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/environments",
			(request, params, mock) => {
				requireSession(request, mock);
				const service = requireService(params, mock);
				const body = strictBody(request, ["name", "region", "size", "min_instances", "max_instances", "visibility"]);
				const name = String(body.name);
				if (name !== "prod" && name !== "stage") throw new Problem(400, "invalid_environment", "ambiente inválido");
				if (service.view.environments.some((environment) => environment.name === name)) {
					throw new Problem(409, "environment_exists", "el ambiente ya existe");
				}
				const view = environmentView(name, service.view.name, mock.organization.slug, params.projectSlug ?? "");
				service.view.environments.push(view);
				return maybeQueued(201, view);
			},
		],
		[
			"GET /api/v1/organizations/{organizationID}/projects/{projectSlug}/queued-mutations/{mutationID}",
			(request, params, mock) => {
				requireSession(request, mock);
				const receipt = queue.receipts.get(params.mutationID ?? "");
				if (receipt === undefined) throw new Problem(404, "queued_mutation_not_found", "no existe");
				receipt.polls += 1;
				if (receipt.polls < 2) return { status: 200, body: { mutation_id: params.mutationID, state: "en_curso" } };
				return { status: 200, body: { mutation_id: params.mutationID, state: "exitosa", result: receipt.result } };
			},
		],
	];
}

export const requireSessionFor = requireSession;
export const requireProjectFor = requireProject;
export const requireServiceFor = requireService;
export const strictBodyOf = strictBody;

function compile(spec: string): { method: string; pattern: RegExp; names: string[] } {
	const [method = "", path = ""] = spec.split(" ");
	const names: string[] = [];
	const source = path.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
		names.push(name);
		return "([^/]+)";
	});
	return { method, pattern: new RegExp(`^${source}$`), names };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return Symbol.for("invalid-json");
	}
}

function send(response: ServerResponse, reply: MockResponse): void {
	if (reply.stream !== undefined) {
		reply.stream(response);
		return;
	}
	if (reply.text !== undefined) {
		response.writeHead(reply.status, { "Content-Type": "text/plain; charset=utf-8", ...reply.headers });
		response.end(`${reply.text}\n`);
		return;
	}
	if (reply.body === undefined) {
		response.writeHead(reply.status, reply.headers);
		response.end();
		return;
	}
	response.writeHead(reply.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...reply.headers });
	response.end(`${JSON.stringify(reply.body)}\n`);
}

export async function startMockOmi(t: TestContext): Promise<MockOmi> {
	const queue: QueueState = { pending: 0, nextReceipt: 0, receipts: new Map() };
	const routes = new Map<string, { spec: ReturnType<typeof compile>; handler: RouteHandler }>();
	const addRoute = (spec: string, handler: RouteHandler): void => {
		routes.set(spec, { spec: compile(spec), handler });
	};
	for (const [spec, handler] of baseRoutes(queue)) addRoute(spec, handler);

	const mock: MockOmi = {
		url: "",
		requests: [],
		projects: new Map(),
		sessions: new Map(),
		organization: { organization_id: "org_acme", name: "Acme", slug: "acme", role: "dueño" },
		route: addRoute,
		queueNext: (count) => {
			queue.pending = count;
		},
		queued: queuedResponder(queue),
		close: async () => {},
	};

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://mock");
			const body = await readBody(request);
			const recorded: MockRequest = {
				method: request.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				body,
				authorization: request.headers.authorization,
				idempotencyKey: request.headers["idempotency-key"] as string | undefined,
				sessionToken: request.headers["x-omi-session-token"] as string | undefined,
			};
			mock.requests.push(recorded);
			let pathMatched = false;
			const allowed: string[] = [];
			for (const { spec, handler } of routes.values()) {
				const match = spec.pattern.exec(url.pathname);
				if (match === null) continue;
				pathMatched = true;
				allowed.push(spec.method);
				if (spec.method !== recorded.method) continue;
				const params: Params = {};
				spec.names.forEach((name, index) => {
					params[name] = decodeURIComponent(match[index + 1] ?? "");
				});
				try {
					if (body === Symbol.for("invalid-json")) throw new Problem(400, "invalid_json", "el cuerpo JSON no es válido");
					send(response, await handler(recorded, params, mock));
				} catch (error) {
					if (!(error instanceof Problem)) throw error;
					send(response, { status: error.status, body: { error: { code: error.code, message: error.message } } });
				}
				return;
			}
			if (pathMatched) {
				send(response, { status: 405, text: "Method Not Allowed", headers: { Allow: allowed.join(", ") } });
				return;
			}
			send(response, { status: 404, text: "404 page not found" });
		})().catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const started: MockOmi = {
		...mock,
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
	t.after(() => {
		server.closeAllConnections();
		return started.close();
	});
	return started;
}
