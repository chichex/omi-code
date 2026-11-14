// Consultas de filesystem compartidas por instalación, runtime y onboarding.
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

export function isInside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

export async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true; }
	catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

export async function isDirectory(path: string): Promise<boolean> {
	try { return (await stat(path)).isDirectory(); }
	catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

export interface PrivateFileReservation {
	/**
	 * Escribe el contenido y lo deja en su ruta final con un rename atómico. Si el contenido
	 * quedó escrito pero no llegó a la ruta final, lanza `PrivateFileStrandedError`.
	 */
	commit(content: string): Promise<void>;
	/** Para cuando el secreto no llegó: borra el temporal vacío. */
	discard(): Promise<void>;
}

/** El contenido quedó completo en el temporal 0600, que se conserva: es su única copia. */
export class PrivateFileStrandedError extends Error {
	readonly temporaryPath: string;

	constructor(temporaryPath: string, cause: unknown) {
		super(`el archivo quedó en ${temporaryPath}`, { cause });
		this.name = "PrivateFileStrandedError";
		this.temporaryPath = temporaryPath;
	}
}

/**
 * Abre el temporal 0600 antes de pedir un secreto irrepetible: si no se puede escribir,
 * falla acá y no después de haberlo recibido.
 */
export async function reservePrivateFile(path: string): Promise<PrivateFileReservation> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	const discard = async (): Promise<void> => {
		await handle.close().catch(() => undefined);
		await rm(temporary, { force: true });
	};
	return {
		discard,
		async commit(content) {
			try {
				await handle.writeFile(content);
				await handle.sync();
			} catch (error) {
				// Un temporal a medio escribir no sirve como copia: no se deja un secreto parcial suelto.
				await discard();
				throw error;
			}
			try {
				await handle.close();
				await rename(temporary, path);
			} catch (error) {
				await handle.close().catch(() => undefined);
				throw new PrivateFileStrandedError(temporary, error);
			}
		},
	};
}
