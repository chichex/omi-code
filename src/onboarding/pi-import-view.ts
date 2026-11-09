// Cómo se ve la oferta de importar Pi. Qué se ofrece y qué se copia lo decide pi-import.ts.

import type { Paint } from "../cli/style.ts";

export interface OfferRow {
	/** Fila del resumen, por ejemplo «Credenciales». */
	label: string;
	/** Cómo se nombra en la pregunta y en el resultado, por ejemplo «credenciales». */
	noun: string;
	/** Qué trae, por ejemplo «auth.json» o «5 sesiones». */
	summary: string;
	warnings: string[];
	/** Qué hace Enter: sólo copia lo inofensivo. */
	defaultYes: boolean;
}

const LABEL_WIDTH = "Credenciales".length;
const GUTTER = "  ";

export function renderSummary(rows: readonly OfferRow[], target: string, paint: Paint): string {
	const warningIndent = GUTTER + " ".repeat(LABEL_WIDTH) + GUTTER;
	const lines = rows.flatMap((row) => [
		`${GUTTER}${paint("cyan", row.label.padEnd(LABEL_WIDTH))}${GUTTER}${row.summary}`,
		...row.warnings.map((warning) => `${warningIndent}${paint("yellow", `! ${warning}`)}`),
	]);
	return [
		paint("bold", "Encontré una instalación de Pi."),
		"",
		...lines,
		"",
		paint("dim", `Se copia a ${target}. Pi no se modifica.`),
		"",
	].join("\n");
}

export function renderQuestion(row: OfferRow, paint: Paint): string {
	const options = row.defaultYes ? "[S/n]" : "[s/N]";
	return `${paint("bold", `¿Copiar ${row.noun}?`)} ${paint("dim", options)} `;
}

export function renderOutcome(accepted: readonly OfferRow[], leftOut: boolean, paint: Paint): string {
	const copied = accepted.length > 0 ? [paint("green", `✓ Copiado: ${accepted.map((row) => row.noun).join(", ")}.`)] : [];
	const later = leftOut ? [paint("dim", "Si cambiás de idea: omi import pi")] : [];
	return [...copied, ...later, ""].join("\n");
}
