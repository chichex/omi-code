// Reglas de versión de OMI: semver 2.0 sin `v` ni `+build`.

import { UsageError } from "../core/errors.ts";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function assertVersion(version: string): void {
	if (!VERSION.test(version)) throw new UsageError(`versión inválida: ${version}`, "OMI acepta semver sin v ni +build, por ejemplo 1.4.2");
}

/** El workflow del kit deriva la versión de lo que sigue a la última barra del tag. */
export function tagFor(service: string, version: string, monorepo: boolean): string {
	return monorepo ? `${service}/v${version}` : `v${version}`;
}
