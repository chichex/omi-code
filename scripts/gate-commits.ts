// Gate de commits convencionales (AGENTS.md): cada commit sin merges entre BASE y HEAD.
// Es un comando simple a propósito: con Foundations, una línea con `;`, `|` o `$( )` pide sí.
// Uso: node scripts/gate-commits.ts <base>. Sale 0 con CONVENTIONAL_COMMITS=PASS; 1 si falla; 2 sin base.
import { gitBase, git } from "./gate-git.ts";

const CONVENTIONAL = /^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert)(\([a-z0-9-]+\))?!?: .+/;
const base = gitBase("gate-commits.ts");
const subjects = git(["log", "--no-merges", "--format=%s", `${base}..HEAD`]).split("\n").filter((subject) => subject !== "");
const invalid = subjects.filter((subject) => !CONVENTIONAL.test(subject));
if (invalid.length) {
	console.log(`Commits que no son convencionales (tipo(scope)?: resumen):\n${invalid.join("\n")}`);
	process.exit(1);
}
console.log(`CONVENTIONAL_COMMITS=PASS (${subjects.length} ${subjects.length === 1 ? "commit" : "commits"})`);
