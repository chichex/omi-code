// Doble del ejecutor de comandos: registra qué se corrió sin correr docker ni regctl.

import type { CommandResult, Runner } from "../../src/core/exec.ts";

export interface RecordedCommand {
	command: string;
	args: string[];
	input: string | undefined;
	env: Record<string, string> | undefined;
}

export interface FakeRunner extends Runner {
	commands: RecordedCommand[];
}

export function fakeRunner(reply: (command: string, args: string[]) => Partial<CommandResult> = () => ({})): FakeRunner {
	const commands: RecordedCommand[] = [];
	return {
		commands,
		run: async (command, args, options = {}) => {
			commands.push({ command, args, input: options.input, env: options.env });
			return { code: 0, stdout: "", stderr: "", ...reply(command, args) };
		},
	};
}
