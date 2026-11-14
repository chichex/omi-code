// Rutas de hosts, registry y visibilidad del doble de omi-api, con los códigos de chichex/omi.

import { Problem, requireServiceFor, requireSessionFor, strictBodyOf, type MockOmi } from "./mock-omi.ts";

export interface PlatformState {
	hosts: Record<string, unknown>[];
	registry: Record<string, unknown> | null;
	/** Lo que devuelve el alta una única vez: sólo para comprobar que no se filtra. */
	pushPassword: string;
	/**
	 * Falla del alta. CreateRegistry persiste y recién después publica la ruta y arma la respuesta:
	 * `after_persist` es su 500 con el registry ya creado, `connection_cut` la conexión que se corta
	 * en ese tramo, `without_password` una respuesta 201 que no trae la credencial, y `before_persist`
	 * un 500 anterior al guardado (bcrypt, sellado del secreto).
	 */
	createFault: "after_persist" | "connection_cut" | "without_password" | "before_persist" | null;
	/** Problema con el que responde el GET del registry: para cuando ni el estado se puede consultar. */
	registryReadProblem: Problem | null;
	/** Resultado de publicar el hostname del registry en Cloudflare. */
	routeOutcome: "publicada" | "error";
	/** Estado en el que termina el bundle de visibilidad de un ambiente con versión; `aplicando` no termina nunca. */
	visibilityOutcome: { state: "aplicada" | "fallida" | "aplicando"; last_error?: string };
	/** Problema con el que responde el próximo PUT de visibilidad. */
	visibilityProblem: Problem | null;
	/**
	 * Cómo termina el reconciliador de acceso de un ambiente con versión. Pasa por `aplicando`
	 * (bundle de ingress y publicación en Cloudflare) antes de llegar; `pendiente` no avanza nunca.
	 */
	accessOutcome: { state: "listo" } | { state: "fallido"; last_error: string; retry_at: string } | { state: "pendiente" };
	/**
	 * `Access.VisibilityRetry` de chichex/omi, por `service/ambiente`: un cambio de visibilidad que se
	 * deshizo y quedó para reintentar. La vista no lo muestra: sólo le quita `retry_at` al acceso fallido.
	 */
	visibilityRetry: Map<string, string>;
	/**
	 * Cambio reservado y todavía sin persistir, por `service/ambiente`: omi-api deja `aplicando` con la
	 * visibilidad anterior mientras trabaja en Cloudflare. La próxima lectura lo ve persistido.
	 */
	reservedVisibility: Map<string, string>;
}

const VISIBILITIES = ["privado", "organizacion", "publico"];

export function hostView(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: id.replace("hst_", ""),
		state: "disponible",
		provider: "hetzner",
		region: "ar-bue",
		control_plane_eligible: true,
		is_control_plane: true,
		approved: true,
		facts: { disk_free_bytes: 80 * 2 ** 30 },
		last_heartbeat_at: "2026-09-21T12:00:00Z",
		decommission: { state: "" },
		registry_eligible: true,
		...overrides,
	};
}

function registryView(mock: MockOmi, host: Record<string, unknown>, state: PlatformState): Record<string, unknown> {
	const failed = state.routeOutcome === "error";
	return {
		state: "aprovisionando",
		host_id: host.id,
		host_name: host.name,
		hostname: `registry-${mock.organization.slug}.ohmyinfra.test`,
		push_username: "ci-push",
		public_route: state.routeOutcome,
		...(failed ? { route_error: "Cloudflare respondió 403" } : {}),
		version_scan: { state: "sin_barrido", last_attempt_at: null, last_complete_at: null, failed_services: 0, interval_seconds: 60 },
		images: [],
		created_at: "2026-09-21T12:00:00Z",
	};
}

function requireOrganization(params: Record<string, string>, mock: MockOmi): void {
	if (params.organizationID !== mock.organization.organization_id) throw new Problem(404, "organization_not_found", "la organización no existe");
}

/** `requireRole(…, RoleOwner)` de chichex/omi: el alta y el reintento de ruta son del dueño. */
function requireOwner(params: Record<string, string>, mock: MockOmi): void {
	requireOrganization(params, mock);
	if (mock.organization.role !== "dueño") throw new Problem(403, "forbidden", "el rol no permite esta acción");
}

function requireRegistry(state: PlatformState): Record<string, unknown> {
	if (state.registry === null) throw new Problem(404, "registry_not_found", "la organización todavía no tiene registry");
	return state.registry;
}

function installRegistry(mock: MockOmi, state: PlatformState): void {
	const org = "/api/v1/organizations/{organizationID}";
	mock.route(`GET ${org}/hosts`, (request, params) => {
		requireSessionFor(request, mock);
		requireOrganization(params, mock);
		return { status: 200, body: { hosts: state.hosts } };
	});
	mock.route(`GET ${org}/registry`, (request, params) => {
		requireSessionFor(request, mock);
		requireOrganization(params, mock);
		if (state.registryReadProblem !== null) throw state.registryReadProblem;
		return { status: 200, body: requireRegistry(state) };
	});
	mock.route(`POST ${org}/registry`, (request, params) => {
		requireSessionFor(request, mock);
		requireOwner(params, mock);
		const body = strictBodyOf(request, ["host_id"]);
		if (state.registry !== null) throw new Problem(409, "registry_exists", "la organización ya tiene registry");
		const host = state.hosts.find((candidate) => candidate.id === body.host_id);
		if (host === undefined) throw new Problem(404, "host_not_found", "el host no existe");
		if (host.registry_eligible !== true) throw new Problem(409, "host_not_registry_eligible", "el host todavía no fue aprobado");
		if (state.createFault === "before_persist") throw new Problem(500, "internal_error", "ocurrió un error interno");
		state.registry = registryView(mock, host, state);
		if (state.createFault === "after_persist") throw new Problem(500, "internal_error", "ocurrió un error interno");
		if (state.createFault === "connection_cut") return { status: 0, stream: (response) => response.destroy() };
		if (state.createFault === "without_password") return { status: 201, body: { registry: state.registry } };
		return { status: 201, body: { registry: state.registry, push_password: state.pushPassword } };
	});
	mock.route(`POST ${org}/registry/route`, (request, params) => {
		requireSessionFor(request, mock);
		requireOwner(params, mock);
		strictBodyOf(request, []);
		const registry = requireRegistry(state);
		if (state.routeOutcome === "error") {
			throw new Problem(502, "hostname_publication_failed", `Cloudflare rechazó la ruta de ${String(registry.hostname)}: Cloudflare respondió 403`);
		}
		delete registry.route_error;
		registry.public_route = "publicada";
		return { status: 200, body: registry };
	});
}

type Environment = Record<string, unknown>;

/** persistReservedVisibilityChange: la visibilidad nueva, el acceso de cero y el bundle en cola si hay versión. */
function persistVisibility(environment: Environment, visibility: string): void {
	environment.visibility = visibility;
	environment.access = { state: "pendiente" };
	environment.visibility_apply = { state: environment.current_version === undefined ? "aplicada" : "aplicando" };
}

/** Lo que avanza solo entre dos lecturas: el job del agente y el reconciliador de acceso. */
function advance(environment: Environment, key: string, state: PlatformState): void {
	if (state.reservedVisibility.has(key)) return;
	const apply = environment.visibility_apply as { state: string } | undefined;
	if (apply?.state === "aplicando") {
		environment.visibility_apply = { ...state.visibilityOutcome };
		return;
	}
	// El reconciliador sólo toma ambientes con versión, sin reintento de visibilidad pendiente.
	const access = environment.access as { state: string };
	if (environment.current_version === undefined || state.visibilityRetry.has(key) || state.accessOutcome.state === "pendiente") return;
	if (access.state === "pendiente") environment.access = { state: "aplicando" };
	else if (access.state === "aplicando") environment.access = { ...state.accessOutcome };
}

/** Una reserva se alcanza a leer una vez con la visibilidad anterior; después queda persistida. */
function persistReserved(environment: Environment, key: string, state: PlatformState): void {
	const reserved = state.reservedVisibility.get(key);
	if (reserved === undefined) return;
	state.reservedVisibility.delete(key);
	persistVisibility(environment, reserved);
}

function installVisibility(mock: MockOmi, state: PlatformState): void {
	const service = "/api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}";
	mock.route(`GET ${service}`, (request, params) => {
		requireSessionFor(request, mock);
		const view = requireServiceFor(params, mock).view;
		for (const environment of view.environments) advance(environment, `${view.name}/${String(environment.name)}`, state);
		const body = structuredClone(view);
		for (const environment of view.environments) persistReserved(environment, `${view.name}/${String(environment.name)}`, state);
		return { status: 200, body };
	});
	mock.route(`PUT ${service}/environments/{environmentName}/visibility`, (request, params) => {
		requireSessionFor(request, mock);
		const environment = requireServiceFor(params, mock).view.environments.find((candidate) => candidate.name === params.environmentName);
		if (environment === undefined) throw new Problem(404, "environment_not_found", "el ambiente no existe");
		const body = strictBodyOf(request, ["visibility"]);
		if (!VISIBILITIES.includes(String(body.visibility))) {
			throw new Problem(400, "invalid_visibility", "la visibilidad debe ser privado, organizacion o publico");
		}
		if (state.visibilityProblem !== null) throw state.visibilityProblem;
		// validateVisibilityChange: un ambiente ocupado rechaza el pedido.
		const apply = environment.visibility_apply as { state: string };
		const access = environment.access as { state: string };
		if (apply.state === "aplicando") throw new Problem(409, "visibility_in_progress", "la visibilidad ya se está aplicando");
		if (access.state === "aplicando") throw new Problem(409, "access_in_progress", "el acceso se está aplicando");
		// planVisibilityChange: la misma visibilidad sólo es un pedido nuevo si falló el bundle o quedó un reintento.
		const key = `${params.serviceName}/${params.environmentName}`;
		const unchanged = environment.visibility === body.visibility && apply.state !== "fallida" && !state.visibilityRetry.has(key);
		if (!unchanged) {
			state.visibilityRetry.delete(key);
			persistVisibility(environment, String(body.visibility));
		}
		return mock.queued(200, structuredClone(environment));
	});
}

export function installPlatform(mock: MockOmi): PlatformState {
	const state: PlatformState = {
		hosts: [hostView("hst_cp")],
		registry: null,
		pushPassword: "push-clave-de-un-solo-uso",
		createFault: null,
		registryReadProblem: null,
		routeOutcome: "publicada",
		visibilityOutcome: { state: "aplicada" },
		visibilityProblem: null,
		accessOutcome: { state: "listo" },
		visibilityRetry: new Map(),
		reservedVisibility: new Map(),
	};
	installRegistry(mock, state);
	installVisibility(mock, state);
	return state;
}
