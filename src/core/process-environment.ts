// Entorno de los procesos hijos. PI_PACKAGE_DIR describe sólo al host instalado, y la identidad
// agéntica y PI_CODING_AGENT_DIR se heredan a propósito.

const hiddenFromHost: NodeJS.ProcessEnv = {};

/** omi no las ve, pero los comandos del usuario sí. Por ejemplo, un `npm test` que necesita su API key. */
export function hideFromHost(names: readonly string[]): void {
	for (const name of names) {
		const value = process.env[name];
		if (value === undefined) continue;
		hiddenFromHost[name] = value;
		delete process.env[name];
	}
}

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...hiddenFromHost, ...env };
	delete child.PI_PACKAGE_DIR;
	return child;
}
