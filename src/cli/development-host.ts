// Host mínimo de la KB para `omi init --development`: un runtime SDK de Pi en memoria, sin modelo ni prompts.
// Reusa el builtin MCP, mcp-auth.json y los locks de <OMI_HOME>/agent que usa la TUI: sin login no abre otro
// OAuth, la KB queda no disponible. Sin extensiones, skills ni contexto del usuario. El cierre emite
// session_shutdown y espera que MCP cierre sus conexiones: dispose() solo no las cierra.
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../core/paths.ts";
import { overrideInHost } from "../core/process-environment.ts";
import { HARNESS_KB_URL } from "../tui/defaults.ts";
import { createKbClient, KbUnavailableError, type KbClient } from "../tui/kb-client.ts";
import type { Io } from "./io.ts";
import type { DevelopmentHost } from "./init-development.ts";

// Sin el store OAuth de MCP no hubo login de la KB: no se arranca Pi, que crearía sus stores vacíos.
function withoutLogin(url: string, dir: string): KbClient {
	const reason = `sin login de la KB en omi (no hay ${join(dir, "mcp-auth.json")}); iniciá sesión desde /mcp en la TUI`;
	const fail = async (): Promise<never> => { throw new KbUnavailableError(reason); };
	return { url, ready: async () => ({ ready: false, reason }), products: fail, currentPerillas: fail, read: fail, save: fail };
}
/** url sólo cambia en tests, hacia la KB falsa en loopback. */
export async function headlessKbHost(io: Io, signal: AbortSignal, url = HARNESS_KB_URL): Promise<DevelopmentHost> {
	const dir = agentDir(io.homeDir), offline = /^(1|true|yes)$/i.test(io.env.PI_OFFLINE ?? ""), kb = createKbClient({ url, agentDir: dir, enabled: !offline });
	// Offline: el cliente reporta «sin red» y no se arranca nada.
	if (offline) return { kb, close: async () => {} };
	if (!await access(join(dir, "mcp-auth.json")).then(() => true, () => false)) return { kb: withoutLogin(url, dir), close: async () => {} };
	signal.throwIfAborted();
	// Pi lee esta variable al resolver sus rutas: tiene que estar antes de importarlo.
	process.env.PI_CODING_AGENT_DIR = dir;
	const restoreTelemetry = overrideInHost("PI_TELEMETRY", "0");
	try {
		const pi = await import("@earendil-works/pi-coding-agent");
		const register: InlineExtension = { name: "omi-kb", factory(api) {
			api.on("session_start", () => {
				if (api.getSettings().extensions?.includes("-builtin:mcp")) return;
				api.registerMcpServer("harness-kb", { url, exposure: "deferred", description: "KB de Harness. Requiere login OAuth desde /mcp." });
			});
		} };
		const mcp: InlineExtension = { name: "omi-kb-mcp", factory: kb.extension().factory };
		const runtime = await pi.createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await pi.createAgentSessionServices({ cwd, agentDir: dir, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [register, mcp] } });
			return { ...(await pi.createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) })), services, diagnostics: services.diagnostics };
		}, { cwd: io.cwd, agentDir: dir, sessionManager: pi.SessionManager.inMemory() });
		await runtime.session.bindExtensions({});
		return { kb, close: async () => { try { await runtime.dispose(); } finally { restoreTelemetry(); } } };
	} catch (error) { restoreTelemetry(); throw error; }
}
