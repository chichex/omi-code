// «Sí, y no volver a preguntar por git log *»: el prefijo que el diálogo propone para un comando simple.
// Pedido del dueño (2026-11-24), como en Claude Code: no aprobar cada variante de un mismo comando.
import { isSimpleCommand } from "./authorization.ts";

export const MAX_ALLOWED = 100;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN = new Set(["run", "exec", "x", "dlx"]);
/** Programa y subcomando; con `npm run` (y parecidos) también el script, y con `-m` el módulo. Sólo líneas simples. */
export function commandPrefix(command: string): string | undefined {
	if (!isSimpleCommand(command)) return undefined;
	const tokens = command.split(" ");
	const length = RUNNERS.has(tokens[0]!) && RUN.has(tokens[1] ?? "") || tokens[1] === "-m" ? 3 : 2;
	return tokens.slice(0, length).join(" ");
}
/** Cómo se muestra: `git log` cubre `git log` y `git log --oneline`. */
export const prefixLabel = (prefix: string): string => `${prefix} *`;
