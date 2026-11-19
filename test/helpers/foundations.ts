// Foundations explícito para un test: una revisión aceptada en el registro local, como la deja la KB.
// Sin KB (o con la KB caída) es la que vale; sin ella, el harness no pregunta nada.
import { foundationsHash, type FoundationsBlock, type FoundationsPolicy } from "../../src/harness/foundations.ts";
import { writeTrust } from "../../src/harness/foundations-trust.ts";
import { HARNESS_KB_URL } from "../../src/tui/defaults.ts";

/** Los cuatro puntos piden el sí: el camino con preguntas, configurado a propósito. */
export const ASK_ALL: FoundationsPolicy = Object.freeze({ arranque: "ask", receta: "ask", fuera_de_catalogo: "ask", push_pr: "ask" });

export async function acceptFoundations(dir: string, politica: FoundationsPolicy, options: { kbUrl?: string; comandos?: string[]; repo?: string } = {}): Promise<FoundationsBlock> {
	const repo = options.repo ?? "test/repo";
	const block: FoundationsBlock = { version: 1, repo, comandos: [...(options.comandos ?? [])], politica: { ...politica } };
	await writeTrust(dir, {
		version: 1, kbUrl: options.kbUrl ?? HARNESS_KB_URL, product: repo.split("/")[1]!, repo, offerDeclined: false,
		accepted: { docId: "test-foundations", blockHash: foundationsHash(block), block, author: "test", date: "2026-11-19", acceptedAt: "2026-11-19T00:00:00Z" },
	});
	return block;
}
