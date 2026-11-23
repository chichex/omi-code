// Consentimiento para publicar: qué se sube y el cuerpo exacto del PR draft, íntegro y navegable.
// Es el mismo texto que después recibe gh: la persona aprueba lo que se publica, no un resumen.
import type { Workflow } from "../harness/model.ts";
import { COMMAND_LEGEND, type ApprovalDocument } from "./development-approval.ts";

export const PUBLICATION_TITLE = "Subir rama y abrir PR draft";
/** Lo que hace la publicación: el aviso de push_pr auto y la primera sección del diálogo de ask. targets son
 * la rama y su commit, o cada PR del stack (publishTargets). */
export function publicationSummary(state: Workflow, targets: string, renewing: boolean): string {
	const n = state.source.number; const stack = Boolean(state.spec?.stack);
	return [targets, `Issue #${n}`, "",
		`Hace push normal sólo de ${stack ? "las ramas del stack, crea o recupera sus PR draft en orden" : "esta rama, crea o recupera su PR draft"} y actualiza la sección del harness en el cuerpo del issue con la evidencia. No mergea, no fuerza pushes ni ejecuta workflows.`,
		stack ? `Sólo el último PR del stack lleva «Closes #${n}»; los de abajo, «Refs #${n}». Crear los drafts no cierra el issue: GitHub lo cierra cuando una persona mergea el último PR a la rama default. Abajo va el cuerpo de ese PR; cada PR del stack lleva el mismo, con su «Refs» o «Closes» y su línea «Stack: PR k de n».`
			: `El cuerpo lleva «Closes #${n}»: crear el draft no cierra el issue; GitHub lo cierra cuando una persona mergea el PR a la rama default.`,
		...(renewing ? ["", "Había una publicación pendiente con un cuerpo anterior (por ejemplo, del formato viejo). Ese cuerpo no se publica: el recibo se renueva con el cuerpo nuevo."] : []),
	].join("\n");
}
/** El aviso de lo publicado. publish cierra el turno del modelo, así que el número y la URL los muestra OMI. */
export function publishedNotice(receipt: { number: number; url: string; stack?: readonly { number: number; url: string }[] }): string {
	if (!receipt.stack || receipt.stack.length < 2) return `PR draft abierto: #${receipt.number} ${receipt.url}`;
	return [`PRs draft abiertos, en orden (${receipt.stack.length}):`, ...receipt.stack.map((pull) => `#${pull.number} ${pull.url}`)].join("\n");
}
export function publicationDocument(summary: string, body: string): ApprovalDocument {
	return { title: PUBLICATION_TITLE, sections: [
		{ id: "publication", title: "Publicación", lines: summary.split("\n").map((text) => ({ kind: "text" as const, text })) },
		{ id: "body", title: "Cuerpo del PR (Markdown exacto)", lines: [{ kind: "legend", text: COMMAND_LEGEND }, { kind: "command", text: body }] },
	] };
}
