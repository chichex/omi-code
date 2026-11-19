// Stack de PRs: la spec agrupa sus pasos C y cada grupo se publica como un PR draft encadenado sobre
// el de abajo. Lógica pura, sin Git ni GitHub: publicar vive en stack-publish y actualizar en stack-sync.
import type { Spec, StackPull, Workflow } from "./model.ts";

/** Rama default: base del PR 1 y destino de los que quedan sobre un PR ya mergeado. */
export const DEFAULT_BASE = "main";
export interface StackGroup { title: string; steps: string[] }
export interface StackRow extends Omit<StackPull, "head"> { index: number; total: number }
const fail = (message: string): never => { throw new Error(`Harness: ${message}`); };

/** Por qué la agrupación de la spec no sirve, o "" si sirve o no hay stack. */
export function stackProblem(spec: Spec): string {
	const stack = spec.stack; if (!stack) return "";
	if (stack.length < 2) return "un stack necesita al menos dos PRs; sin stack, el trabajo va en un solo PR";
	const ids = spec.steps.map((s) => s.id); const grouped = stack.flatMap((g) => g.steps);
	const unknown = grouped.find((id) => !ids.includes(id)); if (unknown) return `el stack nombra un paso inexistente: ${unknown}`;
	const missing = ids.find((id) => !grouped.includes(id)); if (missing) return `el stack no incluye el paso ${missing}`;
	// Cada rama apunta al commit del último paso de su grupo: los grupos sólo pueden cortar la secuencia de pasos.
	if (grouped.length !== ids.length || grouped.some((id, i) => id !== ids[i])) return "el stack agrupa los pasos C contiguos y en orden, cada uno una vez";
	return "";
}
/** Grupos del trabajo, o null si va en un solo PR. Un paso que no está en la spec (la corrección de una vuelta) va en el último. */
export function stackGroups(w: Pick<Workflow, "spec" | "steps">): StackGroup[] | null {
	const stack = w.spec?.stack; if (!stack) return null;
	const grouped = new Set(stack.flatMap((g) => g.steps));
	const extra = w.steps.map((s) => s.id).filter((id) => !grouped.has(id));
	return stack.map((g, i) => ({ title: g.title, steps: i === stack.length - 1 ? [...g.steps, ...extra] : [...g.steps] }));
}
export const stackBranch = (branch: string, index: number): string => `${branch}-${index + 1}`;
const baseOf = (branch: string, index: number): string => index ? stackBranch(branch, index - 1) : DEFAULT_BASE;
/** Una rama por grupo, el PR 1 sobre main y cada uno sobre el de abajo. El de arriba publica el HEAD verificado. */
export function planStack(w: Workflow, head: string): StackPull[] {
	const groups = stackGroups(w) ?? fail("el trabajo no tiene stack");
	const pulls = groups.map((g, i): StackPull => {
		const last = w.steps.find((s) => s.id === g.steps.at(-1));
		const commit = i === groups.length - 1 ? head : last?.status === "done" ? last.commit : null;
		if (!commit) return fail(`falta el commit del paso ${g.steps.at(-1) ?? "?"} para el PR ${i + 1} del stack`);
		return { title: g.title, steps: g.steps, branch: stackBranch(w.checkout.branch, i), base: baseOf(w.checkout.branch, i), head: commit, number: null, url: null, status: "planned" };
	});
	if (new Set(pulls.map((p) => p.head)).size !== pulls.length) fail("dos PRs del stack apuntan al mismo commit");
	return pulls;
}
/** Al abrirse todos: cada PR con su número; el de arriba es la publicación del trabajo. */
export function openedStack(planned: StackPull[] | undefined, event: { number: number; url: string; stack?: { number: number; url: string }[] }): StackPull[] | undefined {
	const receipts = event.stack;
	if (!planned && !receipts) return undefined;
	if (!planned || !receipts || receipts.length !== planned.length) return fail("los PRs publicados no coinciden con el stack planeado");
	if (receipts.at(-1)?.number !== event.number || receipts.at(-1)?.url !== event.url) fail("la publicación tiene que ser el PR de arriba del stack");
	if (new Set(receipts.map((r) => r.number)).size !== receipts.length) fail("un PR aparece dos veces en el stack");
	return planned.map((p, i) => ({ ...p, number: receipts[i]!.number, url: receipts[i]!.url, status: "draft" }));
}
/** Actualizar cambia base, head y estado; nunca qué PR es, su rama ni sus pasos. Un mergeado no vuelve atrás. */
export function syncedStack(previous: StackPull[] | undefined, next: StackPull[]): StackPull[] {
	if (!previous) return fail("este trabajo no publicó un stack de PRs");
	if (next.length !== previous.length) fail("el stack actualizado no tiene los mismos PRs");
	for (const [i, p] of next.entries()) {
		const before = previous[i]!;
		if (p.number !== before.number || p.url !== before.url || p.branch !== before.branch || p.title !== before.title || p.steps.join() !== before.steps.join() || p.status === "planned") fail(`el stack actualizado cambió la identidad del PR ${i + 1}`);
		if (before.status === "merged" && p.status !== "merged") fail(`el PR ${i + 1} del stack ya estaba mergeado`);
	}
	return next.map((p) => ({ ...p, steps: [...p.steps] }));
}
/** Sólo el último PR del stack cierra el issue al mergearse; los de abajo lo referencian. */
export function stackIssueLine(issue: number, index: number, total: number): string {
	return `${index === total - 1 ? "Closes" : "Refs"} #${issue}`;
}
/** Línea propia del stack en el cuerpo del PR, fuera del artefacto: el artefacto es el mismo en todos. */
export function stackBodyLine(pulls: StackPull[], index: number, below?: number): string {
	const pull = pulls[index] ?? fail("PR inexistente en el stack");
	const where = index ? `sobre #${below ?? fail("falta el número del PR de abajo")} (rama \`${pull.base}\`)` : `base \`${pull.base}\``;
	return `Stack: PR ${index + 1} de ${pulls.length} · pasos ${pull.steps.join(", ")} · ${where}`;
}
export const stackTitle = (title: string, pulls: StackPull[], index: number): string => `${title} · PR ${index + 1}/${pulls.length}: ${pulls[index]?.title ?? ""}`;
/** PRs del stack para mostrar: los publicados, o los planeados desde la spec mientras no se publica. */
export function stackRows(w: Workflow): StackRow[] {
	const published = w.publication.status === "none" ? undefined : w.publication.stack;
	const pulls = published ?? stackGroups(w)?.map((g, i) => ({ title: g.title, steps: g.steps, branch: stackBranch(w.checkout.branch, i), base: baseOf(w.checkout.branch, i), number: null, url: null, status: "planned" as const }));
	return (pulls ?? []).map(({ title, steps, branch, base, number, url, status }, index, all) => ({ title, steps, branch, base, number, url, status, index, total: all.length }));
}
export const STACK_STATUS: Record<StackPull["status"], string> = { planned: "sin abrir", draft: "draft", open: "abierto", merged: "mergeado" };
/** La base como se lee: main, el PR de abajo (#N o «PR k» si no se abrió) o la rama. */
export function stackBaseLabel(rows: StackRow[], row: StackRow): string {
	const below = rows.find((r) => r.branch === row.base);
	return !below ? row.base : below.number === null ? `PR ${below.index + 1}` : `#${below.number}`;
}
/** Texto plano para el progreso y la revisión de la receta. */
export function stackLines(w: Workflow): string[] {
	const rows = stackRows(w);
	return rows.map((r) => [`PR ${r.index + 1} de ${r.total}`, r.number === null ? STACK_STATUS.planned : `#${r.number}`, `base ${stackBaseLabel(rows, r)}`, r.steps.join(", "), ...(r.number === null ? [] : [STACK_STATUS[r.status]]), r.title].join(" · "));
}
