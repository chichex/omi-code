// Autorizar un comando no depende de su etiqueta (setup, rojo, gate): sólo del comando exacto y del trabajo.
// La etiqueta decide qué acredita la evidencia y en qué etapa corre, no si hace falta otro sí.
import { artifactHash, type Workflow } from "./model.ts";
import { isApproved } from "./state.ts";
import type { PolicyMode } from "./foundations.ts";

export type CommandAuthorization = "catalog" | "recipe" | "grant" | "auto" | "ask";
export interface CommandPolicy { catalog: readonly string[]; outside: PolicyMode }
export const NO_CATALOG: CommandPolicy = Object.freeze({ catalog: [], outside: "ask" });

/** Un permiso vale para este trabajo y este pedido: cambiar el pedido lo invalida, aprobar la receta no. */
export const grantKey = (state: Workflow, command: string): string => artifactHash({ id: state.id, source: state.source.hash, command });

export function commandAuthorization(state: Workflow, command: string, policy: CommandPolicy = NO_CATALOG): CommandAuthorization {
	if (policy.catalog.includes(command)) return "catalog";
	// Una receta que se aprobó sola (receta: auto) no autoriza sus comandos: el modelo se aprobaría su propio shell.
	if (isApproved(state) && state.approval?.by !== "foundations" && state.recipe?.cases.some((c) => c.command === command)) return "recipe";
	const key = grantKey(state, command);
	if (state.grants?.some((g) => g.key === key)) return "grant";
	return policy.outside === "auto" ? "auto" : "ask";
}
