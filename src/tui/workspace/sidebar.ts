import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GitSnapshot, Resources } from "./data.ts";
import { workspaceName } from "./data.ts";
import { actionsPanel, type ActionGroup, type ActionState } from "./github-actions.ts";
import type { IssueTriageState } from "./issue-triage.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import type { WorkspaceView } from "./navigation.ts";
import { align, bar, fit, gitSyncSummary, percentage, sidebarSection, surface, text } from "./presentation.ts";
import { subagentsPanel, type SubagentMonitor } from "./subagents.ts";

export type SidebarTarget = WorkspaceView | "workspace" | "actions" | "subagents" | "context" | "resources";
interface SidebarState {
	theme: Theme; cwd: string; height: number; git?: GitSnapshot | undefined; gitError: boolean; resources?: Resources | undefined;
	actions: Record<ActionGroup, ActionState>; project?: string | undefined; envAt?: number | undefined; envError?: string | undefined;
	context: { label: string; percent: number | undefined; limit: number | undefined };
	issueTriage?: IssueTriageState | undefined; subagents: SubagentMonitor;
}

/** Render and hit targets share one layout, including compact/overflow rows. */
export function workspaceSidebar(state: SidebarState, width: number): { lines: string[]; targets: Map<number, SidebarTarget> } {
	const { theme: t, git, gitError, resources: r, context, height } = state;
	const inner = Math.max(1, width - 3); const label = (value: string) => t.fg("muted", value);
	const section = (title: string, color: Parameters<typeof sidebarSection>[3]) => sidebarSection(t, title, inner, color);
	const project = [section("PROYECTO", "syntaxType"), t.bold(text(basename(git?.root ?? state.cwd))),
		t.fg("accent", text(git ? `${git.detached ? "HEAD · " : ""}${git.branch} · ${workspaceName(git)}` : "Sin repositorio Git")),
		gitError ? t.fg("warning", "Git desactualizado") : git ? label(`${git.changeCount} archivos · `) + gitSyncSummary(t, git) : label("Git no disponible")];
	const ram = r ? percentage(r.totalRam - r.availableRam, r.totalRam) : undefined;
	const disk = r?.disk ? percentage(r.disk.used, r.disk.total) : undefined;
	const resources = [section(`EQUIPO · ${text(r?.host ?? "…")}`, "syntaxVariable")];
	const metric = (name: string, value: string, percent?: number): void => {
		if (height >= 24) resources.push(align(name, value, inner), bar(t, percent, inner));
		else resources.push(`${name.padEnd(5)} ${bar(t, percent, 8)} ${value}`);
	};
	metric("CPU", r?.cpu === undefined ? "—" : `${r.cpu.toFixed(0)}%`, r?.cpu);
	metric(`RAM${r?.memoryEstimated ? "≈" : ""}`, r ? `${((r.totalRam - r.availableRam) / 2 ** 30).toFixed(1)} / ${(r.totalRam / 2 ** 30).toFixed(1)} GiB` : "—", ram);
	metric("Disco", disk === undefined ? "—" : `${disk.toFixed(0)}% ocupado`, disk);
	resources.push(label(r ? `OMI ${r.processCpu?.toFixed(1) ?? "—"}% · ${(r.rss / 2 ** 20).toFixed(0)} MiB` : "Recolectando métricas…"));
	if ((ram ?? 0) >= 90 || (disk ?? 0) >= 90) resources.push(t.fg("warning", "! Revisá RAM y disco"));
	resources.push(label("Detalles del host >"));
	const contexts = [section("CONTEXTO", "warning"), align(`${context.label}${context.limit === undefined ? "" : " tokens"}`, context.percent === undefined ? "—" : `${context.percent.toFixed(0)}%`, inner), bar(t, context.percent, inner), ""];
	const triage = state.issueTriage && (!git || git.root === state.issueTriage.worktree && git.branch === state.issueTriage.branch) ? state.issueTriage : undefined;
	const issue = triage ? [...(height >= 24 ? [""] : []), section("ISSUE ACTIVO", "accent"), t.fg("accent", `#${triage.issue.number} · ${ISSUE_TYPES[triage.triage.type].label}`), label(text(triage.issue.title))] : [];
	// Reserve every section first, even with eight tasks in a 26-row terminal.
	if (issue.length && height < 28) resources.splice(4);
	const minimum = () => project.length + 3 + 2 + 2 + contexts.length + resources.length + issue.length;
	if (minimum() > height) project.splice(1, 1);
	if (minimum() > height) contexts.pop();
	let spare = Math.max(0, height - minimum());
	const subagentRows = Math.min(Math.max(2, Math.min(10, state.subagents.tasks.length + 1)), 2 + spare);
	spare -= subagentRows - 2;
	let actions = actionsPanel(t, state.actions, inner, 0);
	for (let count = 3; count >= 1; count--) {
		const candidate = actionsPanel(t, state.actions, inner, count);
		if (candidate.length <= 3 + spare) { actions = candidate; break; }
	}
	spare -= actions.length - 3;
	const lines: string[] = []; const targets = new Map<number, SidebarTarget>();
	const add = (rows: string[], target?: SidebarTarget): void => { for (const line of rows) { if (target) targets.set(lines.length, target); lines.push(line); } };
	const gap = (): void => { if (spare > 0) { lines.push(""); spare--; } };
	add(project, "workspace"); gap(); add(actions, "actions"); gap();
	add([section("OMI", "success"), state.envError ? t.fg("warning", state.project ? "Datos desactualizados" : state.envError === "Offline" ? "Offline" : "No disponible") : label(text(state.project ?? (state.envAt ? "Sin proyecto vinculado" : "Consultando…")))], "omi");
	gap(); add(subagentsPanel(t, state.subagents, inner, subagentRows), "subagents"); gap();
	add(contexts, "context"); add(resources, "resources"); add(issue);
	while (lines.length < height) lines.push("");
	return { lines: lines.slice(0, height).map((line) => surface(t, `│ ${fit(line, inner)} `, width, true)), targets };
}
