// Cara TUI: arranca Pi con la configuración en ~/.omi y las tools de OMI cargadas.

import { mkdir } from "node:fs/promises";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { EXIT_OK } from "../core/errors.ts";
import { agentDir } from "../core/paths.ts";
import { resolveRuntime } from "../core/runtime.ts";
import { AGENT_SESSION_ENV } from "../guardrails/surfaces.ts";
import { runPiImportOnboarding } from "../onboarding/pi-import.ts";
import { CATALOG } from "../tools/catalog.ts";
import { isolatePi } from "./isolation.ts";
import { registerCatalogTools } from "./tools.ts";
import { runtimeShellExtension } from "./runtime-shell.ts";

export type PiMain = (args: string[], options: { extensionFactories?: InlineExtension[] }) => Promise<void>;

export interface LaunchDeps {
	piMain?: PiMain;
	/** Fuerza la resolución de assets de un binario instalado. */
	compiled?: boolean;
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
	if (runtime.packageDir !== undefined) process.env.PI_PACKAGE_DIR = runtime.packageDir;
	const piMain = deps.piMain ?? (await import("@earendil-works/pi-coding-agent")).main;

	const isolation = await isolatePi(args, dir, io);
	await piMain([...isolation.args, ...args], { extensionFactories: [omiToolsExtension(io), await runtimeShellExtension(io), ...isolation.extensions] });
	return typeof process.exitCode === "number" ? process.exitCode : EXIT_OK;
}
