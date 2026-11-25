// Lo común a los gates de AGENTS.md: la base del argumento, validada, y git en el repo del cwd.
import { execFileSync } from "node:child_process";

export function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...(cwd ? { cwd } : {}) });
}
/** La raíz del repo: los pathspecs se leen desde el cwd y las rutas que informa git, desde la raíz. */
export const repoRoot = (): string => git(["rev-parse", "--show-toplevel"]).trim();
/** La base del único argumento. Sin ella sale con 2; si no es un commit, con 1 y sin decir PASS. */
export function gitBase(script: string): string {
	const base = process.argv[2];
	if (!base || process.argv.length > 3) { console.error(`Uso: node scripts/${script} <base>. Por ejemplo: node scripts/${script} origin/main`); process.exit(2); }
	try { execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" }); }
	catch { console.log(`BASE inválido: ${base}`); process.exit(1); }
	return base;
}
