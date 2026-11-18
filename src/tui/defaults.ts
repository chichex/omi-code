// Integraciones del producto: se distribuyen con OMI, sin instalaciones de npm al arrancar.
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const HARNESS_KB_URL = "https://kb-prod-chiche.ohmyinfra.com/mcp";

/** Codemode activo por defecto, como un `defaultTools: ["+codemode"]` debajo de los ajustes y la CLI. */
export async function codemodeDefaultExtension(args: readonly string[]): Promise<InlineExtension> {
	const { parseArgs } = await import("@earendil-works/pi-coding-agent");
	const cli = parseArgs([...args]);
	// Reglas de Pi: una lista sólo de +name/-name hereda el default; con nombres, o vacía, lo reemplaza.
	const inherits = (list?: readonly string[]) => list === undefined
		|| (list.length > 0 && list.every((entry) => /^[+-]/.test(entry)) && list.findLast((entry) => entry.slice(1) === "codemode") !== "-codemode");
	return { name: "omi-codemode", factory(pi) {
		pi.on("session_start", () => {
			if (cli.noTools || cli.noBuiltinTools || !inherits(cli.tools) || !inherits(pi.getSettings().defaultTools)) return;
			// Pi ignora nombres sin registrar: -builtin:codemode, --no-extensions o --exclude-tools lo dejan afuera.
			pi.setActiveTools([...new Set([...pi.getActiveTools(), "codemode"])]);
		});
	} };
}

export async function defaultExtensions(args: readonly string[], env: NodeJS.ProcessEnv): Promise<InlineExtension[]> {
	// Pi lee sus rutas al importarse; launch ya fijó PI_CODING_AGENT_DIR y PI_PACKAGE_DIR.
	const { subagentsExtension } = await import("./subagents.ts");
	const extensions: InlineExtension[] = [subagentsExtension(), {
		name: "omi-claude-bridge", builtin: true,
		async factory(pi) {
			const { loadClaudeBridge } = await import("./claude-bridge.ts");
			await (await loadClaudeBridge(args))(pi);
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
