// Integraciones del producto: se distribuyen con OMI, sin instalaciones de npm al arrancar.
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const HARNESS_KB_URL = "https://kb-prod-chiche.ohmyinfra.com/mcp";

export async function defaultExtensions(args: readonly string[], env: NodeJS.ProcessEnv): Promise<InlineExtension[]> {
	// Pi lee sus rutas al importarse; launch ya fijó PI_CODING_AGENT_DIR y PI_PACKAGE_DIR.
	const { subagentsExtension } = await import("./subagents.ts");
	const extensions: InlineExtension[] = [subagentsExtension(), {
		name: "omi-claude-bridge", builtin: true,
		async factory(pi) {
			const { loadClaudeBridge } = await import("./claude-bridge.ts");
			await (await loadClaudeBridge())(pi);
		},
	}];
	// Pi no conecta registros si builtin:mcp está desactivado. Tampoco hacer red con --offline.
	const offline = args.includes("--offline") || /^(1|true|yes)$/i.test(env.PI_OFFLINE ?? "");
	if (!args.includes("--no-mcp") && !offline) extensions.push({
		name: "omi-kb", builtin: true,
		factory(pi) {
			pi.on("session_start", () => {
				if (pi.getSettings().extensions?.includes("-builtin:mcp")) return;
				pi.registerMcpServer("harness-kb", {
					url: HARNESS_KB_URL,
					exposure: "deferred",
					description: "KB de Harness: buscar, leer y guardar documentación de producto y diseño. Requiere login OAuth desde /mcp.",
				});
			});
		},
	});
	return extensions;
}
