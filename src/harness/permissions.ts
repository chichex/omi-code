// Capacidades del flujo, no un sandbox: nunca interpretar shell como si fuera sólo lectura.
import { relative, resolve, sep } from "node:path";
import type { Workflow } from "./model.ts";
import { isApproved } from "./state.ts";

export const WORKFLOW_TOOLS = ["omi_workflow", "omi_workflow_check", "omi_workflow_inspect", "omi_workflow_lens", "omi_workflow_commit"];
/** Preguntarle a la persona no cambia nada: vale en toda etapa. Su respuesta no es un acuerdo ni un permiso. */
export const ASK_TOOL = "omi_ask";
const READ = new Set(["read", "grep", "find", "ls"]);
const READ_ROLES = new Set(["scout", "planner", "reviewer"]);

export function workflowToolAllowed(state: Workflow, name: string, input: Record<string, unknown>): boolean {
	if (READ.has(name) || WORKFLOW_TOOLS.includes(name) || name === ASK_TOOL) return true;
	const implementing = state.phase === "implement" && state.status === "active" && isApproved(state) && state.steps.some((step) => step.status === "active");
	if (name === "write" || name === "edit") return implementing;
	if (name !== "subagent") return false;
	if (input.action === "status" || input.action === "result" || input.action === "cancel") return true;
	const tasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : [{ agent: input.agent }];
	if (!tasks.length || tasks.length > 8) return false;
	const workers = tasks.filter((task: unknown) => task && typeof task === "object" && "agent" in task && task.agent === "worker").length;
	if (workers && (!state.recipe || (Array.isArray(input.chain) ? 1 : workers) > state.recipe.executor.writers)) return false;
	return tasks.every((task: unknown) => {
		if (!task || typeof task !== "object" || !("agent" in task) || typeof task.agent !== "string") return false;
		return READ_ROLES.has(task.agent) || task.agent === "worker" && implementing && state.recipe?.executor.mode === "subagents";
	});
}

// Pi expande `~` y `file://` antes de escribir (resolveToCwd): el guard no los interpreta, los rechaza.
export function workflowWritePath(root: string, path: string): string {
	const raw = path.replace(/^@/, "");
	if (raw.startsWith("~") || /^file:/i.test(raw)) throw new Error("Escritura fuera del checkout del harness: usá rutas relativas al checkout, sin ~ ni file://");
	const target = resolve(root, raw); const inside = relative(resolve(root), target);
	if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || resolve(root, inside) !== target) throw new Error("Escritura fuera del checkout del harness");
	if (inside.split(sep).some((part) => part.toLowerCase() === ".git") || /(^|[/\\])(?:\.env(?!\.(?:example|sample|template|dist)$)(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.(?:json|ya?ml|toml|ini|xml|csv|txt|conf|cfg|properties|local|env))?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^/\\]+\.(?:pem|key|p12|pfx|keystore|jks))$/i.test(inside)) throw new Error("Ruta protegida: metadata Git o posible secreto");
	return target;
}
