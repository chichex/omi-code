// Conserva las operaciones y renderers nativos de Pi, aislando sólo el entorno del hijo.
import { delimiter, join } from "node:path";
import type { BashOperations, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Io } from "../cli/io.ts";
import { agentDir } from "../core/paths.ts";
import { childEnvironment } from "../core/process-environment.ts";

export async function runtimeShellExtension(io: Io): Promise<InlineExtension> {
	const { createBashToolDefinition, createLocalBashOperations } = await import("@earendil-works/pi-coding-agent");
	const local = createLocalBashOperations();
	const operations: BashOperations = {
		exec: (command, cwd, options) => {
			const env = options.env ?? { ...process.env, PATH: [join(agentDir(io.homeDir), "bin"), process.env.PATH ?? ""].join(delimiter) };
			return local.exec(command, cwd, { ...options, env: childEnvironment(env) });
		},
	};
	return {
		name: "omi-runtime-shell",
		factory: (pi) => {
			pi.registerTool(createBashToolDefinition(io.cwd, { operations }));
			pi.on("user_bash", () => ({ operations }));
		},
	};
}
