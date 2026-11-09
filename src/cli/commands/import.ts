// `omi import pi`: vuelve a ofrecer lo que se puede traer de Pi.

import { EXIT_OK, UsageError } from "../../core/errors.ts";
import { runPiImportAgain } from "../../onboarding/pi-import.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { printJson } from "../output.ts";

export async function importCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, {});
	if (positionals.length !== 1 || positionals[0] !== "pi") throw new UsageError("uso: omi import pi");
	if (!io.interactive) throw new UsageError("omi import pi necesita una terminal: pregunta qué copiar");
	const result = await runPiImportAgain(io);
	if (values.json === true) printJson(result, io);
	else if (result.status === "skipped") io.out("No hay nada nuevo para copiar de Pi.");
	return EXIT_OK;
}
