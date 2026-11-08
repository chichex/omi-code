// Cara TUI: arranca Pi con la configuración en ~/.omi y las tools y skills de OMI cargadas.

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { EXIT_OK } from "../core/errors.ts";
import { isDirectory } from "../core/files.ts";
import { agentDir } from "../core/paths.ts";
import { resolveRuntime } from "../core/runtime.ts";
import { AGENT_SESSION_ENV } from "../guardrails/surfaces.ts";
import { runPiImportOnboarding } from "../onboarding/pi-import.ts";
import { CATALOG } from "../tools/catalog.ts";
import { registerCatalogTools } from "./tools.ts";
import { runtimeShellExtension } from "./runtime-shell.ts";

export type PiMain = (args: string[], options: { extensionFactories?: InlineExtension[] }) => Promise<void>;

export interface LaunchDeps {
	piMain?: PiMain;
	skillsDir?: string;
	/** Fuerza la resolución de assets de un binario instalado. */
	compiled?: boolean;
}

async function embeddedSkills(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = (await readdir(dir)).sort();
	} catch {
		return [];
	}
	const skills: string[] = [];
	for (const name of names) {
		const path = join(dir, name);
		if ((await stat(path)).isDirectory()) skills.push(path);
	}
	return skills;
}

export function omiToolsExtension(io: Io): InlineExtension {
	return { name: "omi-tools", factory: (pi: ExtensionAPI) => registerCatalogTools(pi, CATALOG, io) };
}

export async function launchTui(args: string[], io: Io, deps: LaunchDeps = {}): Promise<number> {
	await runPiImportOnboarding(io);
	const dir = agentDir(io.homeDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// Pi lee esta variable al resolver sus rutas: tiene que estar antes de importarlo.
	process.env.PI_CODING_AGENT_DIR = dir;
	// Lo heredan los comandos que corra el agente: ahí `--yes` no puede valer.
	process.env[AGENT_SESSION_ENV] = "1";
	const runtime = await resolveRuntime(io.homeDir, deps.compiled);
	if (runtime.packageDir !== undefined) {
		process.env.PI_PACKAGE_DIR = runtime.packageDir;
		process.env.OMI_RUNTIME_DIR = runtime.packageDir;
	}
	const { embeddedExtensions } = await import("./extensions.ts");
	const piMain = deps.piMain ?? (await import("@earendil-works/pi-coding-agent")).main;

	const skills = await embeddedSkills(deps.skillsDir ?? runtime.skillsDir);
	const skillArgs = skills.flatMap((path) => ["--skill", path]);
	const themeArgs = (await isDirectory(runtime.themesDir)) ? ["--theme", runtime.themesDir] : [];
	const processExtensions = runtime.packageDir === undefined ? [] : [await runtimeShellExtension(io)];
	await piMain([...skillArgs, ...themeArgs, ...args], { extensionFactories: [omiToolsExtension(io), ...processExtensions, ...embeddedExtensions()] });
	return typeof process.exitCode === "number" ? process.exitCode : EXIT_OK;
}
