// Consentimiento para publicar: qué se sube y el cuerpo exacto del PR draft, íntegro y navegable.
// Es el mismo texto que después recibe gh: la persona aprueba lo que se publica, no un resumen.
import type { Workflow } from "../harness/model.ts";
import { COMMAND_LEGEND, type ApprovalDocument } from "./development-approval.ts";

export const PUBLICATION_TITLE = "Subir rama y abrir PR draft";
/** Lo que hace la publicación: el aviso de push_pr auto y la primera sección del diálogo de ask. */
export function publicationSummary(state: Workflow, head: string, renewing: boolean): string {
	const n = state.source.number;
	return [`${state.checkout.branch} → main`, `Commit ${head}`, `Issue #${n}`, "",
		"Hace push normal sólo de esta rama, crea o recupera su PR draft y actualiza la sección del harness en el cuerpo del issue con la evidencia. No mergea, no fuerza pushes ni ejecuta workflows.",
		`El cuerpo lleva «Closes #${n}»: crear el draft no cierra el issue; GitHub lo cierra cuando una persona mergea el PR a la rama default.`,
		...(renewing ? ["", "Había una publicación pendiente con un cuerpo anterior (por ejemplo, del formato viejo). Ese cuerpo no se publica: el recibo se renueva con el cuerpo nuevo."] : []),
	].join("\n");
}
export function publicationDocument(summary: string, body: string): ApprovalDocument {
	return { title: PUBLICATION_TITLE, sections: [
		{ id: "publication", title: "Publicación", lines: summary.split("\n").map((text) => ({ kind: "text" as const, text })) },
		{ id: "body", title: "Cuerpo del PR (Markdown exacto)", lines: [{ kind: "legend", text: COMMAND_LEGEND }, { kind: "command", text: body }] },
	] };
}
