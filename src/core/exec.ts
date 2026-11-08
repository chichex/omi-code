// Ejecuta procesos externos (git, docker, regctl). Es una frontera: los tests la reemplazan.

import { spawn } from "node:child_process";
import { childEnvironment } from "../../extensions/lib/process-environment.ts";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	cwd?: string;
	/** Se escribe por stdin: es el único canal para una credencial. */
	input?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface Runner {
	run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export const processRunner: Runner = {
	run: (command, args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				env: childEnvironment({ ...process.env, ...options.env }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			child.stdin.end(options.input);
		}),
};
