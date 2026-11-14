// Rutas locales de omi. Todo cuelga de ~/.omi para no tocar la configuración de Pi.

import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { UsageError } from "./errors.ts";
import { CREDENTIALS_FILE, OMI_HOME_DIR, PROJECT_LINK_FILE } from "../protocol/constants.ts";

export function isCompiledBinary(url: string = import.meta.url): boolean {
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

export function omiHome(homeDir: string, options: { env?: NodeJS.ProcessEnv; executable?: string; compiled?: boolean } = {}): string {
	if (!isAbsolute(homeDir)) throw new UsageError("HOME debe ser una ruta absoluta y no vacía");
	const override = (options.env ?? process.env).OMI_HOME;
	if (override) {
		if (!isAbsolute(override)) throw new UsageError("OMI_HOME debe ser una ruta absoluta");
		return normalize(override);
	}
	if (options.compiled ?? isCompiledBinary()) {
		const directory = dirname(options.executable ?? process.execPath);
		if (["bin", "runtime"].includes(basename(directory))) return dirname(directory);
	}
	return join(homeDir, OMI_HOME_DIR);
}

export function credentialsPath(homeDir: string): string {
	return join(omiHome(homeDir), CREDENTIALS_FILE);
}

/** Credencial de push del registry: OMI la entrega una sola vez y nunca pasa por la salida. */
export function registryPasswordPath(homeDir: string, organizationSlug: string): string {
	return join(omiHome(homeDir), "registry", `${organizationSlug}.push-password`);
}

export function agentDir(homeDir: string): string {
	return join(omiHome(homeDir), "agent");
}

/** Configuración de Pi de ORIGEN, sólo para importarla sin modificarla. */
export function sourcePiAgentDir(homeDir: string): string {
	return join(homeDir, ".pi", "agent");
}

export function projectLinkPath(cwd: string): string {
	return join(cwd, PROJECT_LINK_FILE);
}
