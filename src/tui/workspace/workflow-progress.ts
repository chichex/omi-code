import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GitSnapshot } from "./data.ts";
import { STAGE_STATUSES, OBSERVED_MODES, type StageProgress } from "../../harness/progress.ts";
import { PHASES } from "../../harness/phases.ts";
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
 /** Avisos de lentes: se muestran, no bloquean. */
 warnings?: string[];
 /** Una línea por PR del stack: número, base, pasos y estado. */
 stack?: string[];
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
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.some(v => v === value);
function parseStages(value: unknown): StageProgress[] | undefined {
 if (!Array.isArray(value) || value.length !== PHASES.length) return;
 const stages: StageProgress[] = [];
 for (const [index, s] of value.entries()) {
  const phase = PHASES[index];
  if (!phase || !record(s) || s.id !== phase.id || typeof s.label !== "string" || typeof s.current !== "boolean" || !oneOf(STAGE_STATUSES, s.status) || !oneOf(OBSERVED_MODES, s.observed) || !oneOf(["unknown", "inline", "subagents"] as const, s.planned)) return;
  stages.push({ id: phase.id, label: clean(s.label), current: s.current, status: s.status, planned: s.planned, observed: s.observed });
 }
 return stages.filter(s => s.current).length === 1 ? stages : undefined;
}
function parseProgress(value: unknown): WorkflowProgress | undefined {
 if (!record(value) || !identity(value.id) || !identity(value.worktree) || !isAbsolute(value.worktree) || !identity(value.branch)) return;
 if (!counter(value.issueNumber) || value.issueNumber === 0 || !counter(value.completedSteps) || !counter(value.totalSteps) || !counter(value.passedChecks) || !counter(value.totalChecks)) return;
 if (value.completedSteps > value.totalSteps || value.passedChecks > value.totalChecks) return;
 if (value.status !== "active" && value.status !== "waiting" && value.status !== "paused" && value.status !== "complete") return;
 if (typeof value.phaseLabel !== "string" || typeof value.routeLabel !== "string" || typeof value.activity !== "string" || typeof value.blockedReason !== "string") return;
 if (!Array.isArray(value.details) || !value.details.every((line: unknown) => typeof line === "string")) return;
 const stages = value.stages === undefined ? undefined : parseStages(value.stages);
 if (value.stages !== undefined && !stages) return;
 const lines = (field: unknown) => field === undefined || Array.isArray(field) && field.every((line: unknown) => typeof line === "string");
 if (!lines(value.warnings) || !lines(value.stack)) return;
 // Extra fields are ignored; copies contain only the public presentation contract.
 return { id: value.id, issueNumber: value.issueNumber, worktree: value.worktree, branch: value.branch,
  phaseLabel: clean(value.phaseLabel), routeLabel: clean(value.routeLabel), activity: clean(value.activity), status: value.status,
  completedSteps: value.completedSteps, totalSteps: value.totalSteps, passedChecks: value.passedChecks, totalChecks: value.totalChecks,
  blockedReason: clean(value.blockedReason), details: value.details.slice(0, 100).map(clean), ...(stages ? { stages } : {}), ...(Array.isArray(value.warnings) ? { warnings: value.warnings.slice(0, 20).map(clean) } : {}), ...(Array.isArray(value.stack) ? { stack: value.stack.slice(0, 20).map(clean) } : {}) };
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
  return current ? { ...current, details: [...current.details], ...(current.stages ? { stages: current.stages.map(s => ({ ...s })) } : {}), ...(current.warnings ? { warnings: [...current.warnings] } : {}), ...(current.stack ? { stack: [...current.stack] } : {}) } : undefined;
 }
 clear(): void { this.progress = undefined; }
}
const stageLabels = { pending: "Pendiente", conditional: "Condicional", active: "En curso", done: "Cumplida", "not-applicable": "No aplica", waiting: "Esperando", paused: "Pausada", failed: "Falló un check/lente", interrupted: "Interrumpida", warning: "Con avisos" } satisfies Record<StageProgress["status"], string>;
const symbols = { pending: "○", conditional: "?", active: "▶", done: "✓", "not-applicable": "–", waiting: "!", paused: "Ⅱ", failed: "×", interrupted: "!", warning: "△" } satisfies Record<StageProgress["status"], string>;
const plannedLabels = { unknown: "sin definir", inline: "inline", subagents: "subagentes" };
const modeLabels = { unknown: "sin observar", inline: "inline", subagent: "subagente", mixed: "inline + subagente", "isolated-lens": "lente aislado", "inline+lens": "inline + lente aislado", "subagent+lens": "subagente + lente aislado", "mixed+lens": "inline + subagente + lente aislado" } satisfies Record<StageProgress["observed"], string>;
const shortModes = { ...modeLabels, unknown: "?", mixed: "inline+sub", "isolated-lens": "lente", "inline+lens": "inline+lente", "subagent+lens": "sub+lente", "mixed+lens": "mixto+lente" };
function stageColor(s: StageProgress): ThemeColor { return s.status === "failed" ? "error" : s.status === "waiting" || s.status === "paused" || s.status === "interrupted" || s.status === "warning" ? "warning" : s.current ? "accent" : s.status === "done" ? "success" : "muted"; }
function stageRow(t: Theme, s: StageProgress): string {
 return t.fg(stageColor(s), `${s.current ? ">" : " "} ${symbols[s.status]} ${clean(s.label)} · ${shortModes[s.observed]}${s.planned === "unknown" ? "" : ` (prev:${s.planned === "subagents" ? "sub" : "inline"})`}`);
}
/** Presenter compartido con el detalle; el scroll/foco pertenecen a ReadView, no al dominio. */
export function workflowProgressView(t: Theme, progress: WorkflowProgress | undefined, width: number): string[] {
 const lines = [t.bold(" Recorrido del harness"), t.fg("dim", " ↑↓ / PgUp PgDn desplazar · Esc chat · Sólo lectura"), ""];
 if (!progress) lines.push(" Sin progreso de desarrollo para el checkout y la rama actuales.");
 else {
  const p = progress;
  lines.push(` Issue #${p.issueNumber} · ${clean(p.routeLabel)}`, ` ${clean(p.activity)}`, ...(p.blockedReason ? [t.fg("warning", ` ! ${clean(p.blockedReason)}`)] : []), "");
  if (!p.stages) lines.push(" Etapas no informadas por este harness.");
  for (const s of p.stages ?? []) lines.push(t.fg(stageColor(s), ` ${s.current ? ">" : " "} ${symbols[s.status]} ${clean(s.label)} · ${stageLabels[s.status]}`), `    Previsto: ${plannedLabels[s.planned]}`, `    Real: ${modeLabels[s.observed]}`);
  if (p.warnings?.length) lines.push("", t.fg("warning", t.bold(" Avisos de lentes · no bloquean, salvo un fail de seguridad")), ...p.warnings.map(w => t.fg("warning", ` △ ${clean(w)}`)));
  if (p.stack?.length) lines.push("", t.bold(" Stack de PRs"), ...p.stack.map(line => ` ${clean(line)}`));
  lines.push("", " ? condicional/sin observar · ○ pendiente · ✓ cumplida · △ con avisos · – no aplica", " Previsto no confirma ejecución. Los lentes son llamadas aisladas.", " Esta vista no ejecuta ni aprueba pasos, checks o publicaciones.");
 }
 return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => fit(line, width));
}
const statuses = { active: "En curso", waiting: "Esperando", paused: "Pausado", complete: "Completo" } satisfies Record<WorkflowProgress["status"], string>;
function tone(progress: WorkflowProgress): ThemeColor { return progress.blockedReason || progress.status === "waiting" || progress.status === "paused" ? "warning" : "accent"; }
const counts = (p: WorkflowProgress): string => `Pasos ${p.completedSteps}/${p.totalSteps} · ${p.totalChecks ? `Checks ${p.passedChecks}/${p.totalChecks}` : "sin checks informados"}`;
const shortcut = (value: string, width: number): string => `${fit(value, Math.max(0, width - 8)).trimEnd()} · Ctrl6`;
export function workflowProgressPanel(theme: Theme, progress: WorkflowProgress, width: number, maxRows: number): string[] {
 const p = progress; const color = tone(p);
 const rows = [sidebarSection(theme, `PROGRESO · #${p.issueNumber}`, width, color),
  theme.fg(color, `${statuses[p.status]} · ${clean(p.phaseLabel)}`),
  theme.fg("muted", `Ruta: ${clean(p.routeLabel)}`),
  p.blockedReason ? clean(p.activity) || "Sin actividad informada" : shortcut(clean(p.activity) || "Sin actividad informada", width), theme.fg("muted", counts(p)),
  ...(p.blockedReason ? [theme.fg("warning", shortcut(`! ${clean(p.blockedReason)}`, width))] : []),
  ...(p.warnings?.length ? [theme.fg("warning", shortcut(`△ Avisos de lentes: ${p.warnings.length}`, width))] : []),
  ...(p.stages ?? []).map(s => stageRow(theme, s)),
  theme.fg("dim", "Ctrl6 · /omi-progress · detalle >")];
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
  "", notice("Sólo datos informados por el harness; este panel no ejecuta pasos ni checks."), section("Recorrido"),
  ...(p.stages ?? []).flatMap(s => [notice(`${s.current ? "> " : ""}${clean(s.label)} · ${stageLabels[s.status]}`, "text"), notice(`Previsto: ${plannedLabels[s.planned]} · Real: ${modeLabels[s.observed]}`)]),
  ...(p.warnings?.length ? [section("Avisos de lentes (no bloquean, salvo un fail de seguridad)"), ...p.warnings.map((line) => notice(clean(line), "warning"))] : []),
  ...(p.stack?.length ? [section("Stack de PRs"), ...p.stack.map((line) => notice(clean(line), "text"))] : []),
  section("Detalle observado"), ...p.details.map((line) => notice(clean(line), "text"))];
}
