// Las tools de la persona mientras el harness las restringe. Pi guarda en el transcript las que declaró en
// cada request y, al retomar, recargar o moverse por el árbol, restaura las últimas: con el harness activo,
// las restringidas. La rama registra las de la persona para devolverlas al salir, también en otra ventana.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Args, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export const LOADOUT_ENTRY = "omi-development-loadout";
const HeldSchema = Type.Object({ tools: Type.Array(Type.String()), selection: Type.String(), released: Type.Optional(Type.Literal(true)) });
/** Los flags de la CLI que eligen las tools, como los devuelve `parseArgs` de Pi. */
type ToolSelectionArgs = Pick<Args, "tools" | "noTools" | "noBuiltinTools">;

/** De dónde vienen las tools que Pi restauró: el transcript al arrancar o al moverse por el árbol; las activas, al recargar. */
type RestoreSource = "start" | "reload" | "tree";
/** Libres, o retenidas por el harness: las de la persona y si la rama ya lo registra. */
type Held = { kind: "free" } | { kind: "held"; tools: string[]; recorded: boolean };
const FREE: Held = { kind: "free" };

const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");
const systemMessage = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "system";
const declaresTools = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "system" && !!(entry.message.toolsAdded?.length || entry.message.toolsRemoved?.length);

export class HeldLoadout {
	private state: Held = FREE;
	private readonly pi: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "setActiveTools">;
	private readonly selection: string;
	private readonly explicit: boolean;
	private readonly modifiers: readonly string[];
	constructor(pi: Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "setActiveTools">, flags: ToolSelectionArgs) {
		this.pi = pi;
		this.selection = JSON.stringify([flags.tools ?? null, !!flags.noTools, !!flags.noBuiltinTools]);
		// Reglas de Pi: una lista explícita reemplaza al transcript al arrancar; una de +name/-name lo modifica.
		this.modifiers = flags.tools?.some(isModifier) ? flags.tools : [];
		this.explicit = !!flags.noTools || !!flags.noBuiltinTools || (flags.tools !== undefined && this.modifiers.length === 0);
	}
	/** Lee la rama después de que Pi restauró sus tools. */
	recall(branch: readonly SessionEntry[], source: RestoreSource): void {
		const at = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === LOADOUT_ENTRY);
		const entry = branch[at]; const data: unknown = entry?.type === "custom" ? entry.data : undefined;
		const saved = Value.Check(HeldSchema, data) ? data : undefined;
		if (saved && this.stillApplies(saved, branch.slice(at + 1), source)) {
			this.state = { kind: "held", tools: source === "tree" ? saved.tools : this.modifiers.reduce(apply, saved.tools), recorded: !saved.released };
		} else if (branch.some(systemMessage)) this.state = FREE;
		// Sin loadout en el transcript Pi conserva las tools actuales: lo retenido sigue valiendo, sin registro en esta rama.
		else if (this.state.kind === "held") this.state = { ...this.state, recorded: false };
	}
	/** Las de la persona, que el harness restringe desde ahora. */
	hold(): string[] {
		const held = this.state.kind === "held" ? this.state : { kind: "held" as const, tools: this.pi.getActiveTools(), recorded: false };
		if (!held.recorded) this.pi.appendEntry(LOADOUT_ENTRY, { tools: held.tools, selection: this.selection });
		this.state = { ...held, recorded: true };
		return held.tools;
	}
	/** Devuelve las de la persona, si el harness las retenía. */
	release(): void {
		if (this.state.kind === "free") return;
		const { tools, recorded } = this.state;
		this.pi.setActiveTools(tools);
		if (recorded) this.pi.appendEntry(LOADOUT_ENTRY, { tools, selection: this.selection, released: true });
		this.state = FREE;
	}
	/** Si lo guardado sigue siendo de la persona frente a lo que restauró Pi. */
	private stillApplies(saved: Static<typeof HeldSchema>, after: readonly SessionEntry[], source: RestoreSource): boolean {
		// Soltadas, el próximo request vuelve a declarar las de la persona.
		const declaredSinceRelease = !!saved.released && after.some(declaresTools);
		// En /reload Pi conserva las activas, que desde que se soltaron son las de la persona.
		const keptByReload = !!saved.released && source === "reload";
		// Al arrancar, una lista explícita distinta reemplaza lo guardado, como reemplaza al transcript.
		const replacedBySelection = source !== "tree" && this.explicit && saved.selection !== this.selection;
		return !declaredSinceRelease && !keptByReload && !replacedBySelection;
	}
}

function apply(tools: string[], modifier: string): string[] {
	const name = modifier.slice(1);
	return modifier.startsWith("+") ? (tools.includes(name) || !name ? tools : [...tools, name]) : tools.filter((tool) => tool !== name);
}
