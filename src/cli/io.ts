// Frontera de E/S de la CLI: los comandos no tocan process ni la terminal directamente.

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { UsageError } from "../core/errors.ts";
import { createInterface } from "node:readline/promises";

export interface Io {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly cwd: string;
	readonly homeDir: string;
	/** Hay un humano del otro lado: se puede preguntar. */
	readonly interactive: boolean;
	out(text: string): void;
	err(text: string): void;
	readStdin(): Promise<string>;
	prompt(question: string): Promise<string>;
	promptHidden(question: string): Promise<string>;
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Lo único de readline que hace falta para preguntar. */
export interface QuestionReader {
	question(question: string): Promise<string>;
	once(event: "close", listener: () => void): unknown;
	close(): void;
}

// Ctrl+C y Ctrl+D cierran el readline. Node rechaza la pregunta; Bun la deja pendiente y el binario queda colgado.
export async function askOrCancel(reader: QuestionReader, question: string): Promise<string> {
	try {
		return await new Promise<string>((resolve, reject) => {
			const cancel = (): void => reject(new Error("entrada cancelada"));
			reader.once("close", cancel);
			reader.question(question).then(resolve, cancel);
		});
	} finally {
		reader.close();
	}
}

async function askVisible(question: string): Promise<string> {
	return askOrCancel(createInterface({ input: process.stdin, output: process.stderr }), question);
}

// Lee sin eco: el valor de un secreto o una contraseña no queda en la terminal.
async function askHidden(question: string): Promise<string> {
	process.stderr.write(question);
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	try {
		return await new Promise<string>((resolve, reject) => {
			let value = "";
			const onData = (chunk: string): void => {
				for (const char of chunk) {
					if (char === "\r" || char === "\n" || char === "\u0004") {
						stdin.off("data", onData);
						resolve(value);
						return;
					}
					if (char === "\u0003") {
						stdin.off("data", onData);
						reject(new Error("entrada cancelada"));
						return;
					}
					value = char === "\u007f" ? value.slice(0, -1) : value + char;
				}
			};
			stdin.on("data", onData);
		});
	} finally {
		stdin.setRawMode(false);
		stdin.pause();
		process.stderr.write("\n");
	}
}

export function processIo(): Io {
	const homeDir = process.env.HOME ?? homedir();
	if (!isAbsolute(homeDir)) throw new UsageError("HOME debe ser una ruta absoluta y no vacía");
	return {
		env: process.env,
		cwd: process.cwd(),
		homeDir,
		interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
		readStdin: () => readAll(process.stdin),
		prompt: askVisible,
		promptHidden: askHidden,
	};
}
