// Flags de un subcomando, con errores de uso en vez de excepciones crudas.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "../core/errors.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON_OPTIONS = {
	json: { type: "boolean" },
	api: { type: "string" },
} as const;

export function parseFlags<O extends Options>(args: string[], options: O) {
	try {
		return parseArgs({ args, options: { ...COMMON_OPTIONS, ...options } as typeof COMMON_OPTIONS & O, allowPositionals: true, strict: true });
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error), "corré `omi --help`");
	}
}
