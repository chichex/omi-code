// omi sólo lee configuración de ~/.omi/agent y del proyecto. Pi además carga ~/.agents/skills y
// sube hasta / buscando AGENTS.md: se corta acá porque Pi no expone un flag para ninguna de las dos.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";

/** Sigue siendo reversible: `+~/.agents/skills/foo/SKILL.md` en los ajustes trae uno puntual. */
export const USER_SKILLS_EXCLUSION = "!~/.agents/skills/**";

const CONTEXT_OPT_OUT = ["--no-context-files", "-nc"];

async function readSettings(path: string): Promise<Record<string, unknown> | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
	}
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

async function fileMode(path: string): Promise<number> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return 0o644;
	}
}

/** Deja la exclusión en los ajustes de omi. `false` si no se pudo: el archivo queda como estaba. */
export async function excludeUserSkills(dir: string): Promise<boolean> {
	const path = join(dir, "settings.json");
	const settings = await readSettings(path);
	const skills = settings?.skills ?? [];
	if (settings === null || !Array.isArray(skills)) return false;
	if (skills.includes(USER_SKILLS_EXCLUSION)) return true;
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ ...settings, skills: [USER_SKILLS_EXCLUSION, ...skills] }, null, 2), { mode: await fileMode(path), flag: "wx" });
		await rename(temporary, path);
		return true;
	} catch {
		return false;
	} finally {
		await rm(temporary, { force: true });
	}
}

/** La raíz del repo que contiene a `cwd`. Sin repo, el proyecto es `cwd`. */
function projectRoot(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return cwd;
	}
}

function isInside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

/** Descarta el contexto de los ancestros del proyecto. Por ejemplo, `~/AGENTS.md`. */
export function projectContextFiles<T extends { path: string }>(files: readonly T[], cwd: string, dir: string): T[] {
	const root = projectRoot(resolve(cwd));
	return files.filter(({ path }) => dirname(path) === resolve(dir) || isInside(root, path));
}

/**
 * Pi arranca con `--no-context-files` y esta extensión agrega lo permitido. Si fallara, el modelo
 * se queda sin contexto en vez de recibir uno ajeno. Se calcula en cada corrida porque una sesión
 * puede cambiar de cwd, y se avisa porque la sección Context de la TUI queda vacía.
 */
export async function isolatedContextExtension(dir: string): Promise<InlineExtension> {
	const { loadProjectContextFiles } = await import("@earendil-works/pi-coding-agent");
	const load = (cwd: string) => projectContextFiles(loadProjectContextFiles({ cwd, agentDir: dir }), cwd, dir);
	return {
		name: "omi-isolated-context",
		factory: (pi) => {
			pi.on("session_start", (_event, ctx) => {
				const files = load(ctx.cwd);
				if (ctx.hasUI && files.length > 0) ctx.ui.notify(`Contexto: ${files.map(({ path }) => path).join(", ")}`, "info");
			});
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.contextFiles = load(event.systemPromptOptions.cwd);
			});
		},
	};
}

export interface PiIsolation {
	args: string[];
	extensions: InlineExtension[];
}

/** Importa Pi: llamarla después de fijar las variables de entorno que Pi lee al cargarse. */
export async function isolatePi(args: readonly string[], dir: string, io: Io): Promise<PiIsolation> {
	const excluded = await excludeUserSkills(dir);
	if (!excluded) io.err(`aviso: no se pudo actualizar ${join(dir, "settings.json")}; esta sesión arranca sin skills externos`);
	const wantsContext = !args.some((arg) => CONTEXT_OPT_OUT.includes(arg));
	return {
		args: [...(excluded ? [] : ["--no-skills"]), "--no-context-files"],
		extensions: wantsContext ? [await isolatedContextExtension(dir)] : [],
	};
}
