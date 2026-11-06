// omi_project_status: foto del proyecto, sin mutar nada.

import { Type } from "typebox";
import type { ServiceView } from "../client/views.ts";
import { linkedService, openScope, readService } from "./scope.ts";
import { defineTool } from "./types.ts";

const MAX_VERSIONS = 10;

function summarize(service: ServiceView) {
	return {
		name: service.name,
		versions: service.versions.slice(0, MAX_VERSIONS).map((version) => version.tag),
		version_scan: service.version_scan,
		environments: service.environments.map((environment) => ({
			name: environment.name,
			state: environment.state,
			hostname: environment.hostname,
			visibility: environment.visibility,
			...(environment.current_version === undefined ? {} : { current_version: environment.current_version }),
			...(environment.last_error === undefined ? {} : { last_error: environment.last_error }),
			...(environment.last_deployment === undefined ? {} : { last_deployment: environment.last_deployment }),
			...(environment.promotion === undefined ? {} : { promotion: environment.promotion }),
			access: environment.access,
		})),
	};
}

function describe(service: ReturnType<typeof summarize>): string {
	const lines = [`${service.name} · versiones: ${service.versions.join(", ") || "ninguna"} · barrido: ${service.version_scan.state}`];
	for (const environment of service.environments) {
		const deploy = environment.last_deployment === undefined ? "" : ` · último deploy ${environment.last_deployment.to_version} ${environment.last_deployment.status}`;
		lines.push(`  ${environment.name}: ${environment.state} ${environment.current_version ?? "sin versión"} · acceso ${environment.access.state}${deploy}`);
	}
	return lines.join("\n");
}

export const projectStatusTool = defineTool({
	name: "omi_project_status",
	label: "OMI: estado del proyecto",
	description: "Estado consolidado del proyecto vinculado: services, ambientes, versiones publicadas, último deploy y acceso.",
	parameters: Type.Object({ service: Type.Optional(Type.String({ description: "Por defecto, todos" })) }),
	run: async (params, runtime) => {
		const scope = await openScope(runtime);
		const names = params.service === undefined ? scope.link.services.map((service) => service.name) : [linkedService(scope.link, params.service).name];
		const services: ReturnType<typeof summarize>[] = [];
		for (const name of names) services.push(summarize(await readService(scope, name)));
		const data = { organization: scope.link.organizationSlug, project: scope.link.projectSlug, services };
		return { text: [`${data.organization}/${data.project}`, ...services.map(describe)].join("\n"), data };
	},
});
