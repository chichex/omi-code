// Lo que tiene que ser cierto antes de publicar, sin importar el modo.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { OmiError } from "../core/errors.ts";
import type { CommandResult, CommandOptions, Runner } from "../core/exec.ts";
import type { ServiceLink } from "../project/link.ts";
import { workflowPath } from "../project/kit.ts";

const CONTRACT_ROUTES = ["/health", "/version"];
// El kit y el workflow nombran las rutas: que aparezcan ahí no prueba que el service las sirva.
const NOT_SERVICE_CODE = [":(exclude).omi", ":(exclude).github"];

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

export async function runChecked(runner: Runner, command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
	let result: CommandResult;
	try {
		result = await runner.run(command, args, options);
	} catch (error) {
		throw new OmiError("tool_missing", `no pude ejecutar ${command}`, { hint: `instalalo y reintentá`, cause: error });
	}
	if (result.code !== 0) {
		throw new OmiError("publish_failed", `${command} ${args[0] ?? ""} falló: ${result.stderr.trim().slice(-500)}`);
	}
	return result;
}

export async function assertCleanTree(root: string, runner: Runner): Promise<void> {
	const { stdout } = await runChecked(runner, "git", ["status", "--porcelain"], { cwd: root });
	if (stdout.trim() !== "") {
		throw new OmiError("dirty_tree", "el árbol de git tiene cambios sin commitear", { hint: "commiteá o descartá los cambios antes de publicar" });
	}
}

export async function assertServiceContract(root: string, service: ServiceLink, runner: Runner): Promise<void> {
	const missing: string[] = [];
	for (const route of CONTRACT_ROUTES) {
		const { code, stdout } = await runner.run("git", ["grep", "-l", "-F", "-e", route, "--", service.path, ...NOT_SERVICE_CODE], { cwd: root });
		if (code !== 0 || stdout.trim() === "") missing.push(route);
	}
	if (missing.length > 0) {
		throw new OmiError("contract_unmet", `${service.name} no expone ${missing.join(" ni ")}`, {
			hint: "el kit exige /health y /version: revisá .omi/kit",
		});
	}
	const dockerfile = join(root, service.path, service.dockerfile);
	if (!(await exists(dockerfile))) {
		throw new OmiError("contract_unmet", `falta el Dockerfile de ${service.name} en ${dockerfile}`, { hint: "`omi init` lo genera" });
	}
}

export async function assertWorkflow(root: string, service: ServiceLink): Promise<void> {
	if (!(await exists(join(root, workflowPath(service.name))))) {
		throw new OmiError("contract_unmet", `falta ${workflowPath(service.name)}: nadie publicaría el tag`, { hint: "`omi init` lo genera" });
	}
}
