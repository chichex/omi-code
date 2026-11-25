// Esta política sólo decide si falta el sí al comando; nunca dispensa guardas independientes del host/proyecto.
import { artifactHash, type Workflow } from "./model.ts";
import { checkBlock, matchCommandPattern, type FoundationsBlock } from "./foundations.ts";

export type CommandAuthorization = "grant" | "auto" | "ask";
export interface CommandPolicy { block: FoundationsBlock | null; accepted: boolean }
export const NO_FOUNDATIONS: CommandPolicy = Object.freeze({ block: null, accepted: false });
/** Cambiar la receta no invalida el sí; cambiar el trabajo o pedido sí. Nunca prefijos ni globs. */
export const grantKey = (state: Workflow, command: string): string => artifactHash({ id: state.id, source: state.source.hash, command });

const RESERVED = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "select", "function", "time", "coproc", "eval", "exec", "command", "builtin", "source", "."]);
/** Puerta explícita de sintaxis, no un parser ni una evaluación semántica de ejecutables o wrappers. */
export function isSimpleCommand(command: string): boolean {
	if (!/^[A-Za-z0-9_./:@%+=,-]+(?: +[A-Za-z0-9_./:@%+=,-]+)*$/.test(command)) return false;
	const first = command.split(" ", 1)[0]!;
	return !first.includes("=") && !RESERVED.has(first);
}
export function commandAuthorization(state: Workflow, command: string, policy: CommandPolicy = NO_FOUNDATIONS): CommandAuthorization {
	const key = grantKey(state, command);
	if (state.grants?.some((grant) => grant.key === key && grant.command === command)) return "grant";
	// Sin Foundations v2 aceptada rige el default: nada pregunta. También para pins de /reload anteriores al corte.
	if (policy?.accepted !== true) return "auto";
	const checked = checkBlock(policy.block);
	if ("reason" in checked) return "auto";
	// Sin reglas no hay patrón que contrastar: lo compuesto tampoco pregunta (pedido del dueño, 2026-11-24).
	if (!checked.block.confirmar.length) return "auto";
	if (!isSimpleCommand(command)) return "ask";
	return checked.block.confirmar.some((pattern) => matchCommandPattern(pattern, command)) ? "ask" : "auto";
}
