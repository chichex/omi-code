// Adaptador CLI del catálogo: un subcomando es una tool con flags en vez de JSON.

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { EXIT_ERROR, EXIT_OK, OmiError, UsageError } from "../core/errors.ts";
import { processRunner } from "../core/exec.ts";
import { cliGuard } from "../guardrails/surfaces.ts";
import { CATALOG } from "../tools/catalog.ts";
import type { ToolRuntime } from "../tools/types.ts";
import type { Io } from "./io.ts";
import { printJson } from "./output.ts";

export interface ToolFlags {
	json?: boolean | undefined;
	api?: string | undefined;
	yes?: boolean | undefined;
}

/** Saca las claves sin valor: un flag ausente no es un parámetro en undefined. */
export function compact<T extends Record<string, unknown>>(params: T): T {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as T;
}

function assertParameters(name: string, schema: TSchema, params: unknown): void {
	if (Value.Check(schema, params)) return;
	const detail = [...Value.Errors(schema, params)].map((issue) => `${issue.instancePath || "/"} ${issue.message}`);
	throw new UsageError(`parámetros inválidos para ${name}: ${[...new Set(detail)].join("; ")}`, "corré `omi --help`");
}

export async function runToolCommand(
	name: string,
	params: Record<string, unknown>,
	io: Io,
	flags: ToolFlags,
	options: { streamProgress?: boolean } = {},
): Promise<number> {
	const tool = CATALOG.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new OmiError("unknown_tool", `tool desconocida: ${name}`);
	const compacted = compact(params);
	assertParameters(name, tool.parameters, compacted);
	const stream = options.streamProgress === true && flags.json !== true;
	const runtime: ToolRuntime = {
		io,
		guard: cliGuard(io, { yes: flags.yes === true }),
		runner: processRunner,
		...(flags.api === undefined ? {} : { apiUrl: flags.api }),
		progress: stream ? (line) => io.out(line) : (line) => io.err(line),
		...(io.interactive ? { readSecret: (secret: string) => io.promptHidden(`Valor de ${secret}: `) } : {}),
	};
	const result = await tool.run(compacted, runtime);
	if (flags.json === true) printJson(result.data, io);
	else if (stream && result.failed === true) io.err(result.text.split("\n").at(-1) ?? "");
	else if (!stream) io.out(result.text);
	return result.failed === true ? EXIT_ERROR : EXIT_OK;
}
