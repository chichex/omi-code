// fd y rg incluidos en el runtime, enlazados donde Pi busca antes de bajarlos de GitHub: su
// directorio de binarios administrados (`<agent>/bin`). Pi los busca ahí con existsSync; el PATH
// no alcanza porque en el binario de bun `spawnSync` sin `env` usa el PATH con que arrancó omi.
// Cubren sólo lo que falta: si el PATH del usuario ya trae uno, Pi y bash usan el suyo, como antes.

import { constants } from "node:fs";
import { access, lstat, mkdir, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, join, relative } from "node:path";

/** Los nombres que Pi prueba en el PATH antes de bajar cada uno (`systemBinaryNames`). */
const TOOLS: Readonly<Record<string, readonly string[]>> = { fd: ["fd", "fdfind"], rg: ["rg"] };

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function userHas(names: readonly string[], dirs: readonly string[]): Promise<boolean> {
	for (const dir of dirs) for (const name of names) if (await isExecutableFile(join(dir, name))) return true;
	return false;
}

function ignore(code: string): (error: NodeJS.ErrnoException) => void {
	return (error) => { if (error.code !== code) throw error; };
}

/** Dónde está de verdad, aunque todavía no exista: lo que falta se cuelga del ancestro resuelto. */
async function physical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return join(await physical(dirname(path)), basename(path));
	}
}

/** `undefined` si no hay nada; `null` si es un archivo (por ejemplo, uno que Pi ya bajó). */
async function linkTarget(path: string): Promise<string | null | undefined> {
	const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (entry === undefined) return undefined;
	return entry.isSymbolicLink() ? readlink(path) : null;
}

/**
 * Deja `<agentBin>/<nombre>` apuntando a `<toolsDir>/<nombre>` cuando el PATH no lo trae, y saca
 * un enlace propio cuando el usuario ya tiene el suyo. No toca archivos ni enlaces ajenos.
 */
export async function linkBundledTools(agentBin: string, toolsDir: string, path: string | undefined): Promise<void> {
	const dirs = (path ?? "").split(delimiter).filter((dir) => dir !== "" && dir !== agentBin && dir !== toolsDir);
	// Relativo desde donde vive el enlace: con `<agent>` como symlink (stow, dotfiles), `../..` no es la instalación.
	const [physicalBin, physicalTools] = await Promise.all([physical(agentBin), physical(toolsDir)]);
	for (const [name, names] of Object.entries(TOOLS)) {
		const managed = join(agentBin, name);
		const own = relative(physicalBin, join(physicalTools, name));
		// El que creaba la versión anterior, relativo a la ruta lógica: también es propio.
		const previous = relative(agentBin, join(toolsDir, name));
		const current = await linkTarget(managed);
		if (current === null || (current !== undefined && current !== own && current !== previous)) continue;
		const wanted = !(await userHas(names, dirs)) && await isExecutableFile(join(toolsDir, name));
		const resolves = current === own && await isExecutableFile(managed);
		// Dos omi que arrancan a la vez crean o sacan el mismo enlace.
		if (current !== undefined && !(wanted && resolves)) await unlink(managed).catch(ignore("ENOENT"));
		if (wanted && !resolves) {
			await mkdir(agentBin, { recursive: true });
			await symlink(own, managed).catch(ignore("EEXIST"));
		}
	}
}
