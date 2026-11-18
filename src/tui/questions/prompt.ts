// La tanda en la TUI: estado por pregunta y teclas. Toma la forma del ejemplo `questionnaire.ts` de Pi
// (pestañas, opciones y «otra»), © Mario Zechner, licencia MIT, adaptado a OMI.
// Una recomendación recibe el cursor pero nunca se elige sola; cancelar no deja respuestas parciales.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { batchProblem, type AskResult, type Question, type QuestionAnswer, type QuestionBatch } from "./batch.ts";
import { renderPrompt, type DraftView } from "./render.ts";

/** Lo que ocupan el encabezado y el pie del workspace y un mínimo del chat: la tanda usa el resto. */
const RESERVED_ROWS = 8;
const MIN_ROWS = 8;

interface Draft extends DraftView { checked: Set<number> }
export interface PromptOptions {
	batch: QuestionBatch;
	tui: TUI;
	theme: () => Theme;
	/** Filas de la terminal, para no pasarse del lugar que deja el workspace. */
	rows: () => number;
	done: (result: AskResult) => void;
}

function initialDraft(question: Question): Draft {
	const checked = new Set((question.initial?.options ?? []).map((label) => question.options.findIndex((o) => o.label === label)));
	const text = question.initial?.text ?? null;
	const answered = question.initial !== undefined && (question.multiSelect || checked.size + (text ? 1 : 0) === 1);
	const chosen = [...checked][0] ?? (text !== null ? question.options.length : undefined);
	// Una pregunta sin recomendada (un sí a algo sensible) arranca sin cursor: Enter solo no elige.
	const cursor = !question.multiSelect && chosen !== undefined ? chosen : question.multiSelect || question.recommended ? 0 : -1;
	return { cursor, checked, text, answered };
}

export class QuestionBatchPrompt implements Component, Focusable {
	private readonly options: PromptOptions;
	private readonly drafts: Draft[];
	private readonly editor: Editor;
	private tab = 0;
	private editing = false;
	private error = "";
	private closed = false;
	private detailOffset = 0;
	private detailPage = 1;
	private overflow = false;
	private hasFocus = false;
	constructor(options: PromptOptions) {
		const problem = batchProblem(options.batch);
		if (problem) throw new Error(`Preguntas inválidas: ${problem}`);
		this.options = options;
		this.drafts = options.batch.questions.map(initialDraft);
		const theme = options.theme();
		this.editor = new Editor(options.tui, { borderColor: (s) => theme.fg("borderAccent", s), selectList: { selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s), description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => theme.fg("warning", s) } }, { paddingX: 1 });
		this.editor.onSubmit = (value) => this.submitText(value);
	}
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && this.editing; }
	/** Sólo con un detalle que no entra: PgUp/PgDn lo desplazan; si no, siguen desplazando el chat. */
	get capturesViewportInput(): boolean { return this.overflow; }

	private get question(): Question | undefined { return this.options.batch.questions[this.tab]; }
	private get count(): number { return this.options.batch.questions.length; }

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) { this.finish({ status: "cancelled" }); return; }
		if (this.editing) this.editKey(data);
		else if (matchesKey(data, "escape")) { this.finish({ status: "cancelled" }); return; }
		else if (this.count > 1 && (matchesKey(data, "tab") || matchesKey(data, "right"))) this.go(this.tab + 1);
		else if (this.count > 1 && (matchesKey(data, "shift+tab") || matchesKey(data, "left"))) this.go(this.tab - 1);
		else if (matchesKey(data, "pageDown")) this.detailOffset += this.detailPage;
		else if (matchesKey(data, "pageUp")) this.detailOffset = Math.max(0, this.detailOffset - this.detailPage);
		else if (!this.question) { if (matchesKey(data, "enter")) this.submitAll(); }
		else this.questionKey(this.question, this.drafts[this.tab]!, data);
		this.options.tui.requestRender();
	}

	private questionKey(question: Question, draft: Draft, data: string): void {
		const rows = question.options.length + (question.freeText ? 1 : 0);
		const free = question.freeText ? question.options.length : -1;
		if (matchesKey(data, "up")) draft.cursor = Math.max(0, draft.cursor - 1);
		else if (matchesKey(data, "down")) draft.cursor = Math.min(rows - 1, draft.cursor + 1);
		// Sin recomendada (un sí sensible), un número sólo lleva el cursor: elegir siempre pide Enter.
		else if (/^[1-9]$/.test(data) && Number(data) <= rows) { draft.cursor = Number(data) - 1; if (question.multiSelect || question.recommended) this.pick(question, draft, draft.cursor, free); }
		else if (matchesKey(data, "space") && question.multiSelect && draft.cursor >= 0) this.pick(question, draft, draft.cursor, free);
		// Multi-selección: Espacio actúa sobre la fila (también abre el texto) y Enter confirma lo marcado, aunque sea nada.
		else if (matchesKey(data, "enter")) {
			if (question.multiSelect) { draft.answered = true; this.advance(); }
			else if (draft.cursor >= 0) this.pick(question, draft, draft.cursor, free);
		}
	}

	/** Multi-selección: marca o desmarca. Una sola: elige y avanza. La fila libre abre el texto. */
	private pick(question: Question, draft: Draft, row: number, free: number): void {
		if (row === free) { this.openEditor(draft); return; }
		if (question.multiSelect) { if (!draft.checked.delete(row)) draft.checked.add(row); return; }
		draft.checked = new Set([row]); draft.text = null; draft.answered = true;
		this.advance();
	}

	private openEditor(draft: Draft): void {
		this.editing = true; this.error = "";
		this.editor.setText(draft.text ?? ""); this.editor.focused = this.hasFocus;
	}
	private closeEditor(): void { this.editing = false; this.error = ""; this.editor.focused = false; }

	private editKey(data: string): void {
		if (matchesKey(data, "escape")) { this.closeEditor(); return; }
		const multiline = this.question?.freeText && this.question.freeText.multiline;
		// Una respuesta de una línea no admite saltos: Shift+Enter o Ctrl+J no hacen nada.
		if (!multiline && (data === "\n" || matchesKey(data, "shift+enter"))) return;
		this.editor.handleInput(data);
	}

	private submitText(value: string): void {
		const question = this.question; const draft = this.drafts[this.tab];
		if (!question?.freeText || !draft) return;
		const text = question.freeText.multiline ? value : value.replace(/\s*\n\s*/g, " ");
		if (!text) {
			draft.text = null;
			if (!question.multiSelect && draft.checked.size === 0) draft.answered = false;
			this.closeEditor(); return;
		}
		const problem = question.freeText.validate?.(text);
		if (problem) { this.error = problem; this.editor.setText(text); return; }
		draft.text = text; this.closeEditor();
		if (!question.multiSelect) { draft.checked = new Set(); draft.answered = true; this.advance(); }
	}

	private go(tab: number): void { this.tab = (tab + this.count + 1) % (this.count + 1); this.detailOffset = 0; }
	/** A la próxima sin responder; si no queda ninguna, a Enviar. Con una sola pregunta, responder envía. */
	private advance(): void {
		if (this.count === 1) { this.submitAll(); return; }
		const next = Array.from({ length: this.count - 1 }, (_, step) => (this.tab + step + 1) % this.count).find((i) => !this.drafts[i]!.answered);
		this.tab = next ?? this.count; this.detailOffset = 0;
	}
	private submitAll(): void {
		const missing = this.drafts.findIndex((draft) => !draft.answered);
		if (missing >= 0) { this.tab = missing; return; }
		this.finish({ status: "answered", answers: this.options.batch.questions.map((q, i) => this.answer(q, this.drafts[i]!)) });
	}
	private answer(question: Question, draft: Draft): QuestionAnswer {
		return { id: question.id, question: question.question, options: [...draft.checked].sort((a, b) => a - b).map((i) => question.options[i]!.label), text: draft.text };
	}
	private finish(result: AskResult): void {
		if (this.closed) return;
		this.closed = true; this.editor.focused = false;
		this.options.done(result);
	}

	render(width: number): string[] {
		const theme = this.options.theme();
		const question = this.question;
		const editing = this.editing && question?.freeText
			? { lines: this.editor.render(Math.max(4, width - 4)).map((line) => `  ${line}`), error: this.error, multiline: question.freeText.multiline } : undefined;
		const rendered = renderPrompt(theme, { title: this.options.batch.title, questions: this.options.batch.questions, drafts: this.drafts, tab: this.tab, editing, detailOffset: this.detailOffset },
			width, Math.max(MIN_ROWS, this.options.rows() - RESERVED_ROWS));
		this.detailPage = rendered.detailPage; this.detailOffset = rendered.detailOffset; this.overflow = rendered.overflow;
		return rendered.lines;
	}
	invalidate(): void { this.editor.invalidate(); }
	/** Cerrarla sin respuesta (otra UI, un abort) es cancelar. */
	dispose(): void { this.finish({ status: "cancelled" }); }
}
