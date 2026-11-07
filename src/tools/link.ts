// omi_link_project: la misma lógica de `omi init`, expuesta como tool.

import { Type } from "typebox";
import { GuardrailError } from "../core/errors.ts";
import { linkProject } from "../project/init.ts";
import { defineTool } from "./types.ts";

const Parameters = Type.Object({
	organizationSlug: Type.Optional(Type.String({ description: "Por defecto, la organización de la sesión" })),
	projectSlug: Type.String({ description: "Slug del proyecto en OMI" }),
	projectName: Type.Optional(Type.String({ description: "Nombre visible si hay que crearlo" })),
	services: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.Optional(Type.String({ description: "Ruta relativa al repo. Por defecto: ." })),
			port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
			dockerfile: Type.Optional(Type.String({ description: "Relativo a path. Por defecto: Dockerfile" })),
		}),
		{ minItems: 1 },
	),
	environments: Type.Optional(Type.Array(Type.Union([Type.Literal("stage"), Type.Literal("prod")]), { minItems: 1 })),
	create: Type.Optional(Type.Boolean({ description: "Solicita al humano aprobar la creación; no constituye aprobación" })),
});

export const linkProjectTool = defineTool({
	name: "omi_link_project",
	label: "OMI: vincular proyecto",
	description: "Vincula el repo con un proyecto de OMI: escribe .omi/project.json y descarga el kit de publicación de cada service.",
	parameters: Parameters,
	run: async ({ create, ...request }, runtime) => {
		const result = await linkProject(request, {
			io: runtime.io,
			confirmCreate: async (what) => {
				if (create !== true || runtime.confirmCreate === undefined || !(await runtime.confirmCreate(what))) {
					throw new GuardrailError(`Crear ${what} requiere confirmación humana en la TUI o desde la CLI del humano`);
				}
				return true;
			},
			...(runtime.apiUrl === undefined ? {} : { apiUrl: runtime.apiUrl }),
			...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
		});
		const names = result.link.services.map((service) => service.name).join(", ");
		return { text: `Vinculado ${result.link.organizationSlug}/${result.link.projectSlug}: ${names}`, data: result };
	},
});
