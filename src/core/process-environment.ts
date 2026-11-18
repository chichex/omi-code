// Entorno de los procesos hijos. PI_PACKAGE_DIR describe sólo al host instalado, y la identidad
// agéntica y PI_CODING_AGENT_DIR se heredan a propósito.

const hiddenFromHost: NodeJS.ProcessEnv = {};
/** El valor del usuario de cada variable que omi fijó para el host; `undefined` si no la tenía. */
const userValues = new Map<string, string | undefined>();

/** omi no las ve, pero los comandos del usuario sí. Por ejemplo, un `npm test` que necesita su API key. */
export function hideFromHost(names: readonly string[]): void {
	for (const name of names) {
		const value = process.env[name];
		if (value === undefined) continue;
		hiddenFromHost[name] = value;
		delete process.env[name];
	}
}

/**
 * omi la ve con `value`, y los comandos del usuario con la suya. Por ejemplo, PI_TELEMETRY=0 apaga
 * la telemetría de Pi dentro de omi, pero un `pi` que corra el usuario sigue con su ajuste.
 * Devuelve cómo restaurarla.
 */
export function overrideInHost(name: string, value: string): () => void {
	if (!userValues.has(name)) userValues.set(name, process.env[name]);
	process.env[name] = value;
	return () => {
		const user = userValues.get(name);
		userValues.delete(name);
		if (user === undefined) delete process.env[name];
		else process.env[name] = user;
	};
}

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...hiddenFromHost, ...env };
	delete child.PI_PACKAGE_DIR;
	for (const [name, value] of userValues) {
		if (value === undefined) delete child[name];
		else child[name] = value;
	}
	return child;
}
