// Adaptador del paquete upstream: comparte los módulos del host y usa Claude Code instalado,
// no el binario opcional del SDK (específico de plataforma y no distribuido por OMI).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI, ExtensionFactory, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { isCompiledBinary } from "../core/paths.ts";
import { claudeCodeAvailable, configuredClaudeCode, requireClaudeCode, validateClaudeBridgeSelection } from "./claude-code.ts";

export function claudeQueryOptions(options: Options = {}): Options {
	const env = { ...(options.env ?? process.env) };
	delete env.PI_PACKAGE_DIR;
	// Claude Code aporta autenticación, no configuración de otro harness ni hooks externos.
	return { ...options, env, settingSources: [], pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? "claude" };
}

export async function loadClaudeBridge(args: readonly string[] = []): Promise<ExtensionFactory> {
	const [{ createJiti }, ai, compat, coding, sdk] = await Promise.all([
		import("jiti/static"), import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/compat"),
		import("@earendil-works/pi-coding-agent"), import("@anthropic-ai/claude-agent-sdk"),
	]);
	const agent = coding.getAgentDir(); const executable = configuredClaudeCode(agent);
	await validateClaudeBridgeSelection([...args], agent);
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
				query: (params: Parameters<typeof sdk.query>[0]) => {
					const options = claudeQueryOptions(params.options);
					requireClaudeCode(options.pathToClaudeCodeExecutable ?? "claude", agent, options.env);
					return sdk.query({ ...params, options });
				},
			},
		},
	});
	const factory = await jiti.import<unknown>(entry, { default: true }).catch((error: unknown) => {
		throw new Error(`claude_bridge_load_failed: ${String(error)}`, { cause: error });
	});
	if (typeof factory !== "function") throw new Error("claude_bridge_invalid_extension");
	return (pi) => factory({ ...pi, registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
		if (typeof providerOrName !== "string") { pi.registerProvider(providerOrName); return; }
		if (!config) throw new Error("claude_bridge_invalid_provider");
		if (providerOrName !== "claude-bridge") { pi.registerProvider(providerOrName, config); return; }
		// Pi marca el registro legacy configurado sincrónicamente. Conservarlo cuando hay
		// ejecutable evita una carrera de sus refreshes al elegir el primer modelo.
		if (claudeCodeAvailable(executable)) pi.registerProvider(providerOrName, config);
		else pi.registerProvider(claudeBridgeProvider(config, executable, agent, ai.createProvider));
	} } satisfies ExtensionAPI);
}

/** Sustituye sólo el marcador de auth upstream: el catálogo y el streaming siguen siendo suyos. */
function claudeBridgeProvider(config: ProviderConfig, executable: string, agent: string, createProvider: typeof import("@earendil-works/pi-ai").createProvider): Provider {
	const { api, baseUrl, streamSimple, models } = config;
	if (!api || !baseUrl || !streamSimple || !models || models.some((model) => model.type && model.type !== "chat")) throw new Error("claude_bridge_invalid_provider");
	return createProvider({
		id: "claude-bridge", baseUrl,
		models: models.filter((model) => model.type !== "image" && model.type !== "classifier").map((entry) => {
			const { inputLimits, thinkingLevelMap, promptCache, samplingParams, compat, ...model } = entry;
			return { ...model, api: model.api ?? api, baseUrl: model.baseUrl ?? baseUrl, provider: "claude-bridge",
				...(inputLimits ? { inputLimits } : {}), ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(promptCache ? { promptCache } : {}),
				...(samplingParams ? { samplingParams } : {}), ...(compat ? { compat } : {}),
			};
		}),
		api: { stream: streamSimple, streamSimple },
		// Un apiKey explícito en models.json puede declarar auth configurada en Pi: no volver
		// disponibles modelos sin ejecutable por ese overlay (ni ejecutar sus comandos de auth).
		filterModels: (catalog) => claudeCodeAvailable(executable) ? catalog : [],
		auth: { apiKey: {
			name: "Claude Code externo",
			async check() { return claudeCodeAvailable(executable) ? { type: "api_key", source: "Claude Code local (login no verificado)" } : undefined; },
			async resolve({ credential }) {
				requireClaudeCode(executable, agent);
				return { auth: { apiKey: "not-used" }, ...(credential?.env ? { env: credential.env } : {}), source: "Claude Code externo" };
			},
		} },
	});
}
