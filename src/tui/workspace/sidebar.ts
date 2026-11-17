import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GitSnapshot, Resources } from "./data.ts";
import { workspaceName } from "./data.ts";
import { actionsPanel, type ActionGroup, type ActionState } from "./github-actions.ts";
import { dots, reasoningDots, sidebarBox, sidebarSurface } from "./indicators.ts";
import type { IssueTriageState } from "./issue-triage.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import type { WorkspaceView } from "./navigation.ts";
import type { SidebarSectionId } from "./preferences.ts";
import { fit, gitSyncSummary, percentage, text, tokens } from "./presentation.ts";
import type { SessionStats } from "./session-stats.ts";
import { subagentsPanel, type SubagentMonitor } from "./subagents.ts";

export type SidebarTarget = WorkspaceView | "workspace" | "actions" | "subagents" | "context" | "resources" | "model" | "sidebar-settings";
export interface SidebarState {
	theme: Theme; cwd: string; height: number; git?: GitSnapshot | undefined; gitError: boolean; resources?: Resources | undefined;
	actions: Record<ActionGroup, ActionState>; project?: string | undefined; envAt?: number | undefined; envError?: string | undefined;
	context: { label: string; percent: number | undefined; limit: number | undefined };
	issueTriage?: IssueTriageState | undefined; subagents: SubagentMonitor;
	hiddenSections?: readonly SidebarSectionId[] | undefined; model?: { name: string; provider: string } | undefined;
	thinking?: string | undefined; session?: SessionStats | undefined;
}
interface Row { line: string; target?: SidebarTarget }
interface Panel {
	id: SidebarSectionId; title: string; color: ThemeColor; target?: SidebarTarget; rows: Row[];
}
const row = (line: string, target?: SidebarTarget): Row => target ? { line, target } : { line };
const money = (value: number): string => `$${value.toFixed(4)}`;

function projectPanel(state: SidebarState, width: number, compact: boolean): Panel {
	const { theme: t, git, gitError } = state;
	const name = text(basename(git?.root ?? state.cwd));
	const summary = gitError ? t.fg("warning", "Git desactualizado") : git
		? t.fg("muted", `${git.changeCount} archivos · `) + gitSyncSummary(t, git) : t.fg("dim", "Git no disponible");
	const branch = git ? text(`${git.detached ? "HEAD · " : ""}${git.branch}`) : "Sin repositorio Git";
	const compactLine = git ? `${fit(t.fg("accent", branch), Math.max(0, width - visibleWidth(summary) - 3)).trimEnd()} · ${summary}` : branch;
	return { id: "workspace", title: compact ? `PROYECTO · ${name}` : "PROYECTO", color: "syntaxType", target: "workspace",
		rows: compact ? [row(gitError && !git ? summary : compactLine)] : [row(t.bold(name)),
			row(t.fg("accent", `${branch}${git ? ` · ${text(workspaceName(git))}` : ""}`)), row(summary)] };
}

function sessionPanel(state: SidebarState, width: number, compact: boolean): Panel {
	const { theme: t, context, model, thinking, session } = state;
	const modelName = model ? text(model.name) : "Modelo no disponible";
	const effort = thinking ? `${reasoningDots(t, thinking)} ${text(thinking)}` : t.fg("dim", "—");
	const modelRow = compact ? `${fit(t.bold(modelName), Math.max(0, width - visibleWidth(effort) - 3)).trimEnd()} · ${effort}`
		: t.bold(modelName) + (model ? t.fg("dim", ` · ${text(model.provider)}`) : "");
	const rows = [row(modelRow, "model")];
	if (!compact) rows.push(row(`Razonamiento ${effort}`, "model"));
	const percent = context.percent === undefined ? "—" : `${context.percent.toFixed(0)}%`;
	const meter = `${dots(t, context.percent)} ${percent}`;
	const usage = `${text(context.label)}${context.limit === undefined ? "" : " tokens"}`;
	rows.push(row(`${fit(usage, Math.max(0, width - visibleWidth(meter) - 1)).trimEnd()} ${meter}`, "context"));
	// A freshly opened session has no usage evidence; don't manufacture zero-cost responses.
	if (session && (session.responses > 0 || session.input + session.output + session.cacheRead + session.cacheWrite > 0 || session.cost > 0)) {
		const used = `↑${tokens(session.input)} ↓${tokens(session.output)}`;
		if (compact) rows.push(row(`${used} · Cache ${tokens(session.cacheRead)}/${tokens(session.cacheWrite)} · ${money(session.cost)}`, "context"));
		else rows.push(row(`Uso ${used} · ${session.responses} resp.`, "context"),
			row(`Cache ${tokens(session.cacheRead)} leídos · ${tokens(session.cacheWrite)} escritos`, "context"),
			row(`Costo ${money(session.cost)} · últ. ${money(session.lastCost)}`, "context"));
	}
	return { id: "session", title: "SESIÓN", color: "warning", target: "model", rows };
}

function omiPanel(state: SidebarState, compact: boolean): Panel {
	const { theme: t } = state;
	const status = state.envError ? state.project ? "Datos desactualizados" : state.envError === "Offline" ? "Offline" : "No disponible"
		: text(state.project ?? (state.envAt ? "Sin proyecto vinculado" : "Consultando…"));
	return { id: "omi", title: compact ? `OMI · ${status}` : "OMI", color: state.envError ? "warning" : "success", target: "omi",
		rows: compact ? [] : [row(t.fg(state.envError ? "warning" : "muted", status))] };
}

function resourcesPanel(state: SidebarState): Panel {
	const { theme: t, resources: r } = state;
	const ram = r ? percentage(r.totalRam - r.availableRam, r.totalRam) : undefined;
	const disk = r?.disk ? percentage(r.disk.used, r.disk.total) : undefined;
	const metric = (name: string, value: string, percent: number | undefined) => row(`${name.padEnd(6)}${dots(t, percent, 10)} ${value}`);
	return { id: "resources", title: `RECURSOS · ${text(r?.host ?? "…")}`, color: "syntaxVariable", target: "resources", rows: [
		metric("CPU", r?.cpu === undefined ? "—" : `${r.cpu.toFixed(0)}%`, r?.cpu),
		metric(`RAM${r?.memoryEstimated ? "≈" : ""}`, r ? `${((r.totalRam - r.availableRam) / 2 ** 30).toFixed(1)}/${(r.totalRam / 2 ** 30).toFixed(1)} GiB` : "—", ram),
		metric("Disco", disk === undefined ? "—" : `${disk.toFixed(0)}%`, disk),
	] };
}

function panels(state: SidebarState, width: number, compact: boolean): Panel[] {
	const { theme: t, git, issueTriage: triage } = state;
	const issue = triage && (!git || git.root === triage.worktree && git.branch === triage.branch) ? triage : undefined;
	const tasks = state.subagents.tasks;
	const failures = tasks.filter((task) => task.status === "error").length;
	const running = tasks.filter((task) => task.status === "running").length;
	const pending = tasks.filter((task) => task.status === "pending").length;
	const counts = failures ? `${failures} ${failures === 1 ? "error" : "errores"}${running || pending ? ` · ${running}/${pending} act/cola` : ""}` : `${running} act/${pending} cola`;
	const result: Panel[] = [projectPanel(state, width, compact), sessionPanel(state, width, compact),
		{ id: "actions", title: "GITHUB ACTIONS", color: "mdLink", target: "actions", rows: actionsPanel(t, state.actions, width, 0).slice(1).map((line) => row(line)) },
		omiPanel(state, compact),
		{ id: "subagents", title: `SUBAGENTES${tasks.length ? ` · ${counts}` : ""}`, color: failures ? "error" : "syntaxVariable", target: "subagents",
			rows: subagentsPanel(t, state.subagents, width, 2).slice(1).map((line) => row(line)) },
		resourcesPanel(state)];
	if (issue) result.push({ id: "issue", title: compact ? `ISSUE ACTIVO · #${issue.issue.number} · ${ISSUE_TYPES[issue.triage.type].label}` : "ISSUE ACTIVO", color: "accent",
		rows: [...(compact ? [] : [row(t.fg("accent", `#${issue.issue.number} · ${ISSUE_TYPES[issue.triage.type].label}`))]), row(t.fg("muted", text(issue.issue.title)))] });
	return result.filter((panel) => !state.hiddenSections?.includes(panel.id));
}

function layoutHeight(panels: Panel[], joined: boolean): number {
	return panels.reduce((total, panel) => total + panel.rows.length + (joined ? 1 : 2), 0) + (joined && panels.length ? 1 : 0);
}

/** Spend only spare rows, after every visible section, the last border and settings have been reserved. */
function expandPanels(state: SidebarState, current: Panel[], normal: Panel[], width: number, spare: number, joined: boolean): void {
	const replace = (id: SidebarSectionId, rows: Row[], title?: string): void => {
		const panel = current.find((item) => item.id === id); if (!panel) return;
		const extra = rows.length - panel.rows.length;
		if (extra < 0 || extra > spare) return;
		panel.rows = rows; if (title) panel.title = title; spare -= extra;
	};
	if (joined) for (const id of ["session", "workspace", "omi", "issue"] as const) {
		const panel = normal.find((item) => item.id === id); if (panel) replace(id, panel.rows, panel.title);
	}
	replace("subagents", subagentsPanel(state.theme, state.subagents, width, Math.min(9, spare + 2)).slice(1).map((line) => row(line)));
	for (let count = 1; count <= 3; count++) replace("actions", actionsPanel(state.theme, state.actions, width, count).slice(1).map((line) => row(line)));
	const resources = current.find((panel) => panel.id === "resources"); if (!resources) return;
	const r = state.resources;
	const ram = r ? percentage(r.totalRam - r.availableRam, r.totalRam) : undefined;
	const disk = r?.disk ? percentage(r.disk.used, r.disk.total) : undefined;
	const details = [
		...((ram ?? 0) >= 90 || (disk ?? 0) >= 90 ? [state.theme.fg("warning", "! Revisá RAM y disco")] : []),
		state.theme.fg("muted", r ? `OMI ${r.processCpu?.toFixed(1) ?? "—"}% · ${(r.rss / 2 ** 20).toFixed(0)} MiB` : "Recolectando métricas…"),
		state.theme.fg("muted", "Detalles del host >"),
	];
	for (const detail of details) replace("resources", [...resources.rows, row(detail)]);
}

/** Rendering and hit targets use the same rows; hidden sections never own cells. */
export function workspaceSidebar(state: SidebarState, width: number): { lines: string[]; targets: Map<number, SidebarTarget> } {
	width = Math.max(0, Math.floor(width));
	const height = Math.max(0, Math.floor(state.height)); const inner = Math.max(0, width - 4);
	if (!height) return { lines: [], targets: new Map() };
	const normal = panels(state, inner, false);
	// Compact mode shares rectangular borders instead of cutting off the bottom sections.
	const joined = layoutHeight(normal, false) + 1 > height;
	const current = joined ? panels(state, inner, true) : normal;
	expandPanels(state, current, normal, inner, height - 1 - layoutHeight(current, joined), joined);
	const lines: string[] = []; const targets = new Map<number, SidebarTarget>();
	const add = (line: string, target?: SidebarTarget): void => { if (target) targets.set(lines.length, target); lines.push(line); };
	for (const [index, panel] of current.entries()) {
		const box = sidebarBox(state.theme, panel.title, panel.rows.map((row) => row.line), width, panel.color);
		add(joined && index ? box[0]!.replace("┌", "├").replace("┐", "┤") : box[0]!, panel.target);
		for (const [offset, content] of panel.rows.entries()) add(box[offset + 1]!, content.target ?? panel.target);
		if (!joined || index === current.length - 1) add(box.at(-1)!, panel.target);
	}
	// The workspace only mounts this sidebar at >=20 rows. Fail gracefully outside that contract.
	if (lines.length >= height && height > 0) {
		lines.length = Math.max(0, height - 1);
		for (const index of targets.keys()) if (index >= lines.length) targets.delete(index);
	}
	while (lines.length < height - 1) lines.push("");
	if (height) add(state.theme.fg("muted", "Personalizar lateral >"), "sidebar-settings");
	return { lines: lines.map((line) => sidebarSurface(state.theme, line, width)), targets };
}
