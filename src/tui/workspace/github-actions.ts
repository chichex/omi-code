import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readCommand, type GitSnapshot, type ReadCommand } from "./data.ts";
import { align, fit, sidebarSection, text } from "./presentation.ts";

export const ACTION_GROUPS = [
	{ id: "reviews", label: "Claude reviews", workflow: "claude-review.yml" },
	{ id: "releases", label: "Releases", workflow: "release.yml" },
] as const;
export type ActionGroup = typeof ACTION_GROUPS[number]["id"];
export interface ActionRun { id: number; name: string; status: string; conclusion: string; createdAt: string; url: string }
export interface ActionState { runs?: ActionRun[]; error?: string }
export async function readActionRuns(git: GitSnapshot, group: ActionGroup, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<ActionRun[]> {
	const workflow = ACTION_GROUPS.find((item) => item.id === group)!.workflow;
	const result = await run("gh", ["run", "list", "--workflow", workflow, "--limit", "3", "--json", "databaseId,displayTitle,headBranch,status,conclusion,createdAt,url"], git.root, signal);
	if (result.code !== 0 || result.truncated) throw new Error("Actions no disponible");
	const raw: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(raw)) throw new Error("Respuesta de Actions no válida");
	return raw.slice(0, 3).map((value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("Run no válido");
		const item = value as Record<string, unknown>;
		if (!Number.isSafeInteger(item.databaseId) || Number(item.databaseId) <= 0 || typeof item.status !== "string") throw new Error("Run no válido");
		return { id: Number(item.databaseId), name: typeof item.displayTitle === "string" && item.displayTitle ? item.displayTitle : typeof item.headBranch === "string" ? item.headBranch : `#${item.databaseId}`,
			status: item.status, conclusion: typeof item.conclusion === "string" ? item.conclusion : "", createdAt: typeof item.createdAt === "string" ? item.createdAt : "", url: typeof item.url === "string" ? item.url : "" };
	});
}
export function runAge(date: string, now = Date.now()): string {
	const at = Date.parse(date); if (!Number.isFinite(at)) return "—";
	const minutes = Math.max(0, Math.floor((now - at) / 60000));
	return minutes < 1 ? "ahora" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
function actionRunStatus(theme: Theme, run: ActionRun): string {
	const [icon, color] = run.status !== "completed" ? [run.status === "in_progress" ? "●" : "◷", "accent"] as const
		: run.conclusion === "success" ? ["✓", "success"] as const
		: ["failure", "timed_out", "startup_failure", "action_required"].includes(run.conclusion) ? ["✗", "error"] as const : ["−", "dim"] as const;
	return theme.fg(color, icon);
}
export function actionRunLine(theme: Theme, run: ActionRun, width: number, now = Date.now()): string {
	const icon = actionRunStatus(theme, run);
	const age = theme.fg("dim", runAge(run.createdAt, now)); const ageWidth = visibleWidth(age);
	if (width < ageWidth + 6) return fit(icon, width);
	return `${icon} ${fit(text(run.name), width - ageWidth - 4)}  ${age}`;
}
// count = 0 conserva ambos workflows en tres filas cuando no caben las ejecuciones.
export function actionsPanel(theme: Theme, states: Record<ActionGroup, ActionState>, width: number, count = 3, now = Date.now()): string[] {
	const lines = [sidebarSection(theme, "GITHUB ACTIONS", width, "mdLink")];
	for (const [index, group] of ACTION_GROUPS.entries()) {
		const state = states[group.id];
		if (count < 1) {
			const latest = state.runs?.[0];
			const error = state.error === "Proyecto sin confianza" ? "Sin confianza" : state.error === "Sin repositorio Git" ? "Sin repo Git" : state.error;
			const summary = error ? theme.fg("warning", state.runs ? "Desactualizado" : error)
				: latest ? `${actionRunStatus(theme, latest)} ${theme.fg("dim", runAge(latest.createdAt, now))}`
				: theme.fg("dim", state.runs ? "Sin runs" : "Consultando…");
			lines.push(align(theme.bold(group.label), summary, width));
			continue;
		}
		if (index) lines.push("");
		lines.push(theme.bold(group.label));
		if (state.error) lines.push(theme.fg("warning", state.runs ? "Datos desactualizados" : state.error));
		if (state.runs?.length) lines.push(...state.runs.slice(0, count).map((run) => actionRunLine(theme, run, width, now)));
		else if (!state.error) lines.push(theme.fg("dim", state.runs ? "Sin ejecuciones" : "Consultando…"));
	}
	return lines.map((line) => fit(line, width));
}
