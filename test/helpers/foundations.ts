// Foundations v2 explícito para un test: una revisión aceptada en el registro local, como la deja la KB.
// Sin KB (o con la KB caída) es la que vale; sin ella, el harness no pregunta nada.
import { foundationsHash, type FoundationsBlock, type FoundationsPolicy } from "../../src/harness/foundations.ts";
import { writeTrust } from "../../src/harness/foundations-trust.ts";
import { HARNESS_KB_URL } from "../../src/tui/defaults.ts";

/** Los tres puntos piden el sí: el camino con preguntas, configurado a propósito. */
export const ASK_ALL: FoundationsPolicy = Object.freeze({ arranque: "ask", receta: "ask", push_pr: "ask" });
/** Con `*` todo comando requiere confirmación: la v2 más estricta. */
export const CONFIRM_ALL: readonly string[] = Object.freeze(["*"]);

export async function acceptFoundations(dir: string, politica: FoundationsPolicy, options: { kbUrl?: string; confirmar?: readonly string[]; repo?: string } = {}): Promise<FoundationsBlock> {
	const repo = options.repo ?? "test/repo";
	const block: FoundationsBlock = { version: 2, repo, confirmar: [...(options.confirmar ?? CONFIRM_ALL)], politica: { ...politica } };
	await writeTrust(dir, {
		version: 2, kbUrl: options.kbUrl ?? HARNESS_KB_URL, product: repo.split("/")[1]!, repo, deferred: null,
		accepted: { docId: "test-foundations", blockHash: foundationsHash(block), block, author: "test", date: "2026-11-19", acceptedAt: "2026-11-19T00:00:00Z" },
	});
	return block;
}
