// Adaptador local del Editor de Pi: reglas editables sin colapsar pegados ni normalizar invisibles.
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Editor, getKeybindings, matchesKey, type Keybinding, type TUI } from "@earendil-works/pi-tui";
import { visibleText } from "../harness/foundations.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// LF separa reglas. Todo lo demás se rechaza ANTES de que Editor expanda tabs o normalice CR.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0100}-\u{E01EF}]/u;
const EDIT_KEYS: readonly Keybinding[] = [
	"tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.cursorLeft", "tui.editor.cursorRight",
	"tui.editor.cursorWordLeft", "tui.editor.cursorWordRight", "tui.editor.cursorLineStart", "tui.editor.cursorLineEnd",
	"tui.editor.pageUp", "tui.editor.pageDown", "tui.editor.deleteCharBackward", "tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward", "tui.editor.deleteWordForward", "tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd",
	"tui.editor.yank", "tui.editor.yankPop", "tui.editor.undo", "tui.editor.jumpForward", "tui.editor.jumpBackward",
];

export class FoundationsRulesEditor {
	private readonly editor: Editor;
	private prefix = "";
	private paste: string | undefined;
	private readonly problem: (message: string) => void;
	private readonly keybindings: Pick<KeybindingsManager, "matches"> | undefined;

	constructor(options: { tui: TUI; theme: () => Theme; initial: string; problem: (message: string) => void; changed: () => void; keybindings?: Pick<KeybindingsManager, "matches"> }) {
		this.problem = options.problem;
		this.keybindings = options.keybindings;
		this.editor = new Editor(options.tui, {
			borderColor: (text) => options.theme().fg(this.focused ? "borderAccent" : "borderMuted", text),
			selectList: {
				selectedPrefix: (text) => options.theme().fg("accent", text),
				selectedText: (text) => options.theme().fg("accent", text),
				description: (text) => options.theme().fg("muted", text),
				scrollInfo: (text) => options.theme().fg("dim", text),
				noMatch: (text) => options.theme().fg("warning", text),
			},
		}, { paddingX: 1 });
		this.editor.disableSubmit = true;
		this.editor.setText(options.initial);
		this.editor.onChange = options.changed;
	}

	get focused(): boolean { return this.editor.focused; }
	set focused(value: boolean) { this.editor.focused = value; }
	get text(): string { return this.editor.getExpandedText(); }
	invalidate(): void { this.editor.invalidate(); }
	render(width: number): string[] { return this.editor.render(width); }
	dispose(): void { this.prefix = ""; this.paste = undefined; this.focused = false; }

	/** Siempre interceptar antes de los atajos del panel: Ctrl+S/Esc dentro de un pegado son datos. */
	consumePaste(data: string, editable: boolean, key: (data: string) => void): boolean {
		const pending = this.prefix !== "" || this.paste !== undefined;
		// Un Esc aislado es Cancelar, no el inicio especulativo de un pegado.
		const partial = data.length > 1 && this.startSuffix(data) > 0;
		if (!pending && !data.includes(PASTE_START) && !partial) return false;
		this.receivePaste(this.prefix + data, editable, key);
		return true;
	}

	private startSuffix(text: string): number {
		for (let count = PASTE_START.length - 1; count > 0; count--) {
			if (text.endsWith(PASTE_START.slice(0, count))) return count;
		}
		return 0;
	}

	private receivePaste(data: string, editable: boolean, key: (data: string) => void): void {
		this.prefix = "";
		if (this.paste !== undefined) {
			const from = Math.max(0, this.paste.length - PASTE_END.length + 1);
			this.paste += data;
			const end = this.paste.indexOf(PASTE_END, from);
			if (end < 0) return;
			const content = this.paste.slice(0, end);
			const rest = this.paste.slice(end + PASTE_END.length);
			this.paste = undefined;
			if (editable) this.insertPaste(content);
			if (rest) {
				if (!this.consumePaste(rest, editable, key)) key(rest);
			}
			return;
		}
		const start = data.indexOf(PASTE_START);
		if (start >= 0) {
			if (start > 0) key(data.slice(0, start));
			this.paste = "";
			this.receivePaste(data.slice(start + PASTE_START.length), editable, key);
			return;
		}
		const suffix = this.startSuffix(data);
		this.prefix = suffix ? data.slice(-suffix) : "";
		const rest = suffix ? data.slice(0, -suffix) : data;
		if (rest) key(rest);
	}

	private acceptable(text: string, pasted: boolean): boolean {
		for (const [index, line] of text.split("\n").entries()) {
			const hidden = HIDDEN.exec(line)?.[0];
			if (hidden) {
				this.problem(`Línea ${this.editor.getCursor().line + index + 1}: ${pasted ? "pegado rechazado" : "entrada rechazada"}; control o invisible ${visibleText(hidden)}. El borrador anterior se conserva.`);
				return false;
			}
		}
		return true;
	}

	private insertPaste(content: string): void {
		if (!this.acceptable(content, true)) return;
		// No handlePaste(): convertiría tabs/CR y guardaría un marcador para listas largas.
		this.editor.insertTextAtCursor(content);
	}

	handleInput(data: string): void {
		if (!data) return;
		const keys = this.keybindings ?? getKeybindings();
		if (matchesKey(data, "enter") || matchesKey(data, "shift+enter") || matchesKey(data, "alt+enter") || keys.matches(data, "tui.input.newLine") || data === "\n") {
			// No submitValue(): recorta y vacía el editor, incluso con un onSubmit propio.
			this.editor.insertTextAtCursor("\n"); return;
		}
		const printable = decodeKittyPrintable(data);
		if (printable !== undefined) {
			if (this.acceptable(printable, false)) this.editor.handleInput(data);
			return;
		}
		if (EDIT_KEYS.some((action) => keys.matches(data, action)) || matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete")) {
			this.editor.handleInput(data); return;
		}
		if (!this.acceptable(data, false)) return;
		if (data.includes("\n")) this.editor.insertTextAtCursor(data);
		else this.editor.handleInput(data);
	}
}
