// login, logout y whoami. El token sólo viaja entre omi-api y ~/.omi/credentials.json.

import { Type } from "typebox";
import type { Io } from "../cli/io.ts";
import type { OmiClient } from "../client/http.ts";
import { PrincipalSchema, anonymousClient, openSession, type Principal } from "../client/session.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { credentialsPath } from "../core/paths.ts";
import { HEADER_SESSION_TOKEN, SESSION_COOKIE, SESSION_TOKEN_IN_BODY } from "../protocol/constants.ts";
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
	let setCookies: string[] = [];
	let session: UsableSession;
	try {
		session = await requestSession(client, input, (headers) => {
			setCookies = headers.getSetCookie();
		});
	} catch (error) {
		// Un 200 con Set-Cookie ya abrió la sesión, aunque el cuerpo no sirva: sin cookie no hay nada que cerrar.
		await closeUnusableSession(client, setCookies);
		throw error;
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

type UsableSession = Principal & { token: string; expires_at: string };

/** omi-api sólo entrega el token en el cuerpo a quien lo pide: el panel entra con la cookie. */
async function requestSession(client: OmiClient, input: LoginInput, onHeaders: (headers: Headers) => void): Promise<UsableSession> {
	const session = await client.request("POST", "/sessions", LoginResponse, {
		body: { email: input.email, password: input.password },
		headers: { [HEADER_SESSION_TOKEN]: SESSION_TOKEN_IN_BODY },
		onHeaders,
	});
	const { token, expires_at } = session;
	if (token === undefined || token === "" || expires_at === undefined) {
		throw new OmiError("session_token_unavailable", "omi-api abrió la sesión pero no entregó el token de sesión", {
			hint: `esa API puede ser anterior a chichex/omi#140 y no conocer el header ${HEADER_SESSION_TOKEN}, o un intermediario puede estar quitándolo en el camino: revisá la URL con --api u OMI_API_URL`,
		});
	}
	return { ...session, token, expires_at };
}

/**
 * La API ya abrió una sesión que omi no puede usar: se cierra con su cookie de sesión, que sólo
 * vuelve a esa misma API. Es un intento: si falla, manda el error del login.
 */
async function closeUnusableSession(client: OmiClient, setCookies: string[]): Promise<void> {
	const cookie = sessionCookieFrom(setCookies);
	if (cookie === undefined) return;
	try {
		await client.requestEmpty("DELETE", "/sessions/current", { headers: { Cookie: cookie }, timeoutMs: CLOSE_TIMEOUT_MS });
	} catch {
		// La sesión queda abierta hasta vencer; el error que se reporta es el del login.
	}
}

/**
 * El par `nombre=valor` de la cookie de sesión de OMI entre los Set-Cookie de una respuesta.
 * Las de otro nombre son de un intermediario y no se reenvían; una vacía o vencida es un borrado.
 */
function sessionCookieFrom(setCookies: string[]): string | undefined {
	for (const setCookie of setCookies) {
		const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
		const separator = pair.indexOf("=");
		if (separator < 0 || pair.slice(0, separator) !== SESSION_COOKIE) continue;
		if (pair.length === separator + 1 || isCookieDeletion(attributes)) continue;
		return pair;
	}
	return undefined;
}

/** Max-Age manda sobre Expires, como en un navegador. */
function isCookieDeletion(attributes: string[]): boolean {
	const attribute = (name: string): string | undefined =>
		attributes.find((part) => part.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
	const maxAge = attribute("max-age");
	if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) return Number(maxAge) <= 0;
	const expires = Date.parse(attribute("expires") ?? "");
	return !Number.isNaN(expires) && expires <= Date.now();
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
