// Cómo se ve una tanda: pestañas, pregunta, opciones numeradas y ayuda, dentro de un alto fijo.
// Si no entra, primero se esconden las descripciones de las otras opciones y después se desplaza.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { surface, text } from "../workspace/presentation.ts";
import { describeAnswer, FREE_TEXT_LABEL, RECOMMENDED_TAG, type Question } from "./batch.ts";

export interface DraftView { cursor: number; checked: ReadonlySet<number>; text: string | null; answered: boolean }
export interface PromptView {
	title: string;
	questions: readonly Question[];
	drafts: readonly DraftView[];
	/** La pregunta visible; `questions.length` es el paso Enviar. */
	tab: number;
	/** El texto libre abierto: sus líneas ya dibujadas y el motivo si no valió. */
	editing: { lines: string[]; error: string; multiline: boolean } | undefined;
	detailOffset: number;
}
/** `detailOffset` vuelve acotado al detalle: PgDn de más no se acumula. */
export interface RenderedPrompt { lines: string[]; detailPage: number; detailOffset: number; overflow: boolean }

/** Sin controles, secuencias de terminal ni formato invisible (bidi, ancho cero): se ve lo que es. */
export const clean = (value: string): string => text(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "");
const paragraphs = (value: string, width: number): string[] => value.split("\n").flatMap((line) => wrapTextWithAnsi(clean(line), width));

function titleRule(theme: Theme, title: string, width: number): string {
	const label = ` ${clean(title)} `;
	return theme.fg("borderAccent", "──") + theme.style(label, { fg: "accent", bold: true }) + theme.fg("borderAccent", "─".repeat(Math.max(0, width - 2 - visibleWidth(label))));
}

function chipsLine(theme: Theme, view: PromptView, width: number): string {
	const count = view.questions.length; const allAnswered = view.drafts.every((d) => d.answered);
	const paint = (label: string, active: boolean, done: boolean) => active ? theme.bg("selectedBg", theme.style(` ${label} `, { fg: "text", bold: true })) : theme.fg(done ? "success" : "muted", ` ${label} `);
	const build = (short: boolean, arrows: boolean) => {
		const chips = view.questions.map((q, i) => paint(`${view.drafts[i]!.answered ? "■" : "□"} ${short && i !== view.tab ? i + 1 : clean(q.header)}`, i === view.tab, view.drafts[i]!.answered));
		const submit = paint("✓ Enviar", view.tab === count, allAnswered);
		return (arrows ? theme.fg("dim", "← ") : "") + [...chips, submit].join(" ") + (arrows ? theme.fg("dim", " →") : "");
	};
	return [build(false, true), build(false, false), build(true, false)].find((line) => visibleWidth(line) <= width) ?? build(true, false);
}

function helpLine(theme: Theme, view: PromptView, width: number): string[] {
	const many = view.questions.length > 1; const question = view.questions[view.tab];
	let variants: string[];
	if (view.editing) variants = [`Enter listo${view.editing.multiline ? " · Ctrl+J otra línea" : ""} · Esc volver`];
	else if (!question) variants = ["Enter enviar · Tab/←→ preguntas · Esc cancelar", "Enter · Tab · Esc cancelar"];
	else {
		const keys = `1–${Math.min(9, question.options.length + (question.freeText ? 1 : 0))}`; const tabs = many ? " · Tab/←→ preguntas" : "";
		const short = `Enter${many ? " · Tab" : ""} · Esc cancelar`;
		variants = question.multiSelect
			? [`↑↓ moverse · Espacio/${keys} marcar · Enter confirmar${tabs} · Esc cancelar`, `Espacio/${keys} marcar · Enter confirmar${tabs} · Esc cancelar`, `Espacio · ${short}`, short]
			: question.recommended
				? [`↑↓ moverse · ${keys} eligen y siguen · Enter confirmar${tabs} · Esc cancelar`, `${keys} eligen y siguen · Enter confirmar${tabs} · Esc cancelar`, `${keys} eligen · ${short}`, short]
				: [`↑↓ o ${keys} moverse · Enter confirmar${tabs} · Esc cancelar`, `${keys} moverse · Enter confirmar${tabs} · Esc cancelar`, `↑↓ ${keys} · ${short}`, short];
	}
	const fitting = variants.find((line) => visibleWidth(line) <= width) ?? variants.at(-1)!;
	return wrapTextWithAnsi(theme.fg("dim", fitting), width);
}

type OptionMode = "full" | "compact" | "bare";
/** Una opción por bloque: su fila y, según el modo, su descripción. */
function optionBlocks(theme: Theme, question: Question, draft: DraftView, width: number, mode: OptionMode): string[][] {
	const rows = [...question.options.map((o) => ({ label: clean(o.label), description: clean(o.description) })), ...(question.freeText ? [{ label: FREE_TEXT_LABEL, description: "" }] : [])];
	const free = question.freeText ? question.options.length : -1;
	return rows.map((row, i) => {
		const cursor = i === draft.cursor; const isFree = i === free;
		const checked = isFree ? draft.text !== null : draft.checked.has(i);
		const lead = `${cursor ? "› " : "  "}${i + 1}. ${question.multiSelect ? (checked ? "[x] " : "[ ] ") : ""}`;
		const tag = i === 0 && question.recommended ? ` ${theme.fg("success", RECOMMENDED_TAG)}` : "";
		const chosen = !question.multiSelect && checked && draft.answered ? theme.fg("success", " ✓") : "";
		const label = cursor ? theme.style(row.label, { fg: "accent", bold: true }) : theme.fg("text", row.label);
		const first = truncateToWidth((cursor ? theme.fg("accent", lead) : lead) + label + tag + chosen, width, "…");
		const indent = " ".repeat(visibleWidth(lead));
		const note = isFree && draft.text !== null ? `✎ ${draft.text.split("\n").map(clean).join(" ⏎ ")}` : row.description;
		const describe = note && (mode === "full" || (mode === "compact" && (cursor || isFree)));
		return [first, ...(describe ? wrapTextWithAnsi(note, Math.max(1, width - indent.length)).map((line) => indent + theme.fg(isFree ? "text" : "muted", line)) : [])];
	});
}

/** Los bloques que entran en `height`, siempre con el del cursor, y cuántos quedan arriba y abajo. */
function windowBlocks(theme: Theme, blocks: string[][], focus: number, height: number): string[] {
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	if (total <= height) return blocks.flat();
	const size = (start: number, end: number) => blocks.slice(start, end).reduce((sum, block) => sum + block.length, 0) + (start > 0 ? 1 : 0) + (end < blocks.length ? 1 : 0);
	let start = Math.max(0, focus); let end = start + 1;
	for (let grew = true; grew;) {
		grew = false;
		if (end < blocks.length && size(start, end + 1) <= height) { end++; grew = true; }
		if (start > 0 && size(start - 1, end) <= height) { start--; grew = true; }
	}
	return [...(start > 0 ? [theme.fg("dim", `↑ ${start} más`)] : []), ...blocks.slice(start, end).flat(), ...(end < blocks.length ? [theme.fg("dim", `↓ ${blocks.length - end} más`)] : [])].slice(0, Math.max(1, height));
}

function questionBody(theme: Theme, view: PromptView, question: Question, draft: DraftView, width: number, available: number): Omit<RenderedPrompt, "lines"> & { body: string[] } {
	const asked = paragraphs(question.question, width).map((line) => theme.style(line, { fg: "text", bold: true }));
	const detail = question.detail ? paragraphs(question.detail, width).map((line) => theme.fg("text", line)) : [];
	const editor = view.editing ? [...view.editing.lines, ...(view.editing.error ? wrapTextWithAnsi(theme.fg("warning", `⚠ ${clean(view.editing.error)}`), width) : [])] : [];
	const detailMin = Math.min(detail.length, 3);
	const modes: OptionMode[] = view.editing ? ["bare"] : ["full", "compact", "bare"];
	const fits = (mode: OptionMode) => asked.length + (detail.length ? detailMin + 1 : 0) + 1 + optionBlocks(theme, question, draft, width, mode).flat().length + editor.length <= available;
	const blocks = optionBlocks(theme, question, draft, width, modes.find(fits) ?? (view.editing ? "bare" : "compact"));
	const optionLines = blocks.flat().length; const optionMin = Math.min(optionLines, 3);
	let room = available - editor.length;
	const questionRows = Math.max(1, Math.min(asked.length, room - optionMin - detailMin));
	room -= questionRows;
	const gapOptions = room - optionMin - detailMin >= (detail.length ? 2 : 1) ? 1 : 0;
	const gapDetail = detail.length && room - optionMin - detailMin - gapOptions >= 1 ? 1 : 0;
	room -= gapOptions + gapDetail;
	const optionRows = room - optionLines >= detailMin ? optionLines : Math.max(optionMin, room - detailMin);
	const detailRows = detail.length ? Math.min(detail.length, Math.max(0, room - optionRows)) : 0;
	const shownQuestion = asked.slice(0, questionRows);
	if (questionRows < asked.length) shownQuestion[questionRows - 1] = truncateToWidth(`${shownQuestion[questionRows - 1]!}…`, width, "…");
	const overflow = detail.length > detailRows && detailRows >= 2; const detailPage = Math.max(1, detailRows - 1);
	const offset = overflow ? Math.max(0, Math.min(view.detailOffset, detail.length - detailPage)) : 0;
	let shownDetail = detail.slice(0, detailRows);
	if (overflow) {
		shownDetail = [...detail.slice(offset, offset + detailPage), theme.fg("dim", `↕ líneas ${offset + 1}–${offset + detailPage} de ${detail.length} · PgUp/PgDn`)];
	}
	const body = [...shownQuestion, ...(gapDetail ? [""] : []), ...shownDetail, ...(gapOptions ? [""] : []), ...windowBlocks(theme, blocks, draft.cursor, optionRows), ...editor];
	return { body, detailPage, detailOffset: offset, overflow };
}

function reviewBody(theme: Theme, view: PromptView, width: number): string[] {
	const pad = Math.max(...view.questions.map((q) => visibleWidth(clean(q.header))));
	const missing = view.questions.filter((_, i) => !view.drafts[i]!.answered).map((q) => clean(q.header));
	const rows = view.questions.flatMap((q, i) => {
		const draft = view.drafts[i]!;
		const answer = draft.answered ? theme.fg("text", clean(describeAnswer({ options: [...draft.checked].sort((a, b) => a - b).map((n) => q.options[n]!.label), text: draft.text }))) : theme.fg("warning", "sin responder");
		const header = clean(q.header); const lines = wrapTextWithAnsi(answer, Math.max(1, width - pad - 2));
		return lines.map((line, n) => `${n ? " ".repeat(pad) : theme.fg("muted", header + " ".repeat(pad - visibleWidth(header)))}  ${line}`);
	});
	const status = missing.length ? theme.fg("warning", `Falta responder: ${missing.join(", ")} · Enter va a la primera`) : theme.fg("success", "Enter envía las respuestas");
	return [theme.style("Revisá las respuestas antes de enviar", { fg: "text", bold: true }), "", ...rows, "", ...wrapTextWithAnsi(status, width)];
}

/** La tanda dentro de `budget` filas y exactamente `width` columnas, pintada como el resto del workspace. */
export function renderPrompt(theme: Theme, view: PromptView, width: number, budget: number): RenderedPrompt {
	const inner = Math.max(1, width - 2);
	const many = view.questions.length > 1;
	const top = [titleRule(theme, view.title, width), ...(many ? [chipsLine(theme, view, inner), ...(budget >= 12 ? [""] : [])] : [])];
	const help = helpLine(theme, view, inner);
	const available = Math.max(1, budget - top.length - help.length);
	const question = view.questions[view.tab]; const draft = view.drafts[view.tab];
	let body: string[]; let detailPage = 1; let detailOffset = 0; let overflow = false;
	if (question && draft) ({ body, detailPage, detailOffset, overflow } = questionBody(theme, view, question, draft, inner, available));
	else body = reviewBody(theme, view, inner).slice(0, available);
	const spacer = top.length + body.length + help.length < budget ? [""] : [];
	const lines = [top[0]!, ...[...top.slice(1), ...body, ...spacer, ...help].map((line) => ` ${line}`)];
	return { lines: lines.map((line) => surface(theme, line, width)), detailPage, detailOffset, overflow };
}
