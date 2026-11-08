// Dónde están los assets. En desarrollo, en el repo; en el binario, en ~/.omi/runtime,
// porque Pi lee temas, wasm y plantillas del disco.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary, omiHome } from "./paths.ts";
import { isDirectory } from "./files.ts";
export { isCompiledBinary };

const REPO_SKILLS_DIR = new URL("../../skills", import.meta.url);
const REPO_THEMES_DIR = new URL("../../themes", import.meta.url);

export interface RuntimeAssets {
	skillsDir: string;
	themesDir: string;
	/** Raíz de assets para Pi y las extensiones. Sólo existe en una instalación. */
	packageDir?: string;
}

export function runtimeDir(homeDir: string): string {
	return join(omiHome(homeDir), "runtime");
}

export async function resolveRuntime(homeDir: string, compiled: boolean = isCompiledBinary()): Promise<RuntimeAssets> {
	const dir = runtimeDir(homeDir);
	if (compiled) {
		const installed = await isDirectory(join(dir, "skills"));
		if (installed) return { skillsDir: join(dir, "skills"), themesDir: join(dir, "themes"), packageDir: dir };
	}
	return { skillsDir: fileURLToPath(REPO_SKILLS_DIR), themesDir: fileURLToPath(REPO_THEMES_DIR) };
}
