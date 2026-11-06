// Adaptador de tools de OMI a extensiones de Pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import type { OmiTool } from "../tools/types.ts";

export function registerCatalogTools(pi: ExtensionAPI, catalog: readonly OmiTool[], io: Io): void {
	for (const tool of catalog) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			async execute(_toolCallId, params, signal) {
				const result = await tool.run(params, { io, ...(signal === undefined ? {} : { signal }) });
				return { content: [{ type: "text", text: result.text }], details: result.data };
			},
		});
	}
}
