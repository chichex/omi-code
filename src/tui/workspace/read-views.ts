// Presenters de las vistas de sólo lectura. La selección, carga y navegación viven en el controlador.
import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EnvironmentStatus, GitSnapshot, GithubItem } from "./data.ts";
import type { IssuePreparationEntry } from "./issue-registry.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import { align, changedFileLine, surface, text } from "./presentation.ts";

export type GithubView = "issues" | "prs";
export interface GithubListSnapshot { readonly items: readonly GithubItem[] | undefined; readonly error: string | undefined; readonly at: number | undefined; readonly selected: number }
interface ChangesSnapshot { git: GitSnapshot | undefined; gitError: boolean; diff: string | undefined; diffLoading: boolean; selectedFile: number }
interface GithubSnapshot {
	kind: GithubView;
	state: GithubListSnapshot;
	hasGit: boolean;
	remoteBusy: boolean;
	preparations: ReadonlyMap<number, IssuePreparationEntry>;
	preparationsError: string | undefined;
	detailBusy: boolean;
	now: number;
}
/** `foundations`: las líneas del harness (vigente, procedencia, políticas y catálogo), ya sin secuencias del terminal. */
interface OmiSnapshot { project: string | undefined; services: readonly string[]; environments: readonly EnvironmentStatus[]; error: string | undefined; at: number | undefined; now: number; foundations: readonly string[] }
const age = (at: number | undefined, now: number): string => at === undefined ? "sin datos" : `hace ${Math.max(0, Math.floor((now - at) / 1000))}s`;

export function changesViewLines(t: Theme, snapshot: ChangesSnapshot, width: number): string[] {
	const { git, gitError, diff, diffLoading, selectedFile } = snapshot;
	const lines = [t.bold(" Cambios locales"), t.fg("dim", " ↑ ↓ seleccionar · Enter diff / archivo nuevo · Backspace volver · Esc chat"), ""];
	if (diffLoading) lines.push(" Cargando diff…");
	else if (diff !== undefined) lines.push(...diff.split("\n").map((line) => line.startsWith("+") ? t.fg("success", text(line)) : line.startsWith("-") ? t.fg("error", text(line)) : text(line)));
	else if (!git) lines.push(" No hay un repositorio Git disponible.");
	else { if (gitError) lines.push(t.fg("warning", " Datos Git desactualizados")); if (!git.changes.length) lines.push(" No hay cambios locales."); git.changes.forEach((file, index) => lines.push(changedFileLine(t, file, width, index === selectedFile))); if (git.changeCount > git.changes.length) lines.push(` Mostrando ${git.changes.length} de ${git.changeCount} archivos.`); }
	return lines.map((line) => surface(t, line, width));
}

export function githubViewLines(t: Theme, snapshot: GithubSnapshot, width: number): string[] {
	const { kind, state, hasGit, remoteBusy, preparations, preparationsError, detailBusy, now } = snapshot;
	const name = kind === "issues" ? "Issues" : "PRs";
	const lines = [t.bold(` ${name} abiertos`), t.fg("dim", " ↑ ↓ seleccionar · Enter detalle · r actualizar · Esc chat"), t.fg("dim", ` Todo el repositorio · ${age(state.at, now)}`), ""];
	if (state.error) lines.push(t.fg("warning", ` ${state.error}${state.items ? " · datos desactualizados" : ""}`));
	if (kind === "issues" && preparationsError) lines.push(t.fg("warning", ` ${preparationsError}`));
	if (!hasGit) lines.push(" No hay un repositorio Git disponible.");
	else if (!state.items && !state.error) lines.push(remoteBusy ? " Consultando GitHub…" : " Sin datos. Pulsá r para actualizar.");
	else if (state.items?.length === 0) lines.push(` No hay ${name.toLowerCase()} abiertos en la última consulta.`);
	for (const [index, item] of (state.items ?? []).entries()) {
		const saved = kind === "issues" ? preparations.get(item.number) : undefined;
		const badges = kind === "prs" ? "" : saved?.record ? ` [${ISSUE_TYPES[saved.record.state.triage.type].label}] [${saved.error ? "Revisar" : saved.record.phase === "ready" ? basename(saved.record.state.worktree) : "Pendiente"}]` : saved?.error || preparationsError ? " [Registro no disponible]" : " [Sin triage]";
		const line = align(` ${index === state.selected ? "›" : " "} #${item.number}${item.draft ? " [borrador]" : ""}${badges} ${text(item.title)}`, text(`@${item.author}`), width);
		lines.push(index === state.selected ? t.fg("accent", line) : line);
	}
	if (state.items?.length === 100) lines.push(t.fg("dim", " Mostrando hasta 100 resultados abiertos."));
	if (detailBusy) lines.push(t.fg("muted", " Cargando detalle…"));
	return lines.map((line) => surface(t, line, width));
}

export function omiViewLines(t: Theme, snapshot: OmiSnapshot, width: number): string[] {
	const { project, services, environments, error, at, now, foundations } = snapshot;
	const lines = [t.bold(" OMI"), t.fg("dim", " r actualizar · f Foundations · Esc chat · infraestructura del proyecto"), "", t.fg("accent", ` PROYECTO OMI · ${age(at, now)}`)];
	if (error) lines.push(t.fg("warning", ` ${error}${project ? " · datos desactualizados" : ""}`));
	if (project) {
		lines.push(` ${text(project)}`, "", t.fg("accent", " SERVICIOS Y AMBIENTES"));
		for (const service of services) {
			lines.push(t.bold(` ${text(service)}`));
			const serviceEnvironments = environments.filter((environment) => environment.service === service);
			for (const environment of serviceEnvironments) lines.push(text(`   ${environment.name} · ${environment.version ?? "sin versión"} · ${environment.state}`));
			if (!serviceEnvironments.length) lines.push(t.fg("muted", "   Sin ambientes informados."));
		}
	} else if (!error) lines.push(at ? " Sin proyecto OMI vinculado. Usá omi init para vincularlo." : " Consultando vínculo y ambientes OMI…");
	// Se parte en líneas: un catálogo largo se ve entero, desplazando la vista.
	lines.push("", t.fg("accent", " FOUNDATIONS · cuándo te pide confirmación el agente"), ...foundations.flatMap((line) => wrapTextWithAnsi(text(line), Math.max(1, width - 2)).map((part) => ` ${part}`)),
		t.fg("dim", " f editar"));
	lines.push("", t.fg("accent", " OPERACIONES OMI"), " Estado, variables, recursos, jobs, versiones, logs y deploys:", " pedilos en Chat. Se conservan las herramientas y confirmaciones.", "", t.fg("dim", " Vista de sólo lectura. Un estado running no es un health check."));
	return lines.map((line) => surface(t, line, width));
}
