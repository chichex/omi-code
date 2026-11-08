// Salida común: legible por defecto, JSON con --json. Los errores van a stderr.

import { OmiError } from "../core/errors.ts";
import type { Io } from "./io.ts";

export function printJson(value: unknown, io: Io): void {
	io.out(JSON.stringify(value, null, 2));
}

export function reportError(error: unknown, io: Io, json: boolean): void {
	const code = error instanceof OmiError ? error.code : "internal_error";
	const message = error instanceof Error ? error.message : String(error);
	const hint = error instanceof OmiError ? error.hint : undefined;
	if (json) {
		io.err(JSON.stringify({ error: { code, message, ...(hint === undefined ? {} : { hint }) } }));
		return;
	}
	io.err(`omi: ${message}`);
	if (hint !== undefined) io.err(`  ${hint}`);
}
