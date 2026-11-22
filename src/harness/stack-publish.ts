// Publicar un stack: un PR draft por grupo, en orden, cada uno con todas las validaciones del PR único
// (publishDraft: aprobación, HEAD, repo, pedido, cuerpo y recuperación sin duplicar). El PR k se abre
// sobre la rama del k−1, que ya existe, y su cuerpo nombra a ese PR.
import { processRunner, type Runner } from "../core/exec.ts";
import { gitRead } from "./git.ts";
import { publishDraft, renderPullRequestBody, type Published } from "./github.ts";
import type { Workflow } from "./model.ts";

export interface StackReceipt extends Published { stack: { number: number; url: string }[] }
export async function publishStack(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<StackReceipt> {
	const publication = workflow.publication;
	if (publication.status !== "pending" || !publication.stack) throw new Error("La publicación pendiente no tiene stack de PRs");
	const stack = publication.stack;
	// Todo cuerpo se arma antes de escribir: si uno no entra en GitHub, no se abre ninguno. El número del
	// PR de abajo todavía no existe; se reserva el lugar del más largo posible.
	for (const index of stack.keys()) renderPullRequestBody(workflow, { index, ...(index ? { below: Number.MAX_SAFE_INTEGER } : {}) });
	// Cada rama contiene a la de abajo y la de arriba es el HEAD verificado: el stack es una sola historia.
	for (const [index, pull] of stack.entries()) {
		const above = stack[index + 1]?.head ?? publication.head;
		if (pull.head === above) continue;
		try { await gitRead(workflow.checkout, ["merge-base", "--is-ancestor", pull.head, above], runner, signal); }
		catch { signal?.throwIfAborted(); throw new Error(`El commit del PR ${index + 1} del stack no está debajo del PR ${index + 2}; revisá los pasos antes de publicar`); }
	}
	const opened: Published[] = [];
	for (const index of stack.keys()) opened.push(await publishDraft(workflow, runner, signal, { index, ...(index ? { below: opened[index - 1]!.number } : {}) }));
	const top = opened.at(-1)!;
	return { number: top.number, url: top.url, head: publication.head, stack: opened.map(({ number, url }) => ({ number, url })) };
}
