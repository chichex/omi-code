// Contexto común de una tool: sesión, vínculo del repo y rutas del proyecto.

import type { OmiClient } from "../client/http.ts";
import { openSession, resolveOrganization } from "../client/session.ts";
import { ServiceSchema, type EnvironmentView, type ServiceView } from "../client/views.ts";
import { OmiError, UsageError } from "../core/errors.ts";
import { readProjectLink, type ProjectLink, type ServiceLink } from "../project/link.ts";
import type { ToolRuntime } from "./types.ts";

export interface Scope {
	client: OmiClient;
	link: ProjectLink;
	projectPath: string;
}

export async function openScope(runtime: ToolRuntime): Promise<Scope> {
	const link = await readProjectLink(runtime.io.cwd);
	const { client } = await openSession(runtime.io, runtime.apiUrl);
	const organization = await resolveOrganization(client, link.organizationSlug);
	const projectPath = `/organizations/${encodeURIComponent(organization.organization_id)}/projects/${encodeURIComponent(link.projectSlug)}`;
	return { client, link, projectPath };
}

/** Sin nombre sólo se resuelve si el repo tiene un único service. */
export function linkedService(link: ProjectLink, name: string | undefined): ServiceLink {
	if (name === undefined) {
		const [only, ...others] = link.services;
		if (only !== undefined && others.length === 0) return only;
		throw new UsageError("este repo tiene varios services: indicá cuál", link.services.map((service) => service.name).join(", "));
	}
	const service = link.services.find((candidate) => candidate.name === name);
	if (service === undefined) throw new UsageError(`el service ${name} no está en .omi/project.json`);
	return service;
}

export function servicePath(scope: Scope, service: string): string {
	return `${scope.projectPath}/services/${encodeURIComponent(service)}`;
}

export function environmentPath(scope: Scope, service: string, environment: string): string {
	return `${servicePath(scope, service)}/environments/${encodeURIComponent(environment)}`;
}

export function readService(scope: Scope, service: string): Promise<ServiceView> {
	return scope.client.request("GET", servicePath(scope, service), ServiceSchema);
}

export function environmentOf(service: ServiceView, name: string): EnvironmentView {
	const environment = service.environments.find((candidate) => candidate.name === name);
	if (environment === undefined) {
		throw new OmiError("environment_not_found", `el service ${service.name} no tiene el ambiente ${name}`);
	}
	return environment;
}
