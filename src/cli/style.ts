// Color para lo que lee un humano en la terminal. Sin TTY, con NO_COLOR o con TERM=dumb, texto plano.

import type { Io } from "./io.ts";

const ANSI = {
	bold: [1, 22],
	dim: [2, 22],
	cyan: [36, 39],
	green: [32, 39],
	yellow: [33, 39],
} as const;

export type Style = keyof typeof ANSI;
export type Paint = (style: Style, text: string) => string;

export function painter(io: Pick<Io, "env" | "interactive">): Paint {
	const enabled = io.interactive && !io.env.NO_COLOR && io.env.TERM !== "dumb";
	return (style, text) => {
		if (!enabled) return text;
		const [open, close] = ANSI[style];
		return `\x1b[${open}m${text}\x1b[${close}m`;
	};
}
