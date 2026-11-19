// El stack de PRs en la sesión: qué muestra el sí del push, cómo se publica y cómo se actualiza después.
// Actualizar usa el mismo permiso que el push del PR draft (push_pr de Foundations).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { processRunner, type Runner } from "../core/exec.ts";
import { publishDraft, type Published } from "../harness/github.ts";
import type { Workflow } from "../harness/model.ts";
import { planStack, stackGroups } from "../harness/stack.ts";
import { publishStack } from "../harness/stack-publish.ts";
import { syncStack } from "../harness/stack-sync.ts";
import { updateIssueSection } from "./development-issue.ts";
import type { DevelopmentSession } from "./development-session.ts";

/** Lo que el sí del push muestra: la rama, o cada rama del stack con su base, sus pasos y su commit. */
export function publishTargets(state: Workflow, head: string): string {
	if (!stackGroups(state)) return `${state.checkout.branch} → main\nCommit ${head}`;
	const pulls = state.publication.status === "pending" && state.publication.stack ? state.publication.stack : planStack(state, head);
	return [`Stack de ${pulls.length} PRs draft, en orden; sólo el último cierra el issue:`, ...pulls.map((p, i) => `${i + 1}. ${p.branch} → ${p.base} · ${p.steps.join(", ")} · commit ${p.head.slice(0, 12)}`)].join("\n");
}
/** El PR único o el stack, con el recibo que espera el evento published. */
export function publishWork(state: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<Published & { stack?: { number: number; url: string }[] }> {
	return state.publication.status === "pending" && state.publication.stack ? publishStack(state, runner, signal) : publishDraft(state, runner, signal);
}
const SYNC = "Lee los PRs en GitHub. Si cambió uno de abajo, lo mergea en el de arriba con un commit de merge (sin rebase) y hace push normal de esa rama. Si uno de abajo se mergeó a main, al de arriba le mergea main y lo re-apunta a main. Un conflicto frena antes de escribir. No mergea PRs, no fuerza pushes ni ejecuta workflows.";
export async function syncWorkStack(session: DevelopmentSession, ctx: ExtensionContext): Promise<void> {
	const state = session.current(ctx);
	if (state.publication.status !== "opened" || !state.publication.stack) throw new Error("Este trabajo no publicó un stack de PRs");
	if (session.offline) throw new Error("Actualizar el stack necesita GitHub; quitá --offline");
	const remote = `Stack de ${state.publication.stack.length} PRs · issue #${state.source.number}\n\n${SYNC}`;
	if ((await session.foundations.policy(ctx, state)).politica.push_pr === "auto") ctx.ui.notify(`Foundations · push + PR draft auto: sin preguntar.\n${remote}`, "info");
	else if (!(await session.confirm(ctx, "Actualizar el stack de PRs", remote))) return;
	session.emit("Actualizando el stack de PRs");
	const result = await syncStack(state, session.runner, session.lifecycle.signal);
	// Sin cambios no se reescribe el estado ni el issue.
	if (JSON.stringify(result.stack) !== JSON.stringify(state.publication.stack)) {
		await session.apply({ type: "stack_synced", stack: result.stack }, ctx);
		await updateIssueSection(session, ctx);
	}
	ctx.ui.notify(result.actions.length ? `Stack actualizado:\n${result.actions.join("\n")}` : "El stack ya estaba al día: nada que mergear ni re-apuntar.", "info");
}
