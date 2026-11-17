// Adaptador del paquete upstream: comparte los módulos del host y usa Claude Code instalado,
// no el binario opcional del SDK (específico de plataforma y no distribuido por OMI).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isCompiledBinary } from "../core/paths.ts";

export function claudeQueryOptions(options: Options = {}): Options {
	const env = { ...(options.env ?? process.env) };
	delete env.PI_PACKAGE_DIR;
	// Claude Code aporta autenticación, no configuración de otro harness ni hooks externos.
	return { ...options, env, settingSources: [], pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? "claude" };
}

export async function loadClaudeBridge(): Promise<ExtensionFactory> {
	const [{ createJiti }, ai, compat, coding, sdk] = await Promise.all([
		import("jiti/static"), import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/compat"),
		import("@earendil-works/pi-coding-agent"), import("@anthropic-ai/claude-agent-sdk"),
	]);
	const entry = isCompiledBinary()
		? join(coding.getPackageDir(), "claude-bridge/src/index.js")
		: fileURLToPath(import.meta.resolve("pi-claude-bridge/src/index.ts"));
	// Igual que el loader de Pi, jiti resuelve los .js del paquete a sus fuentes .ts.
	// Los virtualModules evitan copias de Pi y resolución a node_modules fuera del binario.
	const jiti = createJiti(import.meta.url, {
		tryNative: false,
		moduleCache: false,
		virtualModules: {
			"@earendil-works/pi-ai": ai,
			"@earendil-works/pi-ai/compat": compat,
			"@earendil-works/pi-coding-agent": coding,
			"@anthropic-ai/claude-agent-sdk": {
				query: (params: Parameters<typeof sdk.query>[0]) => sdk.query({ ...params, options: claudeQueryOptions(params.options) }),
			},
		},
	});
	const factory = await jiti.import<unknown>(entry, { default: true }).catch((error: unknown) => {
		throw new Error(`claude_bridge_load_failed: ${String(error)}`, { cause: error });
	});
	if (typeof factory !== "function") throw new Error("claude_bridge_invalid_extension");
	return (pi) => factory(pi);
}
