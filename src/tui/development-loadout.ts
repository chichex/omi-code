// Las tools de la persona mientras el harness las restringe. Pi guarda en el transcript las que declaró en
// cada request y, al retomar, recargar o moverse por el árbol, restaura las últimas: con el harness activo,
// las restringidas. La rama registra las de la persona para devolverlas al salir, también en otra ventana.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export const LOADOUT_ENTRY = "omi-development-loadout";
const HeldSchema = Type.Object({ tools: Type.Array(Type.String()), selection: Type.String(), released: Type.Optional(Type.Literal(true)) });
/** Los flags de tools de la CLI, como los devuelve `parseArgs` de Pi. */
export interface ToolFlags { tools?: string[]; noTools?: boolean; noBuiltinTools?: boolean }

const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");
const systemMessage = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "system";
const declaresTools = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "system" && !!(entry.message.toolsAdded?.length || entry.message.toolsRemoved?.length);

export class HeldLoadout {
	/** Las de la persona, mientras el harness las retiene. */
	private tools: string[] | undefined;
	/** La rama ya registra que el harness las retiene. */
	private open = false;
	private readonly pi: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "setActiveTools">;
	private readonly selection: string;
	private readonly explicit: boolean;
	private readonly modifiers: readonly string[];
	constructor(pi: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "setActiveTools">, flags: ToolFlags) {
		this.pi = pi;
		this.selection = JSON.stringify([flags.tools ?? null, !!flags.noTools, !!flags.noBuiltinTools]);
		// Reglas de Pi: una lista explícita reemplaza al transcript al arrancar; una de +name/-name lo modifica.
		this.modifiers = flags.tools?.some(isModifier) ? flags.tools : [];
		this.explicit = !!flags.noTools || !!flags.noBuiltinTools || (flags.tools !== undefined && this.modifiers.length === 0);
	}
	/** Lee la rama después de que Pi restauró sus tools: al arrancar (`launch`) o al moverse por el árbol. */
	recall(branch: readonly SessionEntry[], launch: boolean): void {
		const at = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === LOADOUT_ENTRY);
		const entry = branch[at]; const data: unknown = entry?.type === "custom" ? entry.data : undefined;
		const saved = Value.Check(HeldSchema, data) ? data : undefined;
		// Soltadas, el próximo request declara las de la persona. Una lista explícita nueva gana, como en Pi.
		const valid = saved && !(saved.released && branch.slice(at + 1).some(declaresTools)) && !(launch && this.explicit && saved.selection !== this.selection);
		this.open = !!valid && !saved.released;
		// Sin loadout en el transcript Pi conserva las tools actuales: lo retenido sigue valiendo.
		this.tools = valid ? (launch ? this.modifiers : []).reduce(apply, saved.tools) : branch.some(systemMessage) ? undefined : this.tools;
	}
	/** Las de la persona, que el harness restringe desde ahora. */
	hold(): string[] {
		const tools = this.tools ??= this.pi.getActiveTools();
		if (!this.open) { this.pi.appendEntry(LOADOUT_ENTRY, { tools, selection: this.selection }); this.open = true; }
		return tools;
	}
	/** Devuelve las de la persona, si el harness las retenía. */
	release(): void {
		if (!this.tools) return;
		this.pi.setActiveTools(this.tools);
		if (this.open) this.pi.appendEntry(LOADOUT_ENTRY, { tools: this.tools, selection: this.selection, released: true });
		this.tools = undefined; this.open = false;
	}
}

function apply(tools: string[], modifier: string): string[] {
	const name = modifier.slice(1);
	return modifier.startsWith("+") ? (tools.includes(name) || !name ? tools : [...tools, name]) : tools.filter((tool) => tool !== name);
}
