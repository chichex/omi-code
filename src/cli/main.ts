// Punto de entrada de las tres caras: TUI (`omi`), CLI (`omi <subcmd>`) y MCP (`omi mcp`).

import pkg from "../../package.json" with { type: "json" };
import { EXIT_ERROR, EXIT_OK, OmiError, UsageError } from "../core/errors.ts";
import type { Io } from "./io.ts";
import { reportError } from "./output.ts";
import { COMMANDS, HELP_ROWS, USAGE } from "./commands.ts";

export interface CliDeps {
	launchTui(args: string[], io: Io): Promise<number>;
	serveMcp(args: string[], io: Io): Promise<number>;
}

// Carga diferida: un subcomando determinístico no debe pagar el arranque de Pi.
const defaultDeps: CliDeps = {
	launchTui: async (args, io) => (await import("../tui/launch.ts")).launchTui(args, io),
	serveMcp: async (args, io) => (await import("../mcp/server.ts")).serveMcp(args, io),
};

function helpText(): string {
	const rows = HELP_ROWS.map(([name, summary]) => `  ${name.padEnd(12)}${summary}`);
	return [
		"omi: harness agéntico de codificación e infraestructura para OMI",
		"",
		"Uso:",
		"  omi [flags de Pi]        sesión TUI",
		"  omi <subcomando> [--json] [--api <url>]",
		"  omi mcp                  servidor MCP por stdio",
		"",
		"Subcomandos:",
		...rows,
		"",
		"Salida: 0 ok · 1 error de ejecución o API · 2 error de uso o guardrail bloqueado.",
	].join("\n");
}

export async function run(argv: string[], io: Io, deps: Partial<CliDeps> = {}): Promise<number> {
	const { launchTui, serveMcp } = { ...defaultDeps, ...deps };
	const [first, ...rest] = argv;
	try {
		if (first === "--version" || first === "-v") {
			// release.yml estampa package.json desde el tag: en un checkout de main esto puede quedar atrás.
			io.out(pkg.version);
			return EXIT_OK;
		}
		if (first === "--help" || first === "-h" || first === "help") {
			io.out(helpText());
			return EXIT_OK;
		}
		if (first === undefined || first.startsWith("-")) return await launchTui(argv, io);
		const usage = USAGE[first];
		if (usage !== undefined && (rest.includes("--help") || rest.includes("-h"))) {
			io.out(usage);
			return EXIT_OK;
		}
		if (first === "mcp") return await serveMcp(rest, io);
		const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
		if (command === undefined) throw new UsageError(`subcomando desconocido: ${first}`, "corré `omi --help`");
		return await command(rest, io);
	} catch (error) {
		reportError(error, io, rest.includes("--json"));
		return error instanceof OmiError ? error.exitCode : EXIT_ERROR;
	}
}
