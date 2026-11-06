// Un secreto entra por una variable local o por el canal oculto del humano. Nunca por el modelo.

import { OmiError } from "../core/errors.ts";
import type { ToolRuntime } from "./types.ts";

export async function readSecretValue(name: string, fromEnv: string | undefined, runtime: ToolRuntime): Promise<string> {
	if (fromEnv !== undefined) {
		const value = runtime.io.env[fromEnv];
		if (value === undefined || value === "") {
			throw new OmiError("secret_input_unavailable", `la variable local ${fromEnv} no está definida`, {
				hint: "definila en el entorno del proceso antes de reintentar",
			});
		}
		return value;
	}
	if (runtime.readSecret !== undefined) return runtime.readSecret(name);
	throw new OmiError("secret_input_unavailable", `no hay cómo pedir ${name} sin exponerlo`, {
		hint: "pasá fromEnv con el nombre de una variable local, o corré `omi env set --secret` en una terminal",
	});
}
