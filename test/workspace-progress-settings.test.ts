import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { GitSnapshot } from "../src/tui/workspace/data.ts";
import type { SidebarState } from "../src/tui/workspace/sidebar.ts";
import { workspaceSidebar } from "../src/tui/workspace/sidebar.ts";
import { SubagentMonitor } from "../src/tui/workspace/subagents.ts";
import type { WorkflowProgress } from "../src/tui/workspace/workflow-progress.ts";

const git: GitSnapshot = { root: "/repo/worktree", gitDir: "/repo/.git", commonDir: "/repo/.git", mainRoot: "/repo", linked: true,
	branch: "feat/workflow", detached: false, changes: [], changeCount: 1, tracking: true, ahead: 0, behind: 0 };
const progress: WorkflowProgress = { id: "workflow-42", issueNumber: 42, worktree: git.root, branch: git.branch,
	phaseLabel: "Implementación", routeLabel: "TDD", activity: "Escribiendo pruebas", status: "waiting", completedSteps: 2, totalSteps: 5,
	passedChecks: 1, totalChecks: 3, blockedReason: "Falta aprobación", details: [] };
function state(overrides: Partial<SidebarState> = {}): SidebarState {
	return { theme: getThemeByName("dark")!, cwd: git.root, height: 64, git, gitError: false,
		actions: { reviews: { error: "Offline" }, releases: { error: "Offline" } }, context: { label: "12k / 200k", percent: 6, limit: 200000 },
		model: { name: "Modelo real", provider: "Proveedor real" }, thinking: "high", session: { input: 12000, output: 1000,
			cacheRead: 5000, cacheWrite: 1000, cost: .1234, lastCost: .0234, responses: 2 }, subagents: new SubagentMonitor(),
		issueTriage: { version: 1, issue: { number: 42, title: "Issue original", url: "" }, triage: { type: "fix", summary: "", rationale: "",
			 scope: [], acceptanceCriteria: [], questions: [] }, worktree: git.root, branch: git.branch, baseRef: "main", baseCommit: "a".repeat(40) },
		workflowProgress: progress, ...overrides };
}
function plain(result: ReturnType<typeof workspaceSidebar>): string[] { return result.lines.map(stripTerminalSequences); }

test("workspace_progress_settings: progreso sustituye issue con cajas y detalle clickeable", () => {
	const result = workspaceSidebar(state(), 48); const rows = plain(result); const screen = rows.join("\n");
	for (const expected of [/PROGRESO.*#42/, /Esperando.*Implementación/, /Ruta: TDD/, /Escribiendo pruebas/, /Pasos 2\/5.*Checks 1\/3/, /! Falta aprobación/]) assert.match(screen, expected);
	assert.doesNotMatch(screen, /ISSUE ACTIVO|Issue original|▌|█/);
	assert.equal(rows.filter((line) => line.startsWith("┌")).length, 7);
	const start = rows.findIndex((line) => line.includes("PROGRESO")); const end = rows.findIndex((line, index) => index > start && line.startsWith("└"));
	for (let index = start; index <= end; index++) assert.equal(result.targets.get(index), "progress", rows[index]);
	assert.equal(result.targets.get(rows.length - 1), "sidebar-settings");
});

test("workspace_progress_settings: a 20 filas sobrevive cada panel, bloqueo y destinos de main", () => {
	for (const width of [41, 48]) for (const height of [20, 26, 34, 64]) {
		const result = workspaceSidebar(state({ height }), width); const rows = plain(result); const screen = rows.join("\n");
		assert.equal(rows.length, height); assert.ok(result.lines.every((line) => visibleWidth(line) === width));
		for (const title of ["PROYECTO", "SESIÓN", "GITHUB ACTIONS", "OMI", "SUBAGENTES", "RECURSOS", "PROGRESO"]) assert.ok(rows.some((line) => line.includes(title)), `${width}x${height}: ${title}\n${screen}`);
		assert.match(screen, /Falta aprobación/); assert.match(screen, /Implementación/); assert.match(screen, /Modelo real/); assert.match(screen, /\$0\.1234/);
		for (const metric of ["CPU", "RAM", "Disco"]) assert.match(screen, new RegExp(`${metric}\\s+[○●◯]+ —`));
		for (const target of ["workspace", "model", "context", "actions", "omi", "subagents", "resources", "progress", "sidebar-settings"] as const) assert.ok([...result.targets.values()].includes(target), target);
		assert.equal(rows.at(-1)!.trim(), "Personalizar lateral >"); assert.match(rows[height - 2]!, /└.*┘$|^\s*$/);
		assert.ok([...result.targets.keys()].every((index) => index >= 0 && index < height));
	}
});

test("workspace_progress_settings: ocultar issue oculta progreso sin ampliar preferencias", () => {
	for (const height of [20, 64]) {
		const result = workspaceSidebar(state({ height, hiddenSections: ["issue"] }), 48); const screen = plain(result).join("\n");
		assert.doesNotMatch(screen, /PROGRESO|ISSUE ACTIVO|Falta aprobación|Issue original/);
		assert.ok(![...result.targets.values()].includes("progress")); assert.ok(screen.includes("Personalizar lateral >"));
	}
	const result = workspaceSidebar(state({ hiddenSections: ["workspace", "session", "actions", "omi", "subagents", "resources", "issue"] }), 48);
	assert.ok(plain(result).slice(0, -1).every((line) => !line.trim())); assert.deepEqual([...result.targets], [[63, "sidebar-settings"]]);
});

test("workspace_progress_settings: sin matching no filtra progreso y conserva issue activo", () => {
	for (const workflowProgress of [undefined, { ...progress, branch: "other" }, { ...progress, worktree: "/other" }]) {
		const result = workspaceSidebar(state({ workflowProgress }), 48); const screen = plain(result).join("\n");
		assert.doesNotMatch(screen, /PROGRESO|Falta aprobación/); assert.match(screen, /ISSUE ACTIVO/); assert.match(screen, /Issue original/);
		assert.ok(![...result.targets.values()].includes("progress"));
	}
});

test("workspace_progress_settings: no inventa checks o éxito ni requiere bloqueo", () => {
	const workflowProgress = { ...progress, status: "active" as const, blockedReason: "", totalChecks: 0, passedChecks: 0 };
	const screen = plain(workspaceSidebar(state({ workflowProgress }), 48)).join("\n");
	assert.match(screen, /En curso/); assert.match(screen, /sin checks informados/); assert.doesNotMatch(screen, /Completo|Falta aprobación|Checks 0\/0/);
	const compact = plain(workspaceSidebar(state({ workflowProgress, height: 20 }), 48)).join("\n");
	assert.match(compact, /Implementación/); assert.match(compact, /Escribiendo pruebas/); assert.match(compact, /RECURSOS/);
	assert.doesNotMatch(compact, /Completo|Falta aprobación|Checks 0\/0/);
});

test("workspace_progress_settings: espacio adicional prioriza pasos y bloqueo antes de otros detalles", () => {
	const screen = plain(workspaceSidebar(state({ height: 22 }), 48)).join("\n");
	assert.match(screen, /Falta aprobación/); assert.match(screen, /Pasos 2\/5.*Checks 1\/3/);
});
