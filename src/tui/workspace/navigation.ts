import { visibleWidth } from "@earendil-works/pi-tui";

export const WORKSPACE_VIEWS = [
	{ id: "chat", label: "Chat", command: "omi-chat", key: "ctrl+1" },
	{ id: "issues", label: "Issues", command: "omi-issues", key: "ctrl+2" },
	{ id: "prs", label: "PRs", command: "omi-prs", key: "ctrl+3" },
	{ id: "changes", label: "Cambios", command: "omi-changes", key: "ctrl+4" },
	{ id: "omi", label: "OMI", command: "omi-platform", key: "ctrl+5" },
	{ id: "workflow", label: "Progreso", command: "omi-workflow", key: "ctrl+6" },
] as const;
export type WorkspaceView = typeof WORKSPACE_VIEWS[number]["id"];

/** El hit testing usa exactamente las celdas dibujadas; el espacio sobrante no cambia de vista. */
export function workspaceTabs(width: number, active: WorkspaceView) {
	let labels = WORKSPACE_VIEWS.map((view, index) => view.id === active ? ` [${index + 1} ${view.label}] ` : `  ${index + 1} ${view.label}  `);
	if (visibleWidth(labels.join("")) > width) labels = WORKSPACE_VIEWS.map((view, index) => view.id === active ? `[${index + 1} ${view.label}]` : ` ${index + 1} ${view.label} `);
	if (visibleWidth(labels.join("")) > width) labels = WORKSPACE_VIEWS.map((view, index) => view.id === active ? `[${index + 1} ${view.label}]` : ` ${index + 1} `);
	if (visibleWidth(labels.join("")) > width) labels = WORKSPACE_VIEWS.map((view, index) => view.id === active ? `[${index + 1} ${view.label}]` : "");
	let column = 0;
	return WORKSPACE_VIEWS.map((view, index) => {
		const label = labels[index]!; const start = column; column += visibleWidth(label);
		return { view: view.id, label, start, end: Math.min(width, column) };
	}).filter((tab) => tab.start < tab.end);
}
