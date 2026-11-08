// Vincula el repo con OMI: resuelve o crea proyecto y services, y vuelca su kit.

import { Type, type Static } from "typebox";
import type { Io } from "../cli/io.ts";
import type { OmiClient } from "../client/http.ts";
import { openSession, resolveOrganization } from "../client/session.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { adaptWorkflow, PublishKitSchema, verifyKit, writeKit, type KitFile } from "./kit.ts";
import { loadProjectLink, writeProjectLink, type ProjectLink, type ServiceLink } from "./link.ts";
import { validateLinkRequest } from "./preflight.ts";

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
	context.signal?.throwIfAborted();
	if (request.create === true) return true;
	const approved = (await context.confirmCreate?.(what)) ?? false;
	context.signal?.throwIfAborted();
	return approved;
}

function missing(what: string): OmiError {
	return new OmiError("link_target_missing", `${what} no existe en OMI`, { hint: "volvé a correr con --create para crearlo" });
}

async function ensureProject(client: OmiClient, base: string, request: LinkRequest, context: LinkContext): Promise<boolean> {
	const path = `${base}/projects/${encodeURIComponent(request.projectSlug)}`;
	try {
		await client.request("GET", path, ProjectSchema, context.signal === undefined ? {} : { signal: context.signal });
		return false;
	} catch (error) {
		if (!isNotFound(error, "project_not_found")) throw error;
	}
	if (!(await mayCreate(request, context, `el proyecto ${request.projectSlug}`))) {
		throw missing(`el proyecto ${request.projectSlug}`);
	}
	await client.request("POST", `${base}/projects`, ProjectSchema, {
		body: { name: request.projectName ?? request.projectSlug, slug: request.projectSlug },
		...(context.signal === undefined ? {} : { signal: context.signal }),
	});
	return true;
}

async function createService(
	client: OmiClient,
	projectPath: string,
	service: ServiceRequest,
	environments: readonly string[],
	signal?: AbortSignal,
): Promise<LinkedService> {
	const [first = DEFAULT_ENVIRONMENT, ...others] = environments;
	const created = await client.mutate("POST", `${projectPath}/services`, LinkedServiceSchema, {
		body: { name: service.name, port: service.port ?? DEFAULT_PORT, environment: { name: first } },
		...(signal === undefined ? {} : { signal }),
		projectPath,
	});
	for (const name of others) {
		await client.mutate("POST", `${projectPath}/services/${encodeURIComponent(service.name)}/environments`, CreatedEnvironmentSchema, {
			body: { name },
			...(signal === undefined ? {} : { signal }),
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
		const servicePath = `${projectPath}/services/${encodeURIComponent(service.name)}`;
		const view = await client.request("GET", servicePath, LinkedServiceSchema, context.signal === undefined ? {} : { signal: context.signal });
		for (const name of request.environments ?? []) {
			if (view.environments.some((env) => env.name === name)) continue;
			if (!(await mayCreate(request, context, `el ambiente ${name} de ${service.name}`))) throw missing(`el ambiente ${name} de ${service.name}`);
			await client.mutate("POST", `${servicePath}/environments`, CreatedEnvironmentSchema, {
				body: { name }, projectPath, ...(context.signal === undefined ? {} : { signal: context.signal }),
			});
			view.environments.push({ name });
		}
		return { view, created: false };
	} catch (error) {
		if (!isNotFound(error, "service_not_found")) throw error;
	}
	if (!(await mayCreate(request, context, `el service ${service.name}`))) throw missing(`el service ${service.name}`);
	return { view: await createService(client, projectPath, service, request.environments ?? [DEFAULT_ENVIRONMENT], context.signal), created: true };
}

function toServiceLink(request: ServiceRequest, view: LinkedService): ServiceLink {
	if (request.port !== undefined && request.port !== view.port) {
		throw new OmiError("port_mismatch", `el service ${view.name} escucha en ${view.port} en OMI, no en ${request.port}`);
	}
	return { name: view.name, path: request.path ?? ".", port: view.port, dockerfile: request.dockerfile ?? "Dockerfile" };
}

export async function linkProject(request: LinkRequest, context: LinkContext): Promise<LinkResult> {
	context.signal?.throwIfAborted();
	await validateLinkRequest(request, context.io.cwd);
	const previous = await loadProjectLink(context.io.cwd);
	if (previous !== null && (previous.projectSlug !== request.projectSlug || (request.organizationSlug !== undefined && previous.organizationSlug !== request.organizationSlug))) {
		throw new OmiError("project_link_conflict", "el repo ya está vinculado a otro proyecto u organización; no se reemplaza implícitamente");
	}
	request = { ...request, services: request.services.map((service) => ({ ...previous?.services.find((s) => s.name === service.name), ...service })) };
	const existing = previous?.services.filter((service) => !request.services.some((s) => s.name === service.name)) ?? [];
	await validateLinkRequest({ ...request, services: [...existing, ...request.services] }, context.io.cwd);
	const { client, credentials } = await openSession(context.io, context.apiUrl);
	const organizationSlug = request.organizationSlug ?? previous?.organizationSlug ?? credentials.defaultOrganizationSlug;
	const organization = await resolveOrganization(client, organizationSlug, context.signal);
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

	const merged = new Map(previous?.services.map((service) => [service.name, service]));
	for (const service of services) merged.set(service.link.name, service.link);
	for (const service of previous?.services ?? []) {
		if (services.some((entry) => entry.link.name === service.name)) continue;
		const view = await client.request("GET", `${projectPath}/services/${encodeURIComponent(service.name)}`, LinkedServiceSchema,
			context.signal === undefined ? {} : { signal: context.signal });
		services.push({ link: service, view });
	}
	const link: ProjectLink = {
		version: 1,
		organizationSlug: organization.slug,
		projectSlug: request.projectSlug,
		services: [...merged.values()],
	};
	const monorepo = link.services.length > 1;
	for (const service of services) verifyKit(service.view.kit, service.link.name);
	const kit: KitFile[] = [];
	const warnings: string[] = [];
	for (const service of services) {
		context.signal?.throwIfAborted();
		const previousService = previous?.services.find((entry) => entry.name === service.link.name);
		const previousWorkflow = previousService === undefined ? undefined : adaptWorkflow(service.view.kit, previousService, previous!.services.length > 1).text;
		const report = await writeKit(context.io.cwd, service.view.kit, service.link, monorepo, previousWorkflow);
		kit.push(...report.files);
		warnings.push(...report.warnings);
	}
	context.signal?.throwIfAborted();
	await writeProjectLink(context.io.cwd, link);
	return { link, created: { project: createdProject, services: createdServices }, kit, warnings };
}
