// Dónde están los assets. En desarrollo, en el repo; en el binario, en ~/.omi/runtime,
// porque Pi lee temas, wasm y plantillas del disco.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { omiHome } from "./paths.ts";

const REPO_SKILLS_DIR = new URL("../../skills", import.meta.url);
const REPO_THEMES_DIR = new URL("../../themes", import.meta.url);

export interface RuntimeAssets {
	skillsDir: string;
	themesDir: string;
	/** Raíz de assets para Pi y las extensiones. Sólo existe en una instalación. */
	packageDir?: string;
}

export function isCompiledBinary(url: string = import.meta.url): boolean {
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

export function runtimeDir(homeDir: string): string {
	return join(omiHome(homeDir), "runtime");
}

export async function resolveRuntime(homeDir: string, compiled: boolean = isCompiledBinary()): Promise<RuntimeAssets> {
	const dir = runtimeDir(homeDir);
	if (compiled) {
		const installed = await stat(join(dir, "skills")).then(
			(info) => info.isDirectory(),
			() => false,
		);
		if (installed) return { skillsDir: join(dir, "skills"), themesDir: join(dir, "themes"), packageDir: dir };
	}
	return { skillsDir: fileURLToPath(REPO_SKILLS_DIR), themesDir: fileURLToPath(REPO_THEMES_DIR) };
}
