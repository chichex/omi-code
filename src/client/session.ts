// Abre el cliente autenticado a partir de la sesión guardada, y resuelve la organización.

import { Type, type Static } from "typebox";
import { loadCredentials, type Credentials } from "../auth/credentials.ts";
import type { Io } from "../cli/io.ts";
import { OmiError } from "../core/errors.ts";
import { credentialsPath } from "../core/paths.ts";
import { API_URL_ENV, DEFAULT_API_URL } from "../protocol/constants.ts";
import { OmiClient } from "./http.ts";

export const PrincipalSchema = Type.Object({
	user_id: Type.String(),
	name: Type.String(),
	email: Type.String(),
	organizations: Type.Array(
		Type.Object({
			organization_id: Type.String(),
			name: Type.String(),
			slug: Type.String(),
			role: Type.String(),
		}),
	),
});

export type Principal = Static<typeof PrincipalSchema>;

export interface Session {
	client: OmiClient;
	credentials: Credentials;
}

/** Sin sesión previa: --api, después OMI_API_URL, después la URL pública. */
export function resolveApiUrl(io: Io, override?: string, stored?: string): string {
	return override ?? io.env[API_URL_ENV] ?? stored ?? DEFAULT_API_URL;
}

function pollInterval(io: Io): { pollIntervalMs: number } | object {
	const value = Number(io.env.OMI_POLL_INTERVAL_MS);
	return Number.isFinite(value) && value > 0 ? { pollIntervalMs: value } : {};
}

export function anonymousClient(io: Io, apiUrl?: string): OmiClient {
	return new OmiClient({ apiUrl: resolveApiUrl(io, apiUrl), ...pollInterval(io) });
}

export async function openSession(io: Io, apiUrl?: string): Promise<Session> {
	const credentials = await loadCredentials(credentialsPath(io.homeDir));
	if (credentials === null) {
		throw new OmiError("not_logged_in", "no hay una sesión activa", { hint: "corré `omi login`" });
	}
	const client = new OmiClient({
		apiUrl: resolveApiUrl(io, apiUrl, credentials.apiUrl),
		token: credentials.token,
		...pollInterval(io),
	});
	return { client, credentials };
}

/** omi-api no tiene rutas de organizaciones: el slug se resuelve con la lista de /me. */
export async function resolveOrganization(client: OmiClient, slug: string): Promise<Principal["organizations"][number]> {
	const principal = await client.request("GET", "/me", PrincipalSchema);
	const organization = principal.organizations.find((candidate) => candidate.slug === slug);
	if (organization === undefined) {
		throw new OmiError("organization_not_member", `no pertenecés a la organización ${slug}`, {
			hint: "`omi whoami` lista tus organizaciones",
		});
	}
	return organization;
}
