// Vincula el repo con OMI: resuelve o crea proyecto y services, y vuelca su kit.

import { Type, type Static } from "typebox";
import type { Io } from "../cli/io.ts";
import type { OmiClient } from "../client/http.ts";
import { openSession, resolveOrganization } from "../client/session.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { PublishKitSchema, writeKit, type KitFile } from "./kit.ts";
import { writeProjectLink, type ProjectLink, type ServiceLink } from "./link.ts";

const DEFAULT_PORT = 8080;
const DEFAULT_ENVIRONMENT = "stage";

const ProjectSchema = Type.Object({ id: Type.String(), slug: Type.String() });

const LinkedServiceSchema = Type.Object({
	name: Type.String(),
	port: Type.Integer(),
	kit: PublishKitSchema,
	environments: Type.Array(Type.Object({ name: Type.String() })),
});

const CreatedEnvironmentSchema = Type.Object({ name: Type.String() });

type LinkedService = Static<typeof LinkedServiceSchema>;

export interface ServiceRequest {
	name: string;
	path?: string;
	port?: number;
	dockerfile?: string;
}

export interface LinkRequest {
	organizationSlug?: string;
	projectSlug: string;
	projectName?: string;
	services: ServiceRequest[];
	environments?: string[];
	create?: boolean;
}

export interface LinkResult {
	link: ProjectLink;
	created: { project: boolean; services: string[] };
	kit: KitFile[];
	warnings: string[];
}

export interface LinkContext {
	io: Io;
	apiUrl?: string;
	/** La CLI interactiva confirma acá; sin esto, crear exige `create: true`. */
	confirmCreate?: (what: string) => Promise<boolean>;
	signal?: AbortSignal;
}

function isNotFound(error: unknown, code: string): boolean {
	return error instanceof ApiError && error.status === 404 && error.code === code;
}

async function mayCreate(request: LinkRequest, context: LinkContext, what: string): Promise<boolean> {
	if (request.create === true) return true;
	return (await context.confirmCreate?.(what)) ?? false;
}

function missing(what: string): OmiError {
	return new OmiError("link_target_missing", `${what} no existe en OMI`, { hint: "volvé a correr con --create para crearlo" });
}

async function ensureProject(client: OmiClient, base: string, request: LinkRequest, context: LinkContext): Promise<boolean> {
	const path = `${base}/projects/${encodeURIComponent(request.projectSlug)}`;
	try {
		await client.request("GET", path, ProjectSchema);
		return false;
	} catch (error) {
		if (!isNotFound(error, "project_not_found")) throw error;
	}
	if (!(await mayCreate(request, context, `el proyecto ${request.projectSlug}`))) {
		throw missing(`el proyecto ${request.projectSlug}`);
	}
	await client.request("POST", `${base}/projects`, ProjectSchema, {
		body: { name: request.projectName ?? request.projectSlug, slug: request.projectSlug },
	});
	return true;
}

async function createService(
	client: OmiClient,
	projectPath: string,
	service: ServiceRequest,
	environments: readonly string[],
): Promise<LinkedService> {
	const [first = DEFAULT_ENVIRONMENT, ...others] = environments;
	const created = await client.mutate("POST", `${projectPath}/services`, LinkedServiceSchema, {
		body: { name: service.name, port: service.port ?? DEFAULT_PORT, environment: { name: first } },
		projectPath,
	});
	for (const name of others) {
		await client.mutate("POST", `${projectPath}/services/${encodeURIComponent(service.name)}/environments`, CreatedEnvironmentSchema, {
			body: { name },
			projectPath,
		});
	}
	return created;
}

async function ensureService(
	client: OmiClient,
	projectPath: string,
	service: ServiceRequest,
	request: LinkRequest,
	context: LinkContext,
): Promise<{ view: LinkedService; created: boolean }> {
	try {
		const view = await client.request("GET", `${projectPath}/services/${encodeURIComponent(service.name)}`, LinkedServiceSchema);
		return { view, created: false };
	} catch (error) {
		if (!isNotFound(error, "service_not_found")) throw error;
	}
	if (!(await mayCreate(request, context, `el service ${service.name}`))) throw missing(`el service ${service.name}`);
	return { view: await createService(client, projectPath, service, request.environments ?? [DEFAULT_ENVIRONMENT]), created: true };
}

function toServiceLink(request: ServiceRequest, view: LinkedService): ServiceLink {
	if (request.port !== undefined && request.port !== view.port) {
		throw new OmiError("port_mismatch", `el service ${view.name} escucha en ${view.port} en OMI, no en ${request.port}`);
	}
	return { name: view.name, path: request.path ?? ".", port: view.port, dockerfile: request.dockerfile ?? "Dockerfile" };
}

export async function linkProject(request: LinkRequest, context: LinkContext): Promise<LinkResult> {
	const { client, credentials } = await openSession(context.io, context.apiUrl);
	const organizationSlug = request.organizationSlug ?? credentials.defaultOrganizationSlug;
	const organization = await resolveOrganization(client, organizationSlug);
	const base = `/organizations/${encodeURIComponent(organization.organization_id)}`;

	const createdProject = await ensureProject(client, base, request, context);
	const projectPath = `${base}/projects/${encodeURIComponent(request.projectSlug)}`;
	const services: { link: ServiceLink; view: LinkedService }[] = [];
	const createdServices: string[] = [];
	for (const service of request.services) {
		const { view, created } = await ensureService(client, projectPath, service, request, context);
		if (created) createdServices.push(view.name);
		services.push({ link: toServiceLink(service, view), view });
	}

	const link: ProjectLink = {
		version: 1,
		organizationSlug: organization.slug,
		projectSlug: request.projectSlug,
		services: services.map((service) => service.link),
	};
	const monorepo = services.length > 1;
	const kit: KitFile[] = [];
	const warnings: string[] = [];
	for (const service of services) {
		const report = await writeKit(context.io.cwd, service.view.kit, service.link, monorepo);
		kit.push(...report.files);
		warnings.push(...report.warnings);
	}
	await writeProjectLink(context.io.cwd, link);
	return { link, created: { project: createdProject, services: createdServices }, kit, warnings };
}
