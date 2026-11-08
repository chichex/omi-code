// Consultas de filesystem compartidas por instalación, runtime y onboarding.
import { stat } from "node:fs/promises";

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
