// Lo que GitHub deja activo fuera del código: links, imágenes, autolinks, HTML, menciones y referencias.
// Un code span es lo que va entre dos rachas de backticks del mismo largo, sin escapes adentro (CommonMark);
// un carácter escapado con \ es literal.
export function outsideCode(line: string): string {
	let rest = ""; let i = 0;
	while (i < line.length) {
		if (line[i] === "\\") { rest += "·"; i += 2; continue; }
		const run = /^`+/.exec(line.slice(i))?.[0];
		if (!run) { rest += line[i]; i++; continue; }
		const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g"); close.lastIndex = i + run.length;
		const end = close.exec(line);
		if (!end) { rest += run; i += run.length; continue; }
		rest += " "; i = end.index + run.length;
	}
	return rest;
}
export const ACTIVE = [/[[\]]/, /`/, /:\/\//, /www\./i, /@/, /#\d/, /gh-\d/i, /<(?!br>)/];
// Las líneas que GitHub lee como Markdown: sin los bloques cercados (hasta 3 espacios de indentación,
// como CommonMark). Una cerca cierra con su mismo carácter, al menos su largo y nada más en la línea.
export function outsideFences(body: string): string[] {
	const result: string[] = []; let open: { char: string; length: number } | undefined;
	for (const line of body.split("\n")) {
		if (open) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
			if (close?.startsWith(open.char) && close.length >= open.length) open = undefined;
			continue;
		}
		const marks = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marks && !(marks[1]!.startsWith("`") && marks[2]!.includes("`"))) { open = { char: marks[1]!.charAt(0), length: marks[1]!.length }; continue; }
		result.push(line);
	}
	return result;
}
