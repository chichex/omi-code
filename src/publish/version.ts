// Reglas de versión de OMI: semver 2.0 sin `v` ni `+build`.

import { UsageError } from "../core/errors.ts";

// Mismo semverPattern que internal/api/versions.go: un identificador numérico no lleva ceros iniciales.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function assertVersion(version: string): void {
	if (!VERSION.test(version)) throw new UsageError(`versión inválida: ${version}`, "OMI acepta semver sin v ni +build, por ejemplo 1.4.2");
}

/** El workflow del kit deriva la versión de lo que sigue a la última barra del tag. */
export function tagFor(service: string, version: string, monorepo: boolean): string {
	return monorepo ? `${service}/v${version}` : `v${version}`;
}
