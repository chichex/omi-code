// Rutas de hosts, registry y visibilidad del doble de omi-api, con los códigos de chichex/omi.

import { Problem, requireServiceFor, requireSessionFor, strictBodyOf, type MockOmi } from "./mock-omi.ts";

export interface PlatformState {
	hosts: Record<string, unknown>[];
	registry: Record<string, unknown> | null;
	/** Lo que devuelve el alta una única vez: sólo para comprobar que no se filtra. */
	pushPassword: string;
	/** Resultado de publicar el hostname del registry en Cloudflare. */
	routeOutcome: "publicada" | "error";
	/** Estado en el que termina el bundle de visibilidad de un ambiente con versión. */
	visibilityOutcome: { state: "aplicada" | "fallida"; last_error?: string };
	/** Problema con el que responde el próximo PUT de visibilidad. */
	visibilityProblem: Problem | null;
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
		return { status: 200, body: requireRegistry(state) };
	});
	mock.route(`POST ${org}/registry`, (request, params) => {
		requireSessionFor(request, mock);
		requireOrganization(params, mock);
		const body = strictBodyOf(request, ["host_id"]);
		if (state.registry !== null) throw new Problem(409, "registry_exists", "la organización ya tiene registry");
		const host = state.hosts.find((candidate) => candidate.id === body.host_id);
		if (host === undefined) throw new Problem(404, "host_not_found", "el host no existe");
		if (host.registry_eligible !== true) throw new Problem(409, "host_not_registry_eligible", "el host todavía no fue aprobado");
		state.registry = registryView(mock, host, state);
		return { status: 201, body: { registry: state.registry, push_password: state.pushPassword } };
	});
	mock.route(`POST ${org}/registry/route`, (request, params) => {
		requireSessionFor(request, mock);
		requireOrganization(params, mock);
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

function installVisibility(mock: MockOmi, state: PlatformState): void {
	const service = "/api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}";
	// El bundle de visibilidad termina en el agente: la primera lectura posterior ya lo ve resuelto.
	mock.route(`GET ${service}`, (request, params) => {
		requireSessionFor(request, mock);
		const view = requireServiceFor(params, mock).view;
		const body = structuredClone(view);
		for (const environment of view.environments) {
			const apply = environment.visibility_apply as { state: string };
			if (apply.state === "aplicando") environment.visibility_apply = { ...state.visibilityOutcome };
		}
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
		environment.visibility = body.visibility;
		environment.access = { state: "pendiente" };
		environment.visibility_apply = { state: environment.current_version === undefined ? "aplicada" : "aplicando" };
		return mock.queued(200, structuredClone(environment));
	});
}

export function installPlatform(mock: MockOmi): PlatformState {
	const state: PlatformState = {
		hosts: [hostView("hst_cp")],
		registry: null,
		pushPassword: "push-clave-de-un-solo-uso",
		routeOutcome: "publicada",
		visibilityOutcome: { state: "aplicada" },
		visibilityProblem: null,
	};
	installRegistry(mock, state);
	installVisibility(mock, state);
	return state;
}
