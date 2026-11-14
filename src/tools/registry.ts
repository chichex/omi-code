// omi_registry_manage: el registry de la organización, donde el CI publica las imágenes.
// El alta devuelve la credencial de push una única vez: va a un archivo 0600, nunca a la salida.

import { Type, type Static } from "typebox";
import { HostsSchema, RegistryCredentialsSchema, RegistrySchema, type HostView, type RegistryView } from "../client/views.ts";
import { ApiError, OmiError, UsageError } from "../core/errors.ts";
import { PrivateFileStrandedError, reservePrivateFile } from "../core/files.ts";
import { registryPasswordPath } from "../core/paths.ts";
import { assertCanProceed, enforce, type GuardedAction } from "../guardrails/policy.ts";
import { CI_REGISTRY_SECRET, ROLE_OWNER } from "../protocol/constants.ts";
import { openOrganizationScope, type OrganizationScope } from "./scope.ts";
import { defineTool, type ToolResult, type ToolRuntime } from "./types.ts";

/** La rotación existe en OMI pero todavía no en el CLI. */
const ROTATE_HINT = "OMI no la vuelve a mostrar: rotá la credencial desde el panel de OMI (el CLI todavía no la rota)";
/**
 * El alta genera dos hashes bcrypt y publica la ruta en Cloudflare dentro del mismo pedido: crear el
 * túnel, configurarlo y el CNAME, cada llamada con hasta 30 s. El plazo general de 30 s cortaba
 * altas que OMI sí terminaba.
 */
const CREATE_TIMEOUT_MS = 2 * 60_000;
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const Parameters = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("hosts"), Type.Literal("create"), Type.Literal("retry_route")]),
	organizationSlug: Type.Optional(Type.String({ description: "Por defecto, la del repo vinculado o la de la sesión" })),
	hostId: Type.Optional(Type.String({ description: "Sólo create: host que aloja el registry. Sin él, el único que puede alojarlo" })),
});

type Params = Static<typeof Parameters>;

function describeRegistry(registry: RegistryView): string {
	const route = registry.route_error === undefined ? registry.public_route : `${registry.public_route} (${registry.route_error})`;
	return [
		`${registry.hostname}: ${registry.state} · host ${registry.host_name} (${registry.host_id})`,
		`usuario de push: ${registry.push_username} · ruta pública: ${route}`,
		...(registry.last_error === undefined ? [] : [`último error: ${registry.last_error}`]),
	].join("\n");
}

/** Que todavía no exista es un estado esperable, no un error. */
async function readRegistry(scope: OrganizationScope): Promise<RegistryView | null> {
	try {
		return await scope.client.request("GET", `${scope.organizationPath}/registry`, RegistrySchema);
	} catch (error) {
		if (error instanceof ApiError && error.code === "registry_not_found") return null;
		throw error;
	}
}

async function status(scope: OrganizationScope): Promise<ToolResult> {
	const registry = await readRegistry(scope);
	const text = registry === null ? `${scope.organizationSlug} todavía no tiene registry` : describeRegistry(registry);
	return { text, data: { organization: scope.organizationSlug, registry } };
}

async function readHosts(scope: OrganizationScope): Promise<HostView[]> {
	const { hosts } = await scope.client.request("GET", `${scope.organizationPath}/hosts`, HostsSchema);
	return hosts;
}

async function listHosts(scope: OrganizationScope): Promise<ToolResult> {
	const hosts = await readHosts(scope);
	const lines = hosts.map((host) => `${host.id} ${host.name}: ${host.state} · ${host.registry_eligible ? "puede" : "no puede"} alojar el registry`);
	return { text: lines.join("\n") || `${scope.organizationSlug} no tiene hosts`, data: { organization: scope.organizationSlug, hosts } };
}

/** `registry_eligible` lo calcula OMI: acá sólo se evita pedir una confirmación que va a fallar. */
function chooseHost(hosts: readonly HostView[], hostId: string | undefined): HostView {
	if (hostId !== undefined) {
		const host = hosts.find((candidate) => candidate.id === hostId);
		if (host === undefined) throw new OmiError("host_not_found", `el host ${hostId} no existe en la organización`, { hint: "`omi registry hosts` los lista" });
		if (!host.registry_eligible) {
			throw new OmiError("host_not_registry_eligible", `el host ${host.name} no puede alojar el registry`, {
				hint: "tiene que estar aprobado, disponible dentro del cluster y con 20 GB libres",
			});
		}
		return host;
	}
	const eligible = hosts.filter((host) => host.registry_eligible);
	const [only, ...others] = eligible;
	if (only !== undefined && others.length === 0) return only;
	if (only === undefined) throw new OmiError("host_not_registry_eligible", "ningún host puede alojar el registry", { hint: "`omi registry hosts` muestra su estado" });
	throw new UsageError("varios hosts pueden alojar el registry: indicá cuál", eligible.map((host) => host.id).join(", "));
}

function passwordPath(scope: OrganizationScope, runtime: ToolRuntime): string {
	// El slug termina en un nombre de archivo: no se confía en que la API lo mande limpio.
	if (!ORGANIZATION_SLUG.test(scope.organizationSlug)) throw new OmiError("unexpected_response", "OMI devolvió un slug de organización inválido");
	return registryPasswordPath(runtime.io.homeDir, scope.organizationSlug);
}

/** La credencial ya llegó y OMI no la repite: si quedó en el temporal, el error dice dónde. */
function passwordNotSaved(path: string, cause: unknown): OmiError {
	if (cause instanceof PrivateFileStrandedError) {
		return new OmiError("registry_password_not_saved", `el registry se creó pero su credencial de push no se pudo dejar en ${path}: quedó en ${cause.temporaryPath}`, {
			hint: `es la única copia (OMI no la vuelve a mostrar): movela a ${path}`,
			cause,
		});
	}
	return new OmiError("registry_password_not_saved", `el registry se creó pero su credencial de push no se pudo guardar en ${path}`, {
		hint: ROTATE_HINT,
		cause,
	});
}

function reasonOf(cause: unknown): string {
	if (cause instanceof OmiError) return `${cause.code}: ${cause.message}`;
	return cause instanceof Error ? cause.message : String(cause);
}

/** Un 4xx con código de omi-api es un rechazo: el alta valida todo antes de guardar. */
function isRejection(error: unknown): boolean {
	return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "unexpected_response";
}

/**
 * Timeout, red caída, 5xx o respuesta inválida no dicen si el registry se creó: omi-api lo guarda
 * antes de publicar su ruta y de responder, y no repite la credencial (el alta no es idempotente:
 * reintentarla da `registry_exists`). Se consulta el estado para decir qué pasó.
 */
async function uncertainCreation(scope: OrganizationScope, cause: unknown): Promise<unknown> {
	let registry: RegistryView | null;
	try {
		registry = await readRegistry(scope);
	} catch {
		return new OmiError("registry_create_unconfirmed", `no se pudo confirmar si el registry de ${scope.organizationSlug} quedó creado: ${reasonOf(cause)}`, {
			hint: `\`omi registry status\` lo muestra. Si existe, su credencial de push no llegó: ${ROTATE_HINT}`,
			cause,
		});
	}
	if (registry === null) return cause;
	return new OmiError(
		"registry_created_without_credential",
		`el registry de ${scope.organizationSlug} quedó creado (${registry.hostname}) pero su credencial de push no se pudo obtener: ${reasonOf(cause)}`,
		{ hint: ROTATE_HINT, cause },
	);
}

/** Lo que omi-api va a rechazar seguro se dice antes de pedirle una confirmación al humano. */
async function assertCanCreate(scope: OrganizationScope): Promise<void> {
	if (scope.role !== ROLE_OWNER) {
		throw new OmiError("forbidden", `crear el registry de ${scope.organizationSlug} exige ser ${ROLE_OWNER} de la organización (tu rol: ${scope.role})`);
	}
	const existing = await readRegistry(scope);
	if (existing !== null) {
		throw new OmiError("registry_exists", `${scope.organizationSlug} ya tiene registry: ${existing.hostname} (${existing.state})`, { hint: "`omi registry status` lo muestra" });
	}
}

async function create(scope: OrganizationScope, params: Params, runtime: ToolRuntime, action: GuardedAction): Promise<ToolResult> {
	await assertCanCreate(scope);
	const host = chooseHost(await readHosts(scope), params.hostId);
	const path = passwordPath(scope, runtime);
	await enforce(
		{ ...action, diff: [`+ registry de ${scope.organizationSlug} en el host ${host.name} (${host.id})`, `La credencial de push se guarda en ${path} y no se muestra`].join("\n") },
		runtime.guard,
	);
	const file = await reservePrivateFile(path);
	let created: Static<typeof RegistryCredentialsSchema>;
	try {
		created = await scope.client.request("POST", `${scope.organizationPath}/registry`, RegistryCredentialsSchema, {
			body: { host_id: host.id },
			timeoutMs: CREATE_TIMEOUT_MS,
		});
	} catch (error) {
		// En ningún camino de falla llegó la credencial: el temporal está vacío.
		await file.discard();
		throw isRejection(error) ? error : await uncertainCreation(scope, error);
	}
	try {
		await file.commit(created.push_password);
	} catch (error) {
		throw passwordNotSaved(path, error);
	}
	return {
		text: [
			`Registry de ${scope.organizationSlug} creado`,
			describeRegistry(created.registry),
			`Credencial de push guardada en ${path} (no se muestra ni se puede volver a pedir)`,
			`Para publicar, cargala como ${CI_REGISTRY_SECRET} en el entorno o en los secretos del CI`,
		].join("\n"),
		data: { organization: scope.organizationSlug, registry: created.registry, push_password_file: path },
	};
}

async function retryRoute(scope: OrganizationScope, runtime: ToolRuntime, action: GuardedAction): Promise<ToolResult> {
	const current = await readRegistry(scope);
	if (current === null) {
		throw new OmiError("registry_not_found", `${scope.organizationSlug} todavía no tiene registry`, { hint: "crealo con `omi registry create`" });
	}
	const reason = current.route_error === undefined ? "" : ` (${current.route_error})`;
	await enforce({ ...action, diff: `publicar ${current.hostname} en Cloudflare · ruta actual: ${current.public_route}${reason}` }, runtime.guard);
	const registry = await scope.client.request("POST", `${scope.organizationPath}/registry/route`, RegistrySchema, { body: {} });
	return { text: describeRegistry(registry), data: { organization: scope.organizationSlug, registry } };
}

const SUMMARIES = { create: "Crear el registry", retry_route: "Reintentar la ruta pública del registry" } as const;

export const registryManageTool = defineTool({
	name: "omi_registry_manage",
	label: "OMI: gestionar el registry",
	description:
		"Registry de la organización: estado, hosts que pueden alojarlo, alta en un host y reintento de su ruta pública. El alta y el reintento siempre piden confirmación humana; la credencial de push queda en un archivo local y nunca se muestra.",
	parameters: Parameters,
	run: async (params, runtime) => {
		if (params.hostId !== undefined && params.action !== "create") throw new UsageError("hostId sólo vale con create");
		if (params.action === "status") return status(await openOrganizationScope(runtime, params.organizationSlug));
		if (params.action === "hosts") return listHosts(await openOrganizationScope(runtime, params.organizationSlug));
		const pending: GuardedAction = { operation: "registry", summary: SUMMARIES[params.action], diff: SUMMARIES[params.action] };
		// Sin humano posible no se consulta nada: el resultado sería el mismo rechazo.
		assertCanProceed(pending, runtime.guard);
		const scope = await openOrganizationScope(runtime, params.organizationSlug);
		const action = { ...pending, summary: `${pending.summary} de ${scope.organizationSlug}` };
		return params.action === "create" ? create(scope, params, runtime, action) : retryRoute(scope, runtime, action);
	},
});
