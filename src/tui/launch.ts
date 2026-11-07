// Cara TUI: arranca Pi con la configuración en ~/.omi y las tools y skills de OMI cargadas.

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { EXIT_OK } from "../core/errors.ts";
import { agentDir } from "../core/paths.ts";
import { runPiImportOnboarding } from "../onboarding/pi-import.ts";
import { CATALOG } from "../tools/catalog.ts";
import { registerCatalogTools } from "./tools.ts";

export type PiMain = (args: string[], options: { extensionFactories?: InlineExtension[] }) => Promise<void>;

export interface LaunchDeps {
	piMain?: PiMain;
	skillsDir?: string;
}

const DEFAULT_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

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
	const piMain = deps.piMain ?? (await import("@earendil-works/pi-coding-agent")).main;

	const skills = await embeddedSkills(deps.skillsDir ?? DEFAULT_SKILLS_DIR);
	const skillArgs = skills.flatMap((path) => ["--skill", path]);
	await piMain([...skillArgs, ...args], { extensionFactories: [omiToolsExtension(io)] });
	return typeof process.exitCode === "number" ? process.exitCode : EXIT_OK;
}
