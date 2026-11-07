// login, logout y whoami. El token sólo viaja entre omi-api y ~/.omi/credentials.json.

import { Type } from "typebox";
import type { Io } from "../cli/io.ts";
import { PrincipalSchema, anonymousClient, openSession, type Principal } from "../client/session.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { credentialsPath } from "../core/paths.ts";
import { deleteCredentials, loadCredentials, saveCredentials } from "./credentials.ts";

const LoginResponse = Type.Intersect([
	PrincipalSchema,
	Type.Object({ token: Type.Optional(Type.String()), expires_at: Type.Optional(Type.String()) }),
]);

export interface LoginInput {
	email: string;
	password: string;
	apiUrl?: string;
}

export async function login(input: LoginInput, io: Io): Promise<Principal> {
	const client = anonymousClient(io, input.apiUrl);
	const session = await client.request("POST", "/sessions", LoginResponse, {
		body: { email: input.email, password: input.password },
	});
	if (session.token === undefined || session.token === "" || session.expires_at === undefined) {
		throw new OmiError("session_token_unavailable", "esta versión de omi-api no entrega un token de sesión", {
			hint: "hace falta chichex/omi#140 desplegado en esa API",
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
