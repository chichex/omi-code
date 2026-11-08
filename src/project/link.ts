// Vínculo versionado entre el repo y OMI: .omi/project.json.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OmiError } from "../core/errors.ts";
import { projectLinkPath } from "../core/paths.ts";

const ServiceLink = Type.Object(
	{
		name: Type.String({ minLength: 1, pattern: "^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$" }),
		path: Type.String({ minLength: 1 }),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		dockerfile: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const ProjectLinkSchema = Type.Object(
	{
		version: Type.Literal(1),
		organizationSlug: Type.String({ minLength: 1 }),
		projectSlug: Type.String({ minLength: 1 }),
		services: Type.Array(ServiceLink, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type ProjectLink = Static<typeof ProjectLinkSchema>;
export type ServiceLink = Static<typeof ServiceLink>;

function invalidLink(detail: string): OmiError {
	return new OmiError("project_link_invalid", `.omi/project.json inválido: ${detail}`, {
		hint: "corregilo o regeneralo con `omi init`",
	});
}

function insideRepo(path: string): boolean {
	const normalized = normalize(path);
	return !isAbsolute(path) && normalized !== ".." && !normalized.startsWith("../");
}

function assertLink(value: unknown): asserts value is ProjectLink {
	if (!Value.Check(ProjectLinkSchema, value)) {
		const details = [...Value.Errors(ProjectLinkSchema, value)].map((issue) => {
			const extra = issue.params as { additionalProperties?: string[] };
			const names = extra.additionalProperties?.join(", ");
			return `${issue.instancePath || "/"} ${issue.message}${names === undefined ? "" : ` (${names})`}`;
		});
		throw invalidLink(details.join("; "));
	}
	const seen = new Set<string>();
	for (const service of value.services) {
		if (seen.has(service.name)) throw invalidLink(`service repetido: ${service.name}`);
		seen.add(service.name);
		if (!insideRepo(service.path)) throw invalidLink(`path fuera del repo: ${service.path}`);
		if (!insideRepo(service.dockerfile)) throw invalidLink(`path de dockerfile fuera del repo: ${service.dockerfile}`);
	}
}

export function parseProjectLink(raw: string): ProjectLink {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw invalidLink("no es JSON");
	}
	assertLink(parsed);
	return parsed;
}

export async function loadProjectLink(cwd: string): Promise<ProjectLink | null> {
	let raw: string;
	try {
		raw = await readFile(projectLinkPath(cwd), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return parseProjectLink(raw);
}

export async function readProjectLink(cwd: string): Promise<ProjectLink> {
	const link = await loadProjectLink(cwd);
	if (link === null) throw new OmiError("project_not_linked", "este repo no está vinculado a OMI", { hint: "corré `omi init`" });
	return link;
}

export async function writeProjectLink(cwd: string, link: ProjectLink): Promise<void> {
	assertLink(link);
	const path = projectLinkPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(link, null, 2)}\n`);
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
