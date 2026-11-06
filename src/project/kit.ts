// Kit de publicación: lo que OMI entrega dentro de ServiceView.kit, volcado al repo.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Type, type Static } from "typebox";
import { OmiError } from "../core/errors.ts";
import type { ServiceLink } from "./link.ts";

export const PublishKitSchema = Type.Object({
	registry_hostname: Type.String(),
	repository: Type.String(),
	image: Type.String(),
	push_username: Type.String(),
	workflow: Type.String(),
	dockerfile: Type.String(),
	contract: Type.String(),
	push_script: Type.String(),
});

export type PublishKit = Static<typeof PublishKitSchema>;

export interface KitFile {
	path: string;
	status: "created" | "updated" | "unchanged" | "kept";
}

export interface KitReport {
	files: KitFile[];
	warnings: string[];
}

export function workflowPath(service: string): string {
	return `.github/workflows/omi-${service}.yml`;
}

export function kitDir(service: string): string {
	return `.omi/kit/${service}`;
}

export function pushScriptPath(service: string): string {
	return `${kitDir(service)}/push-image.sh`;
}

/** Un kit al que le falta una pieza del contrato no sirve para publicar: mejor frenar acá. */
export function verifyKit(kit: PublishKit, service: string): void {
	const problems: string[] = [];
	if (!kit.contract.includes("/health") || !kit.contract.includes("/version")) problems.push("contrato sin /health y /version");
	if (!kit.workflow.includes("OMI_REGISTRY_PASSWORD")) problems.push("workflow sin OMI_REGISTRY_PASSWORD");
	if (!kit.push_script.includes("--blob-chunk")) problems.push("script sin subida en trozos");
	if (kit.dockerfile.trim() === "") problems.push("Dockerfile vacío");
	if (problems.length > 0) {
		throw new OmiError("kit_invalid", `el kit de ${service} está incompleto: ${problems.join(", ")}`);
	}
}

/** La plantilla asume un service en la raíz: en un monorepo cada uno tiene su tag y su contexto. */
export function adaptWorkflow(kit: PublishKit, service: ServiceLink, monorepo: boolean): { text: string; warnings: string[] } {
	const warnings: string[] = [];
	const name = service.name;
	let text = kit.workflow.replace(`# .github/workflows/publicar-${name}.yml`, `# ${workflowPath(name)}`);
	if (monorepo) text = text.replace(`tags: ["${name}/v*", "v*"]`, `tags: ["${name}/v*"]`);
	const usesDefaults = service.path === "." && service.dockerfile === "Dockerfile";
	if (!usesDefaults) {
		const buildLine = `-t ${name}:"$VERSION" .`;
		const dockerfile = posix.join(service.path, service.dockerfile);
		if (text.includes(buildLine)) text = text.replace(buildLine, `-t ${name}:"$VERSION" -f ${dockerfile} ${service.path}`);
		else warnings.push(`no pude adaptar el contexto de docker build en ${workflowPath(name)}`);
	}
	return { text, warnings };
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function write(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, mode === undefined ? undefined : { mode });
}

/** Archivo del usuario: si ya existe y difiere, se respeta. */
async function writeOwnedByUser(root: string, path: string, content: string): Promise<KitFile> {
	const absolute = join(root, path);
	const current = await readIfExists(absolute);
	if (current === null) {
		await write(absolute, content);
		return { path, status: "created" };
	}
	return { path, status: current === content ? "unchanged" : "kept" };
}

/** Archivo de OMI: siempre refleja el kit vigente. */
async function writeOwnedByOmi(root: string, path: string, content: string, mode?: number): Promise<KitFile> {
	const absolute = join(root, path);
	const current = await readIfExists(absolute);
	if (current === content) return { path, status: "unchanged" };
	await write(absolute, content, mode);
	return { path, status: current === null ? "created" : "updated" };
}

export async function writeKit(root: string, kit: PublishKit, service: ServiceLink, monorepo: boolean): Promise<KitReport> {
	verifyKit(kit, service.name);
	const workflow = adaptWorkflow(kit, service, monorepo);
	const files = [
		await writeOwnedByUser(root, posix.join(service.path, service.dockerfile), kit.dockerfile),
		await writeOwnedByUser(root, workflowPath(service.name), workflow.text),
		await writeOwnedByOmi(root, `${kitDir(service.name)}/contract.md`, kit.contract),
		await writeOwnedByOmi(root, pushScriptPath(service.name), kit.push_script, 0o755),
	];
	return { files, warnings: workflow.warnings };
}
