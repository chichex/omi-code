import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { GitSnapshot } from "./data.ts";
import type { StageProgress } from "../../harness/progress.ts";
import { field, notice, section, type ModalEntry } from "./modals.ts";
import { fit, sidebarSection } from "./presentation.ts";

/** Observed workflow metadata only. UI never runs steps or derives check results. */
export interface WorkflowProgress {
 id: string; issueNumber: number; worktree: string; branch: string;
 phaseLabel: string; routeLabel: string; activity: string;
 status: "active" | "waiting" | "paused" | "complete";
 completedSteps: number; totalSteps: number; passedChecks: number; totalChecks: number;
 blockedReason: string; details: string[];
 stages?: StageProgress[];
}
const clean = (value: string): string => {
 const plain = stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
 const bounded = plain.slice(0, 1000);
 return /[\ud800-\udbff]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
};
function checkoutPath(path: string): string { try { return realpathSync.native(path); } catch { return resolve(path); } }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && cleanIdentity(value) === value;
// Identity must not change when sanitized: never turn a different checkout into a match.
const cleanIdentity = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
function parseProgress(value: unknown): WorkflowProgress | undefined {
 if (!record(value) || !identity(value.id) || !identity(value.worktree) || !isAbsolute(value.worktree) || !identity(value.branch)) return;
 if (!counter(value.issueNumber) || value.issueNumber === 0 || !counter(value.completedSteps) || !counter(value.totalSteps) || !counter(value.passedChecks) || !counter(value.totalChecks)) return;
 if (value.completedSteps > value.totalSteps || value.passedChecks > value.totalChecks) return;
 if (value.status !== "active" && value.status !== "waiting" && value.status !== "paused" && value.status !== "complete") return;
 if (typeof value.phaseLabel !== "string" || typeof value.routeLabel !== "string" || typeof value.activity !== "string" || typeof value.blockedReason !== "string") return;
 if (!Array.isArray(value.details) || !value.details.every((line: unknown) => typeof line === "string")) return;
 // Extra fields are ignored; copies contain only the public presentation contract.
 return { id: value.id, issueNumber: value.issueNumber, worktree: value.worktree, branch: value.branch,
  phaseLabel: clean(value.phaseLabel), routeLabel: clean(value.routeLabel), activity: clean(value.activity), status: value.status,
  completedSteps: value.completedSteps, totalSteps: value.totalSteps, passedChecks: value.passedChecks, totalChecks: value.totalChecks,
  blockedReason: clean(value.blockedReason), details: value.details.slice(0, 100).map(clean) };
}
export function matchingWorkflow(progress: WorkflowProgress | undefined, cwd: string, git: GitSnapshot | undefined): WorkflowProgress | undefined {
 if (!progress || !git || git.detached || git.branch !== progress.branch || checkoutPath(git.root) !== checkoutPath(progress.worktree)) return;
 const child = relative(checkoutPath(progress.worktree), checkoutPath(cwd));
 return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? progress : undefined;
}
export class WorkflowProgressMonitor {
 private progress: WorkflowProgress | undefined;
 consume(event: unknown): boolean {
  if (!record(event) || !Object.hasOwn(event, "progress")) return false;
  if (event.progress === undefined) { this.clear(); return true; }
  const progress = parseProgress(event.progress); if (!progress) return false;
  this.progress = progress; return true;
 }
 current(cwd: string, git: GitSnapshot | undefined): WorkflowProgress | undefined {
  const current = matchingWorkflow(this.progress, cwd, git);
  return current ? { ...current, details: [...current.details] } : undefined;
 }
 clear(): void { this.progress = undefined; }
}
const statuses = { active: "En curso", waiting: "Esperando", paused: "Pausado", complete: "Completo" } satisfies Record<WorkflowProgress["status"], string>;
function tone(progress: WorkflowProgress): ThemeColor { return progress.blockedReason || progress.status === "waiting" || progress.status === "paused" ? "warning" : "accent"; }
const counts = (p: WorkflowProgress): string => `Pasos ${p.completedSteps}/${p.totalSteps} · ${p.totalChecks ? `Checks ${p.passedChecks}/${p.totalChecks}` : "sin checks informados"}`;
export function workflowProgressPanel(theme: Theme, progress: WorkflowProgress, width: number, maxRows: number): string[] {
 const p = progress; const color = tone(p);
 const rows = [sidebarSection(theme, `PROGRESO · #${p.issueNumber}`, width, color),
  theme.fg(color, `${statuses[p.status]} · ${clean(p.phaseLabel)}`),
  theme.fg("muted", `Ruta: ${clean(p.routeLabel)}`),
  clean(p.activity) || "Sin actividad informada", theme.fg("muted", counts(p)),
  ...(p.blockedReason ? [theme.fg("warning", `! ${clean(p.blockedReason)}`)] : []),
  theme.fg("dim", "/omi-progress · detalle >")];
 // Blocking reason takes precedence over activity in extremely short panels.
 if (maxRows < rows.length && p.blockedReason && maxRows >= 2) rows.splice(Math.max(1, maxRows - 1), rows.length, theme.fg("warning", `! ${clean(p.blockedReason)}`));
 return rows.slice(0, Math.max(0, maxRows)).map((row) => fit(row, width));
}
export function workflowProgressDetail(progress: WorkflowProgress | undefined): ModalEntry[] {
 if (!progress) return [notice("Sin progreso de desarrollo para el checkout y la rama actuales.")];
 const p = progress;
 return [field("Issue", `#${p.issueNumber}`, "accent"), field("Etapa", clean(p.phaseLabel)), field("Ruta", clean(p.routeLabel)),
  field("Estado", statuses[p.status], tone(p)), field("Actividad", clean(p.activity) || "sin actividad informada"),
  field("Pasos", `${p.completedSteps}/${p.totalSteps}`), field("Checks", p.totalChecks ? `${p.passedChecks}/${p.totalChecks} pasaron` : "sin checks informados"),
  field("Bloqueo", clean(p.blockedReason) || "sin bloqueo informado", tone(p)), "", section("Checkout"), field("Worktree", cleanIdentity(p.worktree)), field("Rama", cleanIdentity(p.branch)),
  "", notice("Sólo datos informados por el harness; este panel no ejecuta pasos ni checks."), section("Detalle observado"), ...p.details.map((line) => notice(clean(line), "text"))];
}
