// Bloques de código cercados de Markdown, como los lee GitHub: los usan Foundations y la sección del issue.

export interface Fence { info: string; contentStart: number; contentEnd: number; start: number; end: number; closed: boolean }
// Cercas al estilo CommonMark, en la columna 0. Lo que está dentro de una cerca no abre otra.
export function fences(body: string): Fence[] {
	const result: Fence[] = [];
	let open: { char: string; length: number; info: string; start: number; contentStart: number } | undefined;
	let offset = 0;
	for (const raw of body.split("\n")) {
		const start = offset; offset += raw.length + 1;
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!open) {
			const match = /^(?<marks>`{3,}|~{3,})(?<info>.*)$/.exec(line);
			const marks = match?.groups?.marks; const info = match?.groups?.info ?? "";
			if (!marks || (marks.startsWith("`") && info.includes("`"))) continue;
			open = { char: marks.charAt(0), length: marks.length, info: info.trim(), start, contentStart: Math.min(offset, body.length) };
			continue;
		}
		const close = /^(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
		if (close?.startsWith(open.char) && close.length >= open.length) {
			result.push({ info: open.info, start: open.start, contentStart: open.contentStart, contentEnd: start, end: start + line.length, closed: true });
			open = undefined;
		}
	}
	if (open) result.push({ info: open.info, start: open.start, contentStart: open.contentStart, contentEnd: body.length, end: body.length, closed: false });
	return result;
}
