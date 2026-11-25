// Título del PR draft que abre el harness: un commit convencional. Al mergear con squash, GitHub usa el título
// del PR como asunto del commit en main, y un release continuo decide la versión por ese asunto (en omi-code,
// scripts/next-release.ts: feat sube el minor). Lógica pura, sin Git ni GitHub: publicar vive en github.ts.
import type { Recipe, Workflow } from "./model.ts";
import { stackTitle } from "./stack.ts";
import { currentRecoveryWorkspace } from "./workflow-context.ts";

// Como el gate de commits: tipo, scope opcional en minúsculas, ! opcional y ": " antes del resumen.
const CONVENTIONAL = /^(?:feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert)(?:\([a-z0-9-]+\))?!?: (.+)$/;
// Una Mejora cambia comportamiento visible: es feat, como una capacidad nueva.
const COMMIT_TYPE: Record<Recipe["classification"]["type"], string> = { add: "feat", improve: "feat", fix: "fix", chore: "chore" };

/** El título del issue si ya es convencional; si no, con el tipo de la receta aprobada adelante. Sin receta, igual. */
function conventionalTitle(w: Workflow): string {
	const type = w.recipe?.classification.type;
	return !type || CONVENTIONAL.test(w.source.title) ? w.source.title : `${COMMIT_TYPE[type]}: ${w.source.title}`;
}
/** Un fix-forward corrige un PR ya mergeado: siempre fix, sin el tipo, el scope ni el ! del título del issue. */
const fixForwardTitle = (title: string): string => `fix: ${CONVENTIONAL.exec(title)?.[1] ?? title}`;
// GitHub rechaza un título de más de 256 caracteres. El tipo de adelante puede pasar de ese límite a un título de
// issue que sí entraba: se recorta el final del resumen, con «…», y se conservan el tipo y el sufijo del stack.
const MAX_TITLE = 256;
function fit(title: string, room = MAX_TITLE): string {
	const chars = Array.from(title);
	return chars.length <= room ? title : `${chars.slice(0, room - 1).join("")}…`;
}

/** Título del PR único o, con position, del PR de ese índice en el stack: el tipo va una vez, al principio. */
export function pullRequestTitle(workflow: Workflow, position?: { index: number }): string {
	// El fix-forward publica desde su checkout de recuperación, nunca desde el del trabajo.
	if (currentRecoveryWorkspace(workflow)?.checkout.branch === workflow.checkout.branch) return fit(fixForwardTitle(workflow.source.title));
	const title = conventionalTitle(workflow);
	const pulls = position && workflow.publication.status !== "none" ? workflow.publication.stack : undefined;
	if (!pulls || !position) return fit(title);
	const suffix = Array.from(stackTitle("", pulls, position.index)).length;
	return stackTitle(fit(title, MAX_TITLE - suffix), pulls, position.index);
}
