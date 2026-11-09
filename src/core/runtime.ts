// Dónde están los assets de Pi. En desarrollo, en node_modules; en el binario, en ~/.omi/runtime,
// porque Pi lee temas, wasm y plantillas del disco.

import { join } from "node:path";
import { isCompiledBinary, omiHome } from "./paths.ts";
import { isDirectory } from "./files.ts";
export { isCompiledBinary };

export interface RuntimeAssets {
	/** Raíz de assets para Pi. Sólo existe en una instalación. */
	packageDir?: string;
}

export function runtimeDir(homeDir: string): string {
	return join(omiHome(homeDir), "runtime");
}

export async function resolveRuntime(homeDir: string, compiled: boolean = isCompiledBinary()): Promise<RuntimeAssets> {
	const dir = runtimeDir(homeDir);
	return compiled && await isDirectory(join(dir, "theme")) ? { packageDir: dir } : {};
}
