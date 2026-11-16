import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { fit, sidebarSection, text } from "./presentation.ts";

export interface SubagentTask {
	id: string;
	agent: string;
	title: string;
	status: "pending" | "running" | "done" | "error" | "skipped";
	turns: number;
	activity: string;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
}

const ROLES = new Set(["scout", "planner", "reviewer", "worker"]);
const MAX_TASKS = 8;
const HISTORY_BATCHES = 8;
interface Batch { tasks: SubagentTask[]; closed: boolean }
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function label(value: unknown, width: number): string {
	// Bound work as well as storage. Strip escape sequences before removing control bytes.
	return typeof value === "string" ? fit(text(stripTerminalSequences(value.slice(0, 2048))).replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim(), width).trimEnd() : "";
}
function active(task: SubagentTask): boolean { return task.status === "running" || task.status === "pending"; }

/** Keeps only sidebar metadata, never tool payloads, outputs, usage or private history. */
export class SubagentMonitor {
	private batches = new Map<string, Batch>();

	get tasks(): SubagentTask[] {
		// Copies prevent callers from mutating the monitor or retaining its internal records.
		return [...this.batches.values()].flatMap((batch) => batch.tasks.map((task) => ({ ...task })))
			.sort((a, b) => (a.status === "running" ? 0 : a.status === "pending" ? 1 : 2) - (b.status === "running" ? 0 : b.status === "pending" ? 1 : 2));
	}

	start(callId: string, args: unknown): void {
		if (this.batches.has(callId)) return;
		const params = record(args);
		if (!params) return;
		const single = params.agent !== undefined || params.task !== undefined;
		if (Number(single) + Number(params.tasks !== undefined) + Number(params.chain !== undefined) !== 1) return;
		const input = single ? [params] : params.tasks ?? params.chain;
		if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TASKS) return;
		const tasks: SubagentTask[] = [];
		for (const [index, value] of input.entries()) {
			const item = record(value);
			if (!item || typeof item.agent !== "string" || !ROLES.has(item.agent) || typeof item.task !== "string" || !item.task.trim()) return;
			tasks.push({ id: `${callId}/${index}`, agent: item.agent, title: label(item.task, 96), status: "pending", turns: 0, activity: "", queuedAt: Date.now() });
		}
		this.batches.set(callId, { tasks, closed: false });
		this.prune();
	}

	update(callId: string, details: unknown): void {
		const batch = this.batches.get(callId);
		const results = record(details)?.results;
		if (!batch || batch.closed || !Array.isArray(results)) return;
		for (const [index, task] of batch.tasks.entries()) {
			const result = record(results[index]);
			if (!result || !active(task)) continue;
			if (typeof result.agent === "string" && ROLES.has(result.agent)) task.agent = result.agent;
			if (typeof result.turns === "number" && Number.isFinite(result.turns)) task.turns = Math.max(task.turns, Math.min(1_000_000, Math.max(0, Math.floor(result.turns))));
			if (typeof result.activity === "string") task.activity = label(result.activity, 48);
			const status = result.status;
			if (status === "running" || status === "done" || status === "error" || status === "skipped" || (status === "pending" && task.status === "pending")) {
				task.status = status;
				if (status === "running") task.startedAt ??= Date.now();
				if (!active(task)) { task.endedAt = Date.now(); task.activity = ""; }
			}
		}
	}

	end(callId: string, details: unknown, _isError: boolean): void {
		this.update(callId, details);
		const batch = this.batches.get(callId);
		if (!batch || batch.closed) return;
		// A successful envelope is not evidence that a queued task actually ran.
		this.close(batch);
		this.prune();
	}

	settle(): void {
		for (const batch of this.batches.values()) if (!batch.closed) this.close(batch);
		this.prune();
	}

	clear(): void { this.batches.clear(); }

	private close(batch: Batch): void {
		for (const task of batch.tasks) if (active(task)) {
			task.status = task.status === "pending" ? "skipped" : "error";
			task.activity = "";
			task.endedAt = Date.now();
		}
		batch.closed = true;
	}

	private prune(): void {
		const completed = [...this.batches].filter(([, batch]) => batch.closed);
		for (const [id] of completed.slice(0, Math.max(0, completed.length - HISTORY_BATCHES))) this.batches.delete(id);
	}
}

export function subagentDuration(task: SubagentTask, now = Date.now()): string {
	return `${Math.max(0, Math.floor(((task.endedAt ?? now) - (task.startedAt ?? task.queuedAt)) / 1000))}s`;
}

/** Accept only the shared bus contract, not native subagent tool events. */
export function consumeSubagentEvent(monitor: SubagentMonitor, value: unknown): boolean {
	const event = record(value);
	if (!event || typeof event.id !== "string" || !event.id.trim() || event.id.length > 256 || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(event.id)) return false;
	if (event.phase === "start") { monitor.start(event.id, event.args); monitor.update(event.id, event.details); }
	else if (event.phase === "update") monitor.update(event.id, event.details);
	else if (event.phase === "end") monitor.end(event.id, event.details, event.isError === true);
	else return false;
	return true;
}

export function subagentsPanel(theme: Theme, monitor: SubagentMonitor, width: number, maxRows: number, now = Date.now()): string[] {
	width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	maxRows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
	if (!maxRows) return [];
	const tasks = monitor.tasks;
	const running = tasks.filter((task) => task.status === "running").length;
	const pending = tasks.filter((task) => task.status === "pending").length;
	const counter = `${running} activos · ${pending} en cola`;
	const compact = `SUBAGENTS ${running} act/${pending} cola`;
	const title = !tasks.length ? "SUBAGENTS" : visibleWidth(`▌ SUBAGENTS · ${counter} `) <= width
		? `SUBAGENTS · ${counter}` : visibleWidth(`▌ ${compact} `) <= width ? compact : "SUBAGENTS";
	const rows = [sidebarSection(theme, title, width, "syntaxVariable")];
	if (maxRows === 1) return rows;
	if (!tasks.length) return [...rows, fit(theme.fg("dim", "Sin subagentes activos"), width)];
	const slots = maxRows - 1;
	const overflow = tasks.length > slots;
	const shown = overflow ? Math.max(0, slots - 1) : tasks.length;
	for (const task of tasks.slice(0, shown)) {
		const color = task.status === "error" ? "error" : task.status === "done" ? "success" : task.status === "running" ? "accent" : "dim";
		const duration = ` · ${subagentDuration(task, now)}`;
		let line = fit(`${task.agent} · ${task.status}${task.activity ? ` · ${task.activity}` : ""}`, Math.max(0, width - visibleWidth(duration))).trimEnd() + duration;
		if (task.title && visibleWidth(`${line} · ${task.title}`) <= width) line += ` · ${task.title}`;
		rows.push(fit(theme.fg(color, line), width));
	}
	if (overflow) rows.push(fit(theme.fg("muted", `+${tasks.length - shown} más · ${counter}`), width));
	return rows;
}
