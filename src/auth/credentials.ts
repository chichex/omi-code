// Sesión local de ~/.omi/credentials.json. El token nunca sale de este archivo hacia la salida.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { OmiError } from "../core/errors.ts";

export interface Credentials {
	apiUrl: string;
	token: string;
	expiresAt: string;
	user: { id: string; name: string; email: string };
	defaultOrganizationSlug: string;
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isCredentials(value: unknown): value is Credentials {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	const user = data.user as Record<string, unknown> | null | undefined;
	return (
		typeof data.apiUrl === "string" &&
		typeof data.token === "string" &&
		data.token !== "" &&
		typeof data.expiresAt === "string" &&
		typeof data.defaultOrganizationSlug === "string" &&
		typeof user === "object" &&
		user !== null &&
		typeof user.id === "string" &&
		typeof user.name === "string" &&
		typeof user.email === "string"
	);
}

export async function loadCredentials(path: string): Promise<Credentials | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return null;
		throw error;
	}
	const invalid = new OmiError("credentials_invalid", `credenciales ilegibles en ${path}`, {
		hint: "corré `omi login` para regenerarlas",
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw invalid;
	}
	if (!isCredentials(parsed)) throw invalid;
	return parsed;
}

/** Escritura atómica: el temporal nace con 0600 y rename evita un archivo a medio escribir. */
export async function saveCredentials(path: string, credentials: Credentials): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function deleteCredentials(path: string): Promise<void> {
	await rm(path, { force: true });
}
