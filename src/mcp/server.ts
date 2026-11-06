// Cara MCP: JSON-RPC 2.0 delimitado por líneas sobre stdio, con el mismo catálogo que la TUI.
// stdout es del protocolo: cualquier texto para humanos va a stderr.

import { createInterface } from "node:readline";
import pkg from "../../package.json" with { type: "json" };
import { Value } from "typebox/value";
import type { Io } from "../cli/io.ts";
import { EXIT_OK, OmiError } from "../core/errors.ts";
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
}

export interface McpServer {
	handle(message: JsonRpcMessage): Promise<void>;
}

function failure(text: string): { isError: true; content: [{ type: "text"; text: string }] } {
	return { isError: true, content: [{ type: "text", text }] };
}

function describeError(error: unknown): string {
	if (error instanceof OmiError) {
		return [`${error.code}: ${error.message}`, ...(error.hint === undefined ? [] : [error.hint])].join("\n");
	}
	return error instanceof Error ? error.message : String(error);
}

export function createMcpServer(options: McpServerOptions): McpServer {
	const { tools, io, write } = options;
	const respond = (id: JsonRpcMessage["id"], result: unknown): void => write({ jsonrpc: "2.0", id: id ?? null, result });
	const fail = (id: JsonRpcMessage["id"], code: number, message: string): void =>
		write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

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
		const runtime: ToolRuntime = { io };
		try {
			const result = await tool.run(args, runtime);
			respond(message.id, { content: [{ type: "text", text: result.text }], structuredContent: result.data });
		} catch (error) {
			respond(message.id, failure(describeError(error)));
		}
	}

	return {
		async handle(message) {
			const isRequest = message.id !== undefined && message.id !== null;
			switch (message.method) {
				case "initialize": {
					const requested = String(message.params?.protocolVersion ?? "");
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

export async function serveMcp(_args: string[], io: Io): Promise<number> {
	const write = (message: JsonRpcMessage): void => void process.stdout.write(`${JSON.stringify(message)}\n`);
	const server = createMcpServer({ tools: CATALOG, io, write });
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
