// Rutas locales de omi. Todo cuelga de ~/.omi para no tocar la configuración de Pi.

import { join } from "node:path";
import { CREDENTIALS_FILE, OMI_HOME_DIR, PROJECT_LINK_FILE } from "../protocol/constants.ts";

export function omiHome(homeDir: string): string {
	return join(homeDir, OMI_HOME_DIR);
}

export function credentialsPath(homeDir: string): string {
	return join(omiHome(homeDir), CREDENTIALS_FILE);
}

export function agentDir(homeDir: string): string {
	return join(omiHome(homeDir), "agent");
}

export function piAgentDir(homeDir: string): string {
	return join(homeDir, ".pi", "agent");
}

export function projectLinkPath(cwd: string): string {
	return join(cwd, PROJECT_LINK_FILE);
}
