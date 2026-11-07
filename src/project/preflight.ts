// Toda validación local ocurre antes de mutar OMI o escribir el kit.
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { OmiError } from "../core/errors.ts";
import type { LinkRequest } from "./init.ts";
import { parseProjectLink } from "./link.ts";

async function existingAncestor(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return existingAncestor(dirname(path));
	}
}

export async function validateLinkRequest(request: LinkRequest, cwd: string): Promise<void> {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(request.projectSlug)) {
		throw new OmiError("link_request_invalid", "slug del proyecto inválido");
	}
	const environments = request.environments ?? ["stage"];
	if (environments.length === 0 || environments.some((env) => env !== "stage" && env !== "prod") || new Set(environments).size !== environments.length) {
		throw new OmiError("link_request_invalid", "ambientes inválidos: usá stage, prod o stage,prod sin repeticiones");
	}
	const link = parseProjectLink(JSON.stringify({
		version: 1, organizationSlug: request.organizationSlug ?? "pending", projectSlug: request.projectSlug,
		services: request.services.map((service) => ({
			name: service.name, path: service.path ?? ".", port: service.port ?? 8080, dockerfile: service.dockerfile ?? "Dockerfile",
		})),
	}));
	const root = await realpath(cwd);
	const paths = [".omi", ".github/workflows", ...link.services.map((service) => join(service.path, service.dockerfile))];
	for (const path of paths) {
		const actual = await existingAncestor(resolve(root, path));
		const rel = relative(root, actual);
		if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
			throw new OmiError("project_link_invalid", `path fuera del repo mediante symlink: ${path}`);
		}
	}
}
