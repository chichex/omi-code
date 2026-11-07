// Adaptador de tools de OMI a extensiones de Pi.

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { describeError } from "../core/errors.ts";
import { processRunner, type Runner } from "../core/exec.ts";
import { tuiGuard } from "../guardrails/surfaces.ts";
import type { OmiTool, ToolRuntime } from "../tools/types.ts";

const SHIP_COMMAND = /^\/skill:ship(\s|$)/;

export function registerCatalogTools(pi: ExtensionAPI, catalog: readonly OmiTool[], io: Io, runner: Runner = processRunner): void {
	// Un humano que escribe /skill:ship autoriza stage. Un mensaje del modelo o de otra
	// extensión no: sólo vale lo que entra por la terminal.
	const session = { stageAuthorized: false };
	pi.on("input", (event) => {
		if (event.source === "interactive" && SHIP_COMMAND.test(event.text.trim())) session.stageAuthorized = true;
		return { action: "continue" };
	});

	for (const tool of catalog) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			async execute(_toolCallId, params, signal, onUpdate, context: ExtensionToolContext) {
				const lines: string[] = [];
				const runtime: ToolRuntime = {
					io,
					runner,
					guard: tuiGuard(session, context.hasUI ? context.ui : undefined),
					...(signal === undefined ? {} : { signal }),
					progress: (text) => {
						lines.push(text);
						if (lines.length > 50) lines.shift();
						onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: undefined });
					},
				};
				try {
					const result = await tool.run(params, runtime);
					return { content: [{ type: "text", text: result.text }], details: result.data };
				} catch (error) {
					// Pi le pasa al modelo sólo el mensaje: el código y el hint tienen que ir ahí.
					throw new Error(describeError(error), { cause: error });
				}
			},
		});
	}
}
