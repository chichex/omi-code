// «Sí, y no volver a preguntar por git log *»: el prefijo que el diálogo propone para un comando simple.
// Pedido del dueño (2026-11-24), como en Claude Code: no aprobar cada variante de un mismo comando.
import { isSimpleCommand } from "./authorization.ts";

export const MAX_ALLOWED = 100;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN = new Set(["run", "exec", "x", "dlx"]);
// Corren otro programa que viene después: `env A=1 sh` o `sudo rm` no tienen un subcomando propio que permitir.
const WRAPPERS = new Set(["env", "sudo", "doas", "xargs", "nohup", "nice", "timeout", "watch", "exec", "command", "builtin"]);
// Un subcomando de verdad: ni una opción (`git -c x` corre código con core.sshCommand) ni una asignación.
const word = (token: string | undefined): token is string => token !== undefined && !token.startsWith("-") && !token.includes("=");
/** Programa y subcomando; con `npm run` (y parecidos) también el script, y con `-m` el módulo. Sólo líneas simples,
 * con al menos un subcomando: `git` solo no propone `git *`, que ganaría sobre una regla `git push *`. */
export function commandPrefix(command: string): string | undefined {
	if (!isSimpleCommand(command)) return undefined;
	const [program, second, third] = command.split(" ");
	if (WRAPPERS.has(program!)) return undefined;
	if (second === "-m") return word(third) ? `${program} -m ${third}` : undefined;
	if (!word(second)) return undefined;
	if (!RUNNERS.has(program!) || !RUN.has(second)) return `${program} ${second}`;
	return word(third) ? `${program} ${second} ${third}` : undefined;
}
/** Cómo se muestra: `git log` cubre `git log` y `git log --oneline`. */
export const prefixLabel = (prefix: string): string => `${prefix} *`;
