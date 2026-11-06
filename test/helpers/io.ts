// Io de test: captura salida y responde prompts desde una cola.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Io } from "../../src/cli/io.ts";

export interface TestIo extends Io {
	readonly stdout: string[];
	readonly stderr: string[];
	readonly prompts: string[];
	output(): string;
	errors(): string;
}

export interface TestIoOptions {
	homeDir: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	interactive?: boolean;
	stdin?: string;
	answers?: string[];
}

export function testIo(options: TestIoOptions): TestIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const prompts: string[] = [];
	const answers = [...(options.answers ?? [])];
	const next = async (question: string): Promise<string> => {
		prompts.push(question);
		const answer = answers.shift();
		if (answer === undefined) throw new Error(`prompt sin respuesta preparada: ${question}`);
		return answer;
	};
	return {
		env: options.env ?? {},
		cwd: options.cwd ?? options.homeDir,
		homeDir: options.homeDir,
		interactive: options.interactive ?? false,
		out: (text) => stdout.push(text),
		err: (text) => stderr.push(text),
		readStdin: async () => options.stdin ?? "",
		prompt: next,
		promptHidden: next,
		stdout,
		stderr,
		prompts,
		output: () => stdout.join("\n"),
		errors: () => stderr.join("\n"),
	};
}

export async function tempDir(t: TestContext, prefix = "omi-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
