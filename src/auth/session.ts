// login, logout y whoami. El token sólo viaja entre omi-api y ~/.omi/credentials.json.

import { Type } from "typebox";
import type { Io } from "../cli/io.ts";
import type { OmiClient } from "../client/http.ts";
import { PrincipalSchema, anonymousClient, openSession, type Principal } from "../client/session.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { credentialsPath } from "../core/paths.ts";
import { HEADER_SESSION_TOKEN, SESSION_TOKEN_IN_BODY } from "../protocol/constants.ts";
import { deleteCredentials, loadCredentials, saveCredentials } from "./credentials.ts";

const LoginResponse = Type.Intersect([
	PrincipalSchema,
	Type.Object({ token: Type.Optional(Type.String()), expires_at: Type.Optional(Type.String()) }),
]);

/** Plazo del cierre de una sesión sin token: no demora el error del login. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface LoginInput {
	email: string;
	password: string;
	apiUrl?: string;
}

export async function login(input: LoginInput, io: Io): Promise<Principal> {
	const client = anonymousClient(io, input.apiUrl);
	// omi-api sólo entrega el token en el cuerpo a quien lo pide: el panel entra con la cookie.
	let setCookies: string[] = [];
	const session = await client.request("POST", "/sessions", LoginResponse, {
		body: { email: input.email, password: input.password },
		headers: { [HEADER_SESSION_TOKEN]: SESSION_TOKEN_IN_BODY },
		onHeaders: (headers) => {
			setCookies = headers.getSetCookie();
		},
	});
	if (session.token === undefined || session.token === "" || session.expires_at === undefined) {
		await closeUnusableSession(client, setCookies);
		throw new OmiError("session_token_unavailable", "omi-api abrió la sesión pero no entregó el token de sesión", {
			hint: `un proxy intermedio puede estar quitando el header ${HEADER_SESSION_TOKEN}, o esa API es anterior a chichex/omi#140: revisá la URL con --api u OMI_API_URL`,
		});
	}
	await saveCredentials(credentialsPath(io.homeDir), {
		apiUrl: client.apiUrl,
		token: session.token,
		expiresAt: session.expires_at,
		user: { id: session.user_id, name: session.name, email: session.email },
		defaultOrganizationSlug: session.organizations.length === 1 ? session.organizations[0]!.slug : "",
	});
	return session;
}

/**
 * La API ya abrió una sesión que omi no puede usar: se cierra con la cookie que vino en la
 * respuesta, que sólo vuelve a esa misma API. Es un intento: si falla, manda el error del login.
 */
async function closeUnusableSession(client: OmiClient, setCookies: string[]): Promise<void> {
	const cookie = setCookies
		.map((setCookie) => setCookie.split(";", 1)[0]!.trim())
		.filter((pair) => !pair.endsWith("="))
		.join("; ");
	if (cookie === "") return;
	try {
		await client.requestEmpty("DELETE", "/sessions/current", { headers: { Cookie: cookie }, timeoutMs: CLOSE_TIMEOUT_MS });
	} catch {
		// La sesión queda abierta hasta vencer; el error que se reporta es el del login.
	}
}

export async function whoami(io: Io, apiUrl?: string): Promise<Principal> {
	const { client } = await openSession(io, apiUrl);
	return client.request("GET", "/me", PrincipalSchema);
}

/** Si la revocación falla por red se conserva el archivo: el token seguiría vivo en la API. */
export async function logout(io: Io, apiUrl?: string): Promise<boolean> {
	const path = credentialsPath(io.homeDir);
	if ((await loadCredentials(path)) === null) return false;
	const { client } = await openSession(io, apiUrl);
	try {
		await client.requestEmpty("DELETE", "/sessions/current");
	} catch (error) {
		// Un 401 significa que la sesión ya no existe: no queda nada por revocar.
		if (!(error instanceof ApiError && error.status === 401)) throw error;
	}
	await deleteCredentials(path);
	return true;
}
