// Subcomandos de sesión: login, logout y whoami.

import { login, logout, whoami } from "../../auth/session.ts";
import type { Principal } from "../../client/session.ts";
import { EXIT_OK, UsageError } from "../../core/errors.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { printJson } from "../output.ts";

function publicPrincipal(principal: Principal): Principal {
	const { user_id, name, email, organizations } = principal;
	return { user_id, name, email, organizations };
}

function describe(principal: Principal): string {
	const organizations = principal.organizations.map((organization) => `${organization.slug} (${organization.role})`);
	return `${principal.name} <${principal.email}>\nOrganizaciones: ${organizations.join(", ") || "ninguna"}`;
}

async function askCredentials(values: { email?: string; "password-stdin"?: boolean }, io: Io): Promise<{ email: string; password: string }> {
	if (values["password-stdin"] === true) {
		if (values.email === undefined) throw new UsageError("--password-stdin necesita --email");
		return { email: values.email, password: (await io.readStdin()).replace(/\r?\n$/, "") };
	}
	if (!io.interactive) throw new UsageError("sin terminal, usá --email y --password-stdin");
	const email = values.email ?? (await io.prompt("Email: "));
	return { email, password: await io.promptHidden("Contraseña: ") };
}

export async function loginCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { email: { type: "string" }, "password-stdin": { type: "boolean" } });
	const credentials = await askCredentials(values, io);
	const principal = await login({ ...credentials, ...(values.api === undefined ? {} : { apiUrl: values.api }) }, io);
	if (values.json === true) printJson(publicPrincipal(principal), io);
	else io.out(`Sesión iniciada como ${principal.name} <${principal.email}>`);
	return EXIT_OK;
}

export async function whoamiCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, {});
	const principal = await whoami(io, values.api);
	if (values.json === true) printJson(publicPrincipal(principal), io);
	else io.out(describe(principal));
	return EXIT_OK;
}

export async function logoutCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, {});
	const closed = await logout(io, values.api);
	if (values.json === true) printJson({ closed }, io);
	else io.out(closed ? "Sesión cerrada" : "No había una sesión activa");
	return EXIT_OK;
}
