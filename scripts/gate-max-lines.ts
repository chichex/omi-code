// Gate de máximo 500 líneas por archivo .ts que no es test (AGENTS.md), sobre lo que cambió entre BASE y HEAD.
// Cuenta líneas como `wc -l`: saltos de línea. Uso: node scripts/gate-max-lines.ts <base>.
// Sale 0 con MAX_LINES=PASS; 1 si algún archivo pasa el máximo; 2 sin base.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitBase, git, repoRoot } from "./gate-git.ts";

const MAX = 500;
const base = gitBase("gate-max-lines.ts");
const root = repoRoot();
// -z: rutas tal cual, sin las comillas y escapes que git pone a las que no son ASCII (src/acción.ts).
const files = git(["diff", "-z", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "*.ts"], root).split("\0").filter((file) => file !== "" && !file.endsWith(".test.ts"));
let failed = false;
for (const file of files) {
	const count = (readFileSync(join(root, file), "utf8").match(/\n/g) ?? []).length;
	if (count > MAX) { console.log(`FALLA ${file} (${count} > ${MAX})`); failed = true; }
}
if (failed) process.exit(1);
console.log("MAX_LINES=PASS");
