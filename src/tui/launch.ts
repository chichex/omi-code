// Cara TUI: arranca Pi con la configuración en ~/.omi y las tools de OMI cargadas.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { EXIT_OK } from "../core/errors.ts";
import { agentDir } from "../core/paths.ts";
import { overrideInHost } from "../core/process-environment.ts";
import { resolveRuntime } from "../core/runtime.ts";
import { AGENT_SESSION_ENV } from "../guardrails/surfaces.ts";
import { runPiImportOnboarding } from "../onboarding/pi-import.ts";
import { CATALOG } from "../tools/catalog.ts";
import { codemodeDefaultExtension, defaultExtensions, harnessKb } from "./defaults.ts";
import { herdrExtension } from "./herdr.ts";
import { isolatePi } from "./isolation.ts";
import { linkBundledTools } from "./managed-tools.ts";
import { ensureModelDefaults } from "./model-defaults.ts";
import { registerCatalogTools } from "./tools.ts";
import { runtimeShellExtension } from "./runtime-shell.ts";
import { workspaceExtension } from "./workspace/index.ts";

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
	await ensureModelDefaults(dir);
	// Pi lee esta variable al resolver sus rutas: tiene que estar antes de importarlo.
	process.env.PI_CODING_AGENT_DIR = dir;
	// Lo heredan los comandos que corra el agente: ahí `--yes` no puede valer.
	process.env[AGENT_SESSION_ENV] = "1";
	const runtime = await resolveRuntime(io.homeDir, deps.compiled);
	if (runtime.packageDir !== undefined) process.env.PI_PACKAGE_DIR = runtime.packageDir;
	// Instalación limpia: Pi no baja fd ni rg de GitHub; usa los del runtime si el PATH no los trae.
	// Si no se puede enlazar (un FAT sin symlinks, <agent>/bin que es un archivo), Pi sigue como antes.
	if (runtime.toolsDir !== undefined) {
		await linkBundledTools(join(dir, "bin"), runtime.toolsDir, process.env.PATH).catch((error: unknown) => {
			io.err(`aviso: no se pudieron enlazar fd y rg del runtime en ${join(dir, "bin")} (${error instanceof Error ? error.message : String(error)}); Pi usa los del PATH o los baja`);
		});
	}
	const piMain = deps.piMain ?? (await import("@earendil-works/pi-coding-agent")).main;

	const isolation = await isolatePi(args, dir, io);
	const { developmentHarnessExtension } = await import("./development.ts");
	// El workspace usa fullscreen; --tui-mode explícito gana y OMI_TUI=classic conserva el arranque anterior.
	const workspace = io.env.OMI_TUI !== "classic";
	const kb = harnessKb(args, io.env, dir);
	const presentation = workspace ? ["--tui-mode", "fullscreen"] : [];
	// codemode va antes del harness: el harness toma ese loadout y lo restringe.
	const extensions = [omiToolsExtension(io), await runtimeShellExtension(io), herdrExtension(io, args), workspaceExtension(io, args), await codemodeDefaultExtension(args), developmentHarnessExtension(io, args, { kb }), ...isolation.extensions, ...await defaultExtensions(args, io.env, kb)];
	// Son componentes del producto, no extensiones que el usuario deba administrar.
	if (workspace) for (const extension of extensions) if (typeof extension !== "function") extension.hidden = true;
	// Pi viene fijado dentro de OMI: actualizarlo por separado rompe el contrato del layout.
	// No usar PI_OFFLINE: deben seguir funcionando proveedores, catálogos y extensiones del usuario.
	const skipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
	if (workspace) process.env.PI_SKIP_VERSION_CHECK = "1";
	// Instalación limpia: Pi no reporta a pi.dev la instalación ni cada actualización, ni se atribuye
	// las llamadas a proveedores. Gana sobre el shell y los ajustes; los comandos ven el valor del usuario.
	const restoreTelemetry = overrideInHost("PI_TELEMETRY", "0");
	try {
		await piMain([...presentation, ...isolation.args, ...args], { extensionFactories: extensions });
	} finally {
		restoreTelemetry();
		if (skipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
		else process.env.PI_SKIP_VERSION_CHECK = skipVersionCheck;
	}
	return typeof process.exitCode === "number" ? process.exitCode : EXIT_OK;
}
