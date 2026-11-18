// Entorno de los procesos hijos. PI_PACKAGE_DIR describe sólo al host instalado, y la identidad
// agéntica y PI_CODING_AGENT_DIR se heredan a propósito.

const hiddenFromHost: NodeJS.ProcessEnv = {};
/** Por variable fijada para el host: el valor del usuario (`undefined` si no la tenía) y las fijaciones vigentes. */
const overrides = new Map<string, { user: string | undefined; active: { value: string }[] }>();

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
 * Devuelve cómo restaurarla: llamarla de nuevo no hace nada, y el valor del usuario vuelve cuando
 * se restauró la última fijación vigente, en cualquier orden.
 */
export function overrideInHost(name: string, value: string): () => void {
	const entry = overrides.get(name) ?? { user: process.env[name], active: [] };
	overrides.set(name, entry);
	const override = { value };
	entry.active.push(override);
	process.env[name] = value;
	return () => {
		const index = entry.active.indexOf(override);
		if (index === -1) return;
		entry.active.splice(index, 1);
		const current = entry.active.at(-1);
		if (current !== undefined) process.env[name] = current.value;
		else {
			overrides.delete(name);
			if (entry.user === undefined) delete process.env[name];
			else process.env[name] = entry.user;
		}
	};
}

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...hiddenFromHost, ...env };
	delete child.PI_PACKAGE_DIR;
	// Sólo se cambia lo que el hijo heredó del host: un valor que pasa quien lo lanza, se respeta.
	for (const [name, { user, active }] of overrides) {
		if (child[name] !== active.at(-1)?.value) continue;
		if (user === undefined) delete child[name];
		else child[name] = user;
	}
	return child;
}
