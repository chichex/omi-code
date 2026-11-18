// Sección administrada del harness al final del cuerpo del issue. El pedido humano queda arriba,
// intacto byte a byte; la sección se reescribe entera y nunca se toca texto fuera de sus marcadores.
export const SECTION_START = "<!-- omi:harness:start -->";
export const SECTION_END = "<!-- omi:harness:end -->";
// Lo que OMI agrega entre el pedido y la sección; se descuenta al leer el pedido.
const SEPARATOR = "\n\n";
// Sólo cuenta un marcador solo en su línea, desde la primera columna: una mención en el pedido
// (en línea, entre backticks o indentada) es texto humano.
const MARKER_LINE = /^<!--\s*omi:harness:[^\n]*$/gm;

export interface IssueBody {
	/** El pedido: todo lo que no es la sección ni el separador que agregó OMI. */
	human: string;
	/** Texto antes del marcador de inicio (con el separador) y después del de cierre. */
	before: string; after: string;
	/** Contenido entre los marcadores, o null si el cuerpo todavía no tiene sección. */
	section: string | null;
}
export class IssueSectionError extends Error {
	constructor() { super("Los marcadores de la sección del harness en el issue están repetidos o rotos. No se adivina cuál es el pedido: dejá un solo par <!-- omi:harness:start --> / <!-- omi:harness:end --> (o borrá la sección entera) y reintentá."); this.name = "IssueSectionError"; }
}
export function parseIssueBody(body: string): IssueBody {
	const markers = [...body.matchAll(MARKER_LINE)];
	if (!markers.length) return { human: body, before: body, after: "", section: null };
	const line = (match: RegExpMatchArray) => match[0].replace(/\r$/, "");
	const [start, end] = markers;
	if (markers.length !== 2 || !start || !end || line(start) !== SECTION_START || line(end) !== SECTION_END) throw new IssueSectionError();
	const before = body.slice(0, start.index); const after = body.slice(end.index! + end[0].length);
	return { human: (before.endsWith(SEPARATOR) ? before.slice(0, -SEPARATOR.length) : before) + after, before, after, section: body.slice(start.index! + start[0].length, end.index) };
}
// Sin sección, se agrega al final; con sección, se reemplaza sólo lo que está entre los marcadores.
export function withIssueSection(body: string, parts: IssueBody, content: string): string {
	const block = `${SECTION_START}\n${content}\n${SECTION_END}`;
	return parts.section === null ? `${body}${SEPARATOR}${block}` : `${parts.before}${block}${parts.after}`;
}
