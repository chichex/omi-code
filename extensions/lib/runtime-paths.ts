// Rutas que dependen del proceso. Se resuelven al usarse, no al importar: `launch.ts` setea
// PI_CODING_AGENT_DIR antes de arrancar Pi, y un valor fijado al importar caería en ~/.pi/agent.

import { homedir } from "node:os";
import { join } from "node:path";

/** Configuración de Pi del proceso actual: bajo omi, `~/.omi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Único punto que resuelve assets empaquetados. Ejemplo: con `OMI_RUNTIME_DIR=/opt/omi`,
 * `runtimeAssetDir("agents", fallback)` es `/opt/omi/agents`; sin la variable, `fallback`.
 */
export function runtimeAssetDir(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
	const runtimeDir = env.OMI_RUNTIME_DIR;
	return runtimeDir ? join(runtimeDir, name) : fallback;
}
