// Forma común de una tool de OMI. TUI, CLI y MCP son adaptadores sobre este contrato.

import type { Static, TSchema } from "typebox";
import type { Io } from "../cli/io.ts";
import type { Runner } from "../core/exec.ts";
import type { Guard } from "../guardrails/policy.ts";

export interface ToolResult {
	/** Resumen legible, lo que ve un humano o el modelo. */
	text: string;
	/** Datos estructurados para --json y structuredContent. */
	data: unknown;
	/** Terminó mal pero con datos útiles: la CLI sale con 1 y MCP marca isError. */
	failed?: boolean;
}

export interface ToolRuntime {
	readonly io: Io;
	/** URL de la API pedida con --api; gana sobre OMI_API_URL. */
	readonly apiUrl?: string;
	/** Toda mutación pasa por acá antes de llegar a omi-api. */
	readonly guard: Guard;
	readonly runner: Runner;
	/** Avance de una operación larga: pasos de un deploy, líneas de log. */
	progress?(text: string): void;
	/** Canal oculto del humano para un secreto. Sin él, sólo vale una variable local. */
	readSecret?(name: string): Promise<string>;
	/** Corte de la operación desde la superficie que la lanzó. */
	signal?: AbortSignal;
}

export interface OmiTool<P extends TSchema = TSchema> {
	name: string;
	label: string;
	description: string;
	parameters: P;
	run(params: Static<P>, runtime: ToolRuntime): Promise<ToolResult>;
}

/** Borra el tipo de parámetros para poder listar tools heterogéneas en un catálogo. */
export function defineTool<P extends TSchema>(tool: OmiTool<P>): OmiTool {
	return tool as unknown as OmiTool;
}
