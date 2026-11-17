// Disponibilidad local de Claude Code: no ejecuta el CLI ni lee/verifica credenciales.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export function configuredClaudeCode(agent: string): string {
	try {
		const config: unknown = JSON.parse(readFileSync(join(agent, "claude-bridge.json"), "utf8"));
		if (config && typeof config === "object" && "provider" in config) {
			const provider = config.provider;
			if (provider && typeof provider === "object" && "pathToClaudeCodeExecutable" in provider && typeof provider.pathToClaudeCodeExecutable === "string") return provider.pathToClaudeCodeExecutable;
		}
	} catch { /* El loader upstream informa configuraciones ilegibles; no habilitar fuentes ajenas. */ }
	return "claude";
}

export function claudeCodeAvailable(executable: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const candidates = executable.includes("/") ? [resolve(executable)] : (env.PATH ?? "/usr/bin:/bin").split(delimiter).map((directory) => resolve(directory, executable));
	return candidates.some((path) => {
		try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
		catch { return false; }
	});
}

export function requireClaudeCode(executable: string, agent: string, env: NodeJS.ProcessEnv = process.env): void {
	if (claudeCodeAvailable(executable, env)) return;
	throw new Error(`Claude Code no está disponible en ${JSON.stringify(executable)}. Instalalo (https://code.claude.com/docs/en/setup) y ejecutá claude auth login fuera de OMI. Si ya está instalado, configurá provider.pathToClaudeCodeExecutable en ${join(agent, "claude-bridge.json")} y reiniciá OMI o usá /reload.`);
}

/** Selecciones explícitas reciben orientación OMI antes del error genérico de auth de Pi. */
export async function validateClaudeBridgeSelection(args: string[], agent: string): Promise<void> {
	const { parseArgs } = await import("@earendil-works/pi-coding-agent");
	const parsed = parseArgs(args);
	if (parsed.noExtensions || parsed.help || parsed.listModels || parsed.export) return;
	if (parsed.provider?.trim().toLowerCase() === "claude-bridge" || parsed.model?.trim().toLowerCase().startsWith("claude-bridge/")) requireClaudeCode(configuredClaudeCode(agent), agent);
}
