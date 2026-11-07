// Cara MCP: JSON-RPC 2.0 delimitado por líneas sobre stdio, con el mismo catálogo que la TUI.
// stdout es del protocolo: cualquier texto para humanos va a stderr.

import { createInterface } from "node:readline";
import pkg from "../../package.json" with { type: "json" };
import { Value } from "typebox/value";
import type { Io } from "../cli/io.ts";
import { parseFlags } from "../cli/flags.ts";
import { EXIT_OK, OmiError, describeError } from "../core/errors.ts";
import { processRunner, type Runner } from "../core/exec.ts";
import { mcpGuard } from "../guardrails/surfaces.ts";
import { CATALOG } from "../tools/catalog.ts";
import type { OmiTool, ToolRuntime } from "../tools/types.ts";

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", LATEST_PROTOCOL_VERSION];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface McpServerOptions {
	tools: readonly OmiTool[];
	io: Io;
	write(message: JsonRpcMessage): void;
	/** Autoriza operar stage: lo decide quien configura el servidor, no el modelo. */
	stageAuthorized?: boolean;
	runner?: Runner;
}

export interface McpServer {
	handle(message: JsonRpcMessage): Promise<void>;
}

function failure(text: string): { isError: true; content: [{ type: "text"; text: string }] } {
	return { isError: true, content: [{ type: "text", text }] };
}

function readAcceptance(result: unknown): boolean {
	const answer = result as { action?: unknown; content?: { confirmar?: unknown } } | undefined;
	return answer?.action === "accept" && answer.content?.confirmar === true;
}

export function createMcpServer(options: McpServerOptions): McpServer {
	const { tools, write } = options;
	const io: Io = {
		...options.io,
		out: (text) => options.io.err(text),
		interactive: false,
		prompt: async () => { throw new OmiError("mcp_terminal_unavailable", "MCP no lee prompts de terminal"); },
		promptHidden: async () => { throw new OmiError("mcp_terminal_unavailable", "MCP no lee secretos de terminal"); },
		readStdin: async () => { throw new OmiError("mcp_terminal_unavailable", "stdin pertenece al protocolo MCP"); },
	};
	const respond = (id: JsonRpcMessage["id"], result: unknown): void => write({ jsonrpc: "2.0", id: id ?? null, result });
	const fail = (id: JsonRpcMessage["id"], code: number, message: string): void =>
		write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

	let canElicit = false;
	let nextElicitation = 0;
	const pending = new Map<string, (accepted: boolean) => void>();
	const elicit = (message: string): Promise<boolean> =>
		new Promise((resolve) => {
			nextElicitation += 1;
			const id = `omi-elicit-${nextElicitation}`;
			pending.set(id, resolve);
			write({
				jsonrpc: "2.0",
				id,
				method: "elicitation/create",
				params: {
					message,
					requestedSchema: { type: "object", properties: { confirmar: { type: "boolean", title: "Confirmar" } }, required: ["confirmar"] },
				},
			});
		});
	const guard = mcpGuard({ stageAuthorized: options.stageAuthorized ?? false, canElicit: () => canElicit, elicit });
	const runner = options.runner ?? processRunner;

	async function callTool(message: JsonRpcMessage): Promise<void> {
		const name = message.params?.name;
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) {
			fail(message.id, INVALID_PARAMS, `tool desconocida: ${String(name)}`);
			return;
		}
		const args = message.params?.arguments ?? {};
		if (!Value.Check(tool.parameters, args)) {
			const detail = [...Value.Errors(tool.parameters, args)].map((issue) => issue.message).join("; ");
			respond(message.id, failure(`invalid_arguments: ${detail}`));
			return;
		}
		const runtime: ToolRuntime = { io, guard, runner };
		try {
			const result = await tool.run(args, runtime);
			respond(message.id, {
				content: [{ type: "text", text: result.text }],
				structuredContent: result.data,
				...(result.failed === true ? { isError: true } : {}),
			});
		} catch (error) {
			respond(message.id, failure(describeError(error)));
		}
	}

	return {
		async handle(message) {
			const isRequest = message.id !== undefined && message.id !== null;
			if (message.method === undefined) {
				// Respuesta del cliente a una elicitación: el error también cuenta como un no.
				const resolve = pending.get(String(message.id));
				pending.delete(String(message.id));
				resolve?.(readAcceptance(message.result));
				return;
			}
			switch (message.method) {
				case "initialize": {
					const requested = String(message.params?.protocolVersion ?? "");
					const capabilities = message.params?.capabilities as { elicitation?: unknown } | undefined;
					canElicit = capabilities?.elicitation !== undefined;
					respond(message.id, {
						protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "omi", version: pkg.version },
					});
					return;
				}
				case "ping":
					respond(message.id, {});
					return;
				case "tools/list":
					respond(message.id, {
						tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
					});
					return;
				case "tools/call":
					await callTool(message);
					return;
				default:
					if (isRequest) fail(message.id, METHOD_NOT_FOUND, `método desconocido: ${String(message.method)}`);
			}
		},
	};
}

export async function serveMcp(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { "authorize-stage": { type: "boolean" } });
	const write = (message: JsonRpcMessage): void => void process.stdout.write(`${JSON.stringify(message)}\n`);
	const server = createMcpServer({ tools: CATALOG, io, write, stageAuthorized: values["authorize-stage"] === true });
	const pending = new Set<Promise<void>>();
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.trim() === "") continue;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "JSON inválido" } });
			continue;
		}
		const task = server.handle(message).catch((error: unknown) => io.err(`omi mcp: ${String(error)}`));
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
	await Promise.all(pending);
	return EXIT_OK;
}
