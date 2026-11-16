// Shell propio de OMI sobre los componentes y el renderer de Pi. No hay un segundo TUI.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, Container, HStack, isViewportTUI, matchesKey, ScrollView, VStack, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Io } from "../../cli/io.ts";
import { agentDir } from "../../core/paths.ts";
import { readEnvironments, readFileDiff, readGit, readGithub, readGithubDetail, readUntrackedPreview, resourceReader, sensitivePreviewPath, workspaceName, type EnvironmentStatus, type GitSnapshot, type GithubItem, type Resources } from "./data.ts";
import { OmiModelPicker, type PickerResult } from "./model-picker.ts";
import { align, changedFileLine, fit, gib, surface, text, tokens, type ModalOptions } from "./presentation.ts";
import { field, notice, OmiCommandPalette, OmiInfoModal, section, type ModalEntry } from "./modals.ts";

import { WORKSPACE_VIEWS, workspaceTabs, type WorkspaceView } from "./navigation.ts";

import { ACTION_GROUPS, readActionRuns, type ActionGroup, type ActionState } from "./github-actions.ts";
import { workspaceSidebar } from "./sidebar.ts";
import { consumeSubagentEvent, subagentDuration, SubagentMonitor } from "./subagents.ts";
import { footerStatus, readBranchPullRequest, type BranchPullRequest } from "./pull-request.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import { classifyIssue, restoreIssueTriage, type IssueTriageState } from "./issue-triage.ts";
import { assertIssueIdentity, discoverLegacyPreparations, IssuePreparationBusyError, loadIssuePreparations, readIssuePreparation, rememberIssueSession, verifyIssuePreparation, type IssuePreparationEntry } from "./issue-registry.ts";
import { prepareIssue, type IssueClassification } from "./issue-preparation.ts";
import { preparePrincipalSession, PrincipalSessionBusyError } from "./main-workspace.ts";

type View = WorkspaceView;
type GithubView = "issues" | "prs";
interface GithubList { items: GithubItem[] | undefined; error: string | undefined; at: number | undefined; selected: number }
const emptyGithubList = (): GithubList => ({ items: undefined, error: undefined, at: undefined, selected: 0 });
export interface WorkspacePreferences { favorites: string[]; sidebar: boolean }
export async function loadWorkspacePreferences(home: string): Promise<WorkspacePreferences> {
	try {
		const value: unknown = JSON.parse(await readFile(join(agentDir(home), "workspace-ui.json"), "utf8"));
		if (value && typeof value === "object") {
			const data = value as Partial<WorkspacePreferences>;
			return { favorites: Array.isArray(data.favorites) ? data.favorites.filter((key): key is string => typeof key === "string" && key.length < 512).slice(0, 1000) : [], sidebar: data.sidebar !== false };
		}
	} catch { /* Una preferencia rota no impide arrancar. */ }
	return { favorites: [], sidebar: true };
}
export async function saveWorkspacePreferences(home: string, preferences: WorkspacePreferences): Promise<void> {
	const dir = agentDir(home); await mkdir(dir, { recursive: true, mode: 0o700 });
	const target = join(dir, "workspace-ui.json"); const temporary = `${target}.${randomUUID()}.tmp`;
	try { await writeFile(temporary, JSON.stringify(preferences) + "\n", { mode: 0o600 }); await rename(temporary, target); }
	finally { await rm(temporary, { force: true }); }
}

class Lines implements Component {
	private lines: (width: number) => string[];
	private mouse: ((event: TuiMouseEvent) => TuiMouseEventResult | undefined) | undefined;
	constructor(lines: (width: number) => string[], mouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined) { this.lines = lines; this.mouse = mouse; }
	render(width: number): string[] { return this.lines(width); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse?.(event); }
	invalidate(): void {}
}
class PaintedDocument extends Container {
	private theme: () => Theme;
	private minimumHeight: (width: number) => number;
	constructor(document: Component, theme: () => Theme, minimumHeight: (width: number) => number) { super(); this.theme = theme; this.minimumHeight = minimumHeight; this.addChild(document); }
	override render(width: number): string[] {
		const lines = super.render(width);
		while (lines.length < this.minimumHeight(width)) lines.push("");
		return lines.map((line) => surface(this.theme(), line, width));
	}
}
class ReadView implements Component {
	capturesViewportInput = true;
	offset = 0;
	private getLines: (width: number) => string[];
	private input: (data: string) => boolean;
	private redraw: () => void;
	private height: () => number;
	constructor(getLines: (width: number) => string[], input: (data: string) => boolean, redraw: () => void, height: () => number) { this.getLines = getLines; this.input = input; this.redraw = redraw; this.height = height; }
	handleInput(data: string): void {
		if (this.input(data)) return;
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset++;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 10);
		else if (matchesKey(data, "pageDown")) this.offset += 10;
		else if (matchesKey(data, "home")) this.offset = 0;
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { if (event.type === "wheel") { this.offset = Math.max(0, this.offset + (event.wheelDelta ?? 0)); this.redraw(); return { handled: true }; } return undefined; }
	render(width: number): string[] { const lines = this.getLines(width); const height = Math.max(1, this.height()); this.offset = Math.min(this.offset, Math.max(0, lines.length - height)); return lines.slice(this.offset, this.offset + height); }
	invalidate(): void {}
}

export function workspaceExtension(io: Io, args: string[]): InlineExtension {
	return { name: "omi-workspace", factory: async (pi: ExtensionAPI) => {
		if (io.env.OMI_TUI === "classic") return;
		// El import de coding-agent sucede después de fijar PI_CODING_AGENT_DIR en launchTui.
		const { BorderedLoader, CustomEditor, Theme: PiTheme, VERSION, parseArgs } = await import("@earendil-works/pi-coding-agent");
		const parsed = parseArgs(args);
		let active = false; let ctx: ExtensionContext; let tui: TUI | undefined;
		let prefs: WorkspacePreferences = { favorites: [], sidebar: true };
		let view: View = "chat"; let working = false; let blocked = false; let activity = "Listo";
		const runningTools = new Map<string, string>();
		const subagents = new SubagentMonitor(); let unsubscribeSubagents: (() => void) | undefined;
		let git: GitSnapshot | undefined; let gitError = false; let resources: Resources | undefined;
		const github: Record<GithubView, GithubList> = { issues: emptyGithubList(), prs: emptyGithubList() };
		let actions: Record<ActionGroup, ActionState> = { reviews: {}, releases: {} };
		let branchPr: BranchPullRequest | undefined; let branchPrError: string | undefined;
		let openingBranchPr = false;
		let githubDetailBusy = false; let infoPrompt = false; let triageBusy = false; let mainBusy = false;
		let issueTriage: IssueTriageState | undefined;
		let preparations = new Map<number, IssuePreparationEntry>(); let preparationsError: string | undefined;
		let preparationsRepo: string | undefined; let legacyScanned = false; let sessionRemembered = false;
		let legacyPreparations = new Map<number, IssuePreparationEntry>();
		let issuePreparationTask: Promise<unknown> | undefined; let issueSessionTask: Promise<void> | undefined; let mainSessionTask: Promise<unknown> | undefined;
		let environments: EnvironmentStatus[] = []; let services: string[] = []; let project: string | undefined; let envError: string | undefined; let envAt: number | undefined;
		let localBusy = false; let remoteBusy = false; let timer: ReturnType<typeof setInterval> | undefined;
		let lastRemote = 0; let selectedFile = 0; let diff: string | undefined; let diffLoading = false; let diffRequest = 0;
		let baseRoot: Component | undefined; let root: Component | undefined; let projectRoot: Component | undefined; let layoutCompatible = false;
		let document: Component; let pending: Component; let status: Component; let above: Component; let editor: Container; let below: Component; let footer: Component;
		let workspaceDocument: Component; let modelShortcut = "Ctrl L";
		let welcomeCommandStart = 8;
		let unsubscribeInput: (() => void) | undefined; let finishModal: (() => void) | undefined;
		const controller = new AbortController(); const sampleResources = resourceReader();
		const theme = (): Theme => ctx.ui.theme;
		// Sólo presentación: el mensaje original sigue intacto en el historial y en el contexto del modelo.
		pi.registerMarkdownTransformer((markdown, context) => active && context.messageType === "user" && markdown.trim()
			? `**${theme().fg("accent", "▌ Vos")}**\n\n${markdown}` : markdown);
		const rows = (): number => tui?.terminal.rows || 24;
		const sidebarVisible = (width = tui?.terminal.columns ?? 80, height = rows()): boolean => layoutCompatible && tui?.mode === "fullscreen" && prefs.sidebar && width >= 110 && height >= 26;
		const contextState = () => {
			const usage = ctx.getContextUsage();
			const limit = usage?.contextWindow ?? ctx.model?.contextWindow;
			return { percent: usage?.percent ?? undefined, label: limit === undefined ? "sin modelo" : `${usage?.tokens == null ? "—" : tokens(usage.tokens)} / ${tokens(limit)}`, limit };
		};
		const changed = (): void => { if (active) { ensureRoot(); tui?.requestRender(); } };
		let saveQueue = Promise.resolve();
		const save = (): Promise<void> => { const snapshot = { ...prefs, favorites: [...prefs.favorites] }; saveQueue = saveQueue.then(() => saveWorkspacePreferences(io.homeDir, snapshot)).catch(() => { if (active) ctx.ui.notify("No se pudieron guardar las preferencias de la UI", "warning"); }); return saveQueue; };
		const age = (at?: number): string => at === undefined ? "sin datos" : `hace ${Math.max(0, Math.floor((Date.now() - at) / 1000))}s`;
		const gitIdentity = (): string => git ? `${git.root}\0${git.detached}\0${git.branch}` : "";

		async function refreshRemote(): Promise<void> {
			if (!active || remoteBusy) return;
			if (parsed.offline || !ctx.isProjectTrusted()) { const error = parsed.offline ? "Offline" : "Proyecto sin confianza"; github.issues.error = error; github.prs.error = error; actions.reviews.error = error; actions.releases.error = error; branchPrError = error; envError = error; changed(); return; }
			remoteBusy = true; lastRemote = Date.now(); const identity = gitIdentity(); const snapshot = git; changed();
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
			await Promise.all([
				(async () => {
					try {
						const pr = snapshot ? await readBranchPullRequest(snapshot, signal) : undefined;
						if (active && identity === gitIdentity()) { branchPr = pr; branchPrError = undefined; }
					} catch { if (active && identity === gitIdentity()) branchPrError = "PR no disponible · revisá gh / login / red"; }
				})(),
				...ACTION_GROUPS.map(async (group) => {
					try {
						const runs = snapshot ? await readActionRuns(snapshot, group.id, signal) : undefined;
						if (active && identity === gitIdentity()) actions[group.id] = runs ? { runs } : { error: "Sin repositorio Git" };
					} catch { if (active && identity === gitIdentity()) actions[group.id].error = "No disponible"; }
				}),
				...(["issues", "prs"] as const).map(async (kind) => {
					const state = github[kind];
					try {
						const items = snapshot ? await readGithub(snapshot, kind === "issues" ? "issue" : "pr", signal) : undefined;
						if (active && identity === gitIdentity()) {
							const previousIndex = state.selected; const selected = state.items?.[previousIndex]?.number; state.items = items;
							state.selected = Math.max(0, items?.findIndex((item) => item.number === selected) ?? 0);
							if (state.selected !== previousIndex) (kind === "issues" ? issuesPane : prsPane).offset = Math.max(0, state.selected - Math.max(1, rows() - 11) + 1);
							state.error = undefined; state.at = Date.now();
						}
					} catch { if (active && identity === gitIdentity()) state.error = "GitHub no disponible · revisá gh / login / red"; }
				}),
				(async () => {
					try { const value = await readEnvironments({ ...io, cwd: snapshot?.root ?? ctx.cwd }, signal); if (active && identity === gitIdentity()) { environments = value.environments; services = value.services; project = value.project; envError = undefined; envAt = Date.now(); } }
					catch { if (active && identity === gitIdentity()) envError = "OMI no disponible · revisá vínculo / sesión / red"; }
				})(),
			]);
			remoteBusy = false; changed();
			if (active && identity !== gitIdentity()) void refreshRemote();
		}
		async function refreshLocal(): Promise<void> {
			if (!active || localBusy) return; localBusy = true;
			const previousIdentity = gitIdentity();
			await Promise.all([
				(async () => { try { const value = await readGit(ctx.cwd, controller.signal); if (active) { git = value; gitError = false; } } catch { if (active) gitError = true; } })(),
				(async () => { try { const value = await sampleResources(ctx.cwd, controller.signal); if (active) resources = value; } catch { /* conservar última muestra, nunca inventar ceros */ } })(),
			]);
			if (active) {
				const snapshot = git;
				if (preparationsRepo !== snapshot?.commonDir) { preparations = new Map(); preparationsError = undefined; preparationsRepo = snapshot?.commonDir; legacyScanned = false; legacyPreparations = new Map(); }
				if (snapshot) {
					try {
						const sessionFile = ctx.sessionManager.getSessionFile?.();
						if (!sessionRemembered && issueTriage && sessionFile && ctx.isProjectTrusted()) {
							try { issueSessionTask = rememberIssueSession(snapshot, issueTriage, sessionFile, controller.signal); await issueSessionTask; }
							catch (error) { if (active) ctx.ui.notify(text(error instanceof Error ? error.message : "No se pudo vincular la sesión del issue activo"), "warning"); }
							finally { issueSessionTask = undefined; sessionRemembered = true; }
						}
						const saved = await loadIssuePreparations(snapshot);
						if (!legacyScanned && ctx.isProjectTrusted()) {
							legacyPreparations = await discoverLegacyPreparations(snapshot, saved, parsed.sessionDir, controller.signal); legacyScanned = true;
						}
						for (const [number, entry] of legacyPreparations) if (!saved.has(number)) saved.set(number, entry);
						if (active) { preparations = saved; preparationsError = undefined; }
					} catch { if (active) preparationsError = "Registro local no disponible; no se inicia otro triage hasta poder leerlo."; }
				}
			}
			localBusy = false;
			if (active && previousIdentity !== gitIdentity()) { github.issues = emptyGithubList(); github.prs = emptyGithubList(); actions = { reviews: {}, releases: {} }; branchPr = undefined; branchPrError = undefined; environments = []; services = []; envAt = undefined; envError = undefined; project = undefined; diffRequest++; diffLoading = false; diff = undefined; selectedFile = 0; issuesPane.offset = 0; prsPane.offset = 0; }
			changed();
			if (active && (previousIdentity !== gitIdentity() || Date.now() - lastRemote > 30_000)) void refreshRemote();
		}
		const overlayOptions = (limit = 104) => ({ width: Math.max(1, Math.min(limit, Math.floor((tui?.terminal.columns ?? 80) * .9))), maxHeight: "90%" as const, anchor: "center" as const });
		async function info(title: string, content: ModalEntry[], options: ModalOptions & { confirmLabel?: string } = {}): Promise<boolean> {
			if (!active || finishModal) return false;
			infoPrompt = true;
			try { return await ctx.ui.custom<boolean | undefined>((ui, _currentTheme, _keys, done) => {
				finishModal = () => done(undefined);
				return new OmiInfoModal({ title, content, ...options, theme, rows, redraw: () => ui.requestRender(), done });
			}, { overlay: true, overlayOptions: () => overlayOptions() }) === true; }
			finally { infoPrompt = false; finishModal = undefined; }
		}
		async function showWorkspace(): Promise<void> {
			const linked = git?.linked === true;
			const back = await info("Ubicación de trabajo", [notice(workspaceName(git), "syntaxType"), field("Branch", git ? `${git.detached ? "HEAD separado · " : ""}${git.branch}` : "—", "syntaxType"),
				"", section("Directorios"), field("Directorio activo", ctx.cwd), field("Raíz del checkout", git?.root ?? "—"), field("Repo principal", git?.mainRoot ?? "—"),
				...(git ? ["", section("Estado Git"), field("Archivos modificados", String(git.changeCount)), field("Upstream", git.tracking === false ? "sin configurar" : git.upstream ?? "no disponible"),
					field("Commits", `↑${git.ahead ?? "—"} ↓${git.behind ?? "—"}`), notice("↑ commits locales por subir · ↓ commits del upstream por traer."),
					notice("Comparación con la referencia local del último fetch; no consulta el remoto. Para actualizarla, ejecutá git fetch. Los archivos sin commit se cuentan por separado.")] : []), "",
				notice(git?.linked ? "Este worktree tiene directorio e índice propios. Comparte historia y referencias Git. No es un sandbox: no aísla credenciales, procesos ni servicios." : "No hay un worktree enlazado activo."),
				...(linked ? [notice("Enter vuelve al repo principal y retoma su conversación. Conserva la rama actual de ese checkout y todo el trabajo del issue; no hace git checkout main.", "accent")] : []),
				...(gitError ? [notice("Estado Git desactualizado: no se pudo refrescar.", "warning")] : [])], { color: "syntaxType", subtitle: "Proyecto · checkout y sincronización local", ...(linked ? { confirmLabel: "volver al repo" } : {}) });
			if (back && active) pi.sendUserMessage("/omi-main", { expandPromptTemplates: true });
		}
		async function showBranchPr(): Promise<void> {
			await info("PR de la rama actual", [field("Rama", git ? git.branch : "sin repositorio Git", "syntaxType"), "",
				...(branchPrError ? [notice(branchPrError + (branchPr ? " · enlace desactualizado (*)" : ""), "warning")] : []),
				...(branchPr ? [notice(`PR #${branchPr.number} · ${branchPr.title}`, "mdLink"), "", field("Estado", `${branchPr.state}${branchPr.draft ? " · borrador" : ""}`,
					branchPr.draft ? "warning" : branchPr.state === "MERGED" ? "syntaxType" : branchPr.state === "OPEN" ? "success" : "muted"), "", branchPr.url]
					: [notice(!git ? "Sin repositorio Git." : git.detached ? "HEAD separado: no hay una rama actual." : branchPrError ? "No se pudo consultar el PR." : remoteBusy || !lastRemote ? "Consultando PR…" : "No hay un PR asociado a esta rama.")]),
			], { color: "mdLink", subtitle: "GitHub · pull request del checkout activo" });
		}
		async function openBranchPr(pr: BranchPullRequest): Promise<void> {
			if (!active || blocked || openingBranchPr) return;
			openingBranchPr = true;
			try {
				const result = await pi.exec("gh", ["pr", "view", pr.url, "--web"], { cwd: git?.root ?? ctx.cwd, timeout: 5000, maxBuffer: 8192 });
				if (result.code !== 0) throw new Error("No se pudo abrir el navegador");
			} catch {
				if (active) { ctx.ui.notify("No se pudo abrir el navegador. Podés copiar la URL del PR desde este detalle.", "warning"); await showBranchPr(); }
			} finally { openingBranchPr = false; }
		}
		async function showActions(): Promise<void> {
			await info("GitHub Actions", [notice("Estado de las ejecuciones de Actions; un ✓ no significa aprobación del PR."), "", ...ACTION_GROUPS.flatMap((group): ModalEntry[] => {
				const state = actions[group.id];
				return [section(group.label), ...(state.error ? [notice(state.error + (state.runs ? " · datos desactualizados" : ""), "warning")] : []),
					...(state.runs?.flatMap((run) => [notice(`${run.name} · ${run.status} · ${run.conclusion || "sin conclusión"}`,
						run.status !== "completed" ? "warning" : run.conclusion === "success" ? "success" : ["failure", "timed_out", "startup_failure", "action_required"].includes(run.conclusion) ? "error" : "muted"), notice(run.createdAt), run.url]) ?? [notice("Sin datos")]), ""];
			})], { color: "mdLink", subtitle: "GitHub · Claude reviews y releases" });
		}
		async function showResources(): Promise<void> {
			const r = resources;
			await info("Recursos · equipo donde corre OMI", r ? [field("Host", r.host, "syntaxVariable"), "", section("Equipo"),
				field("CPU total", r.cpu === undefined ? "esperando muestra" : `${r.cpu.toFixed(1)}%`, (r.cpu ?? 0) >= 90 ? "warning" : "syntaxVariable"),
				field("RAM usada", `${gib(r.totalRam - r.availableRam)} / ${gib(r.totalRam)}${r.memoryEstimated ? " (estimada)" : ""}`), field("RAM disponible", gib(r.availableRam)),
				field("Disco del proyecto", r.disk ? `${gib(r.disk.used)} usados / ${gib(r.disk.total)} · ${gib(r.disk.available)} disponibles` : "no disponible"), "", section("Proceso OMI"),
				field("Proceso OMI", `CPU ${r.processCpu?.toFixed(1) ?? "—"}% · RAM ${gib(r.rss)}`, "syntaxVariable"),
				notice("RAM OMI es RSS de este proceso; no suma herramientas ni otros subprocesos."), notice("CPU de OMI normalizada a la capacidad total del equipo."), "",
				notice("Estas métricas son del host de OMI, no de tu Mac si te conectaste por SSH.")] : [notice("Recolectando datos…")], { color: "syntaxVariable", subtitle: "Equipo · métricas del host, no de la infraestructura desplegada" });
		}
		async function showSubagents(args = ""): Promise<void> {
			if (!active) return;
			const tasks = subagents.tasks; const cancel = /^cancel\s+(.+)$/.exec(args.trim());
			if (args.trim() && !cancel) { ctx.ui.notify("Uso: /omi-subagents [cancel <ID de tarea o lote>]", "warning"); return; }
			if (cancel) {
				const task = tasks.find((task) => task.id === cancel[1] || task.id.slice(0, task.id.lastIndexOf("/")) === cancel[1]);
				const id = task?.id.slice(0, task.id.lastIndexOf("/"));
				if (!id || !tasks.some((task) => task.id.slice(0, task.id.lastIndexOf("/")) === id && ["pending", "running"].includes(task.status))) { ctx.ui.notify("Ese lote no tiene subagentes activos o en cola", "warning"); return; }
				if (await info("Cancelar subagentes", [field("Lote", text(id)), notice("Se solicita detener todas las tareas de este lote, incluidas las que están en cola. No revierte cambios ni herramientas ya ejecutadas.", "warning")], { color: "syntaxVariable", confirmLabel: "solicitar cancelación" }) && active) pi.events.emit("omi:subagents:cancel", { id });
				return;
			}
			await info("Subagentes", tasks.length ? tasks.flatMap((task): ModalEntry[] => [section(`${task.agent} · ${task.status}`), field("ID", text(task.id)), field("Tarea", task.title), field("Estado", task.status, task.status === "error" ? "error" : task.status === "done" ? "success" : "accent"), field("Tool actual", task.activity || "—"), field("Tiempo observado", subagentDuration(task)), field("Turnos", String(task.turns)), ""])
				.concat([notice("Cancelar un lote: /omi-subagents cancel <ID de tarea o lote>. No se guardan outputs ni historiales privados.")]) : [notice("Sin subagentes activos")], { color: "syntaxVariable", subtitle: "Delegación · roles, tareas y actividad" });
		}
		async function showContext(): Promise<void> {
			const usage = ctx.getContextUsage();
			await info("Ventana de contexto", [field("Modelo", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "sin modelo", "accent"), "",
				field("Uso", usage?.tokens == null ? "desconocido" : `${tokens(usage.tokens)} tokens (estimado)`), field("Límite", `${tokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)} tokens`),
				field("Ocupación", usage?.percent == null ? "—" : `${usage.percent.toFixed(1)}%`, (usage?.percent ?? 0) >= 90 ? "error" : (usage?.percent ?? 0) >= 80 ? "warning" : "success"), "",
				notice("El runtime usa el último uso informado por el modelo y estima los mensajes posteriores. Después de compactar puede ser desconocido hasta la siguiente respuesta."),
				notice("No inventamos un desglose por sistema, conversación y tools."), "", notice("Para compactar usá /compact. Cambiar el modelo no descarta contenido.", "warning")], { color: "warning", subtitle: "Sesión · uso estimado de la ventana del modelo" });
		}
		async function showModel(query = ""): Promise<void> {
			if (!active || finishModal) return;
			if (!ctx.isIdle()) { ctx.ui.notify("Esperá a que termine el turno antes de cambiar el modelo", "warning"); return; }
			const available = ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			let result: PickerResult | undefined;
			try {
				result = await ctx.ui.custom<PickerResult>((ui, _currentTheme, _keys, done) => {
					finishModal = () => done({ favorites: prefs.favorites });
					return new OmiModelPicker({ models: available, current: ctx.model, thinking: ctx.thinkingLevel ?? "off", favorites: prefs.favorites, initialQuery: query, contextTokens: ctx.getContextUsage()?.tokens ?? null, theme, maxRows: rows, render: () => ui.requestRender(), done });
				}, { overlay: true, overlayOptions: () => overlayOptions(112) });
			} finally { finishModal = undefined; }
			if (!active || !result) return;
			prefs.favorites = result.favorites; await save();
			if (!active) return;
			if (result.choice) {
				const currentTokens = ctx.getContextUsage()?.tokens;
				if (currentTokens != null && currentTokens > result.choice.model.contextWindow) { ctx.ui.notify("El contexto actual supera el límite del modelo. Revisá /compact antes de cambiar.", "warning"); return; }
				if (!ctx.isIdle()) { ctx.ui.notify("El agente está trabajando; no se cambió el modelo", "warning"); return; }
				try { if (await pi.setModel(result.choice.model)) { pi.setThinkingLevel(result.choice.thinking); ctx.ui.notify(`Modelo: ${text(result.choice.model.name)}`, "info"); } else ctx.ui.notify("No hay autenticación para ese proveedor. Usá /login.", "error"); }
				catch { ctx.ui.notify("No se pudo cambiar el modelo. Revisá la selección actual antes de seguir.", "error"); }
			}
			changed();
		}
		function switchView(next: View): void {
			if (!active || blocked || tui?.hasOverlay()) return;
			if ((!layoutCompatible || tui?.mode !== "fullscreen") && next !== "chat") { ctx.ui.notify("Esta vista requiere el layout fullscreen compatible de OMI", "warning"); return; }
			view = next; buildRoot();
			tui?.setFocus(next === "chat" ? editor?.children[0] ?? null : readPanes[next]);
			changed();
		}
		async function toggleSidebar(): Promise<void> { prefs.sidebar = !prefs.sidebar; changed(); await save(); }
		async function palette(): Promise<void> {
			if (!active || finishModal) return;
			const actions: [string, () => void | Promise<void>][] = [...WORKSPACE_VIEWS.map((item): [string, () => void] => [item.label, () => switchView(item.id)]),
				["PR de la rama actual", showBranchPr], ["GitHub Actions", showActions], ["Subagentes", showSubagents], ["Elegir modelo", showModel], ["Ventana de contexto", showContext], ["Ubicación / worktree", showWorkspace], ["Recursos del equipo", showResources], ["Mostrar / ocultar lateral", toggleSidebar], ["Actualizar datos", () => { void refreshLocal(); void refreshRemote(); }],
				["Preparar / retomar el issue seleccionado", () => pi.sendUserMessage("/omi-triage", { expandPromptTemplates: true })]];
			if (git?.linked) actions.splice(WORKSPACE_VIEWS.length, 0, ["Volver al repo principal", () => pi.sendUserMessage("/omi-main", { expandPromptTemplates: true })]);
			let selected: string | undefined;
			try {
				selected = await ctx.ui.custom<string | undefined>((ui, _theme, keys, done) => {
					finishModal = () => done(undefined);
					return new OmiCommandPalette({ items: actions.map(([label]) => ({ value: label, label })), keys, theme, rows, redraw: () => ui.requestRender(), done });
				}, { overlay: true, overlayOptions: () => overlayOptions(76) });
			} finally { finishModal = undefined; }
			if (active) await actions.find(([label]) => label === selected)?.[1]();
		}
		const header = new Lines((width) => {
			const t = theme(); const name = text(basename(git?.root ?? ctx.cwd));
			return [surface(t, align(t.bold(t.fg("accent", " > omi code")) + `  ·  ${name}`, t.fg("dim", width >= 90 ? "Ctrl K comandos  F4 lateral " : "Ctrl K comandos "), width), width, true),
				surface(t, workspaceTabs(width, view).map((tab) => tab.view === view ? t.fg("accent", t.bold(tab.label)) : t.fg("muted", tab.label)).join(""), width, true),
				t.fg("border", "─".repeat(Math.max(0, width)))];
		}, (event) => { if (event.type !== "click") return; if (event.y === 0 && event.x > event.width - 22) { void palette(); return { handled: true }; } if (event.y === 1) { const tab = workspaceTabs(event.width, view).find((item) => event.x >= item.start && event.x < item.end); if (tab) { switchView(tab.view); return { handled: true }; } } return undefined; });
		const sidebarFrame = (width: number) => workspaceSidebar({ theme: theme(), cwd: ctx.cwd, height: Math.max(1, rows() - 6), git, gitError, resources, actions, project, envAt, envError, context: contextState(), issueTriage, subagents }, width);
		const sidebar = new Lines((width) => sidebarFrame(width).lines, (event) => {
			if (event.type !== "click") return;
			const target = sidebarFrame(event.width).targets.get(event.y);
			if (target === "resources") void showResources(); else if (target === "context") void showContext();
			else if (target === "workspace") void showWorkspace(); else if (target === "actions") void showActions();
			else if (target === "subagents") void showSubagents(); else if (target) switchView(target);
			return { handled: true };
		});
		async function openChange(): Promise<void> {
			const snapshot = git; const file = snapshot?.changes[selectedFile]; if (!snapshot || !file) return;
			const request = ++diffRequest; diffLoading = true; changed();
			const current = (): boolean => active && request === diffRequest && git?.root === snapshot.root;
			try {
				if (file.status === "??" && sensitivePreviewPath(file.path)) {
					const approved = await ctx.ui.confirm("Previsualizar archivo sensible", `${text(file.path)} puede contener secretos. ¿Mostrarlo en esta terminal? No se enviará al modelo ni se agregará al chat.`);
					if (!current()) return;
					switchView("changes");
					if (!approved) return;
				}
				const value = await (file.status === "??" ? readUntrackedPreview(snapshot, file, controller.signal) : readFileDiff(snapshot, file, controller.signal));
				if (current()) diff = value;
			} catch { if (current()) diff = "No se pudo abrir el archivo. Puede haberse eliminado o no tener permisos de lectura."; }
			finally { if (request === diffRequest) { diffLoading = false; changesPane.offset = 0; changed(); } }
		}
		const changesPane = new ReadView((width) => {
			const t = theme(); const lines = [t.bold(" Cambios locales"), t.fg("dim", " ↑ ↓ seleccionar · Enter diff / archivo nuevo · Backspace volver · Esc chat"), ""];
			if (diffLoading) lines.push(" Cargando diff…");
			else if (diff !== undefined) lines.push(...diff.split("\n").map((line) => line.startsWith("+") ? t.fg("success", text(line)) : line.startsWith("-") ? t.fg("error", text(line)) : text(line)));
			else if (!git) lines.push(" No hay un repositorio Git disponible.");
			else { if (gitError) lines.push(t.fg("warning", " Datos Git desactualizados")); if (!git.changes.length) lines.push(" No hay cambios locales."); git.changes.forEach((file, index) => lines.push(changedFileLine(t, file, width, index === selectedFile))); if (git.changeCount > git.changes.length) lines.push(` Mostrando ${git.changes.length} de ${git.changeCount} archivos.`); }
			return lines.map((line) => surface(t, line, width));
		}, (data) => {
			if (matchesKey(data, "escape")) { switchView("chat"); return true; }
			if (matchesKey(data, "backspace")) { diffRequest++; diffLoading = false; diff = undefined; changesPane.offset = 0; changed(); return true; }
			if (diff === undefined && !diffLoading) {
				if (matchesKey(data, "up") || matchesKey(data, "down")) { selectedFile = Math.max(0, Math.min((git?.changes.length ?? 1) - 1, selectedFile + (matchesKey(data, "up") ? -1 : 1))); changesPane.offset = Math.max(0, selectedFile - Math.max(1, rows() - 12)); changed(); return true; }
				if (matchesKey(data, "return")) { void openChange(); return true; }
			}
			return false;
		}, changed, () => rows() - 6);
		async function showGithubDetail(kind: GithubView): Promise<void> {
			const item = github[kind].items?.[github[kind].selected]; const snapshot = git;
			if (!item || !snapshot || githubDetailBusy || finishModal || !active || !ctx.isProjectTrusted()) return;
			githubDetailBusy = true; const identity = gitIdentity(); changed();
			const current = () => active && identity === gitIdentity() && view === kind && github[kind].items?.[github[kind].selected]?.number === item.number;
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
				let saved = kind === "issues" ? preparations.get(item.number) : undefined;
				if (kind === "issues") {
					try { const record = await readIssuePreparation(snapshot, item.number); if (record) saved = { record }; }
					catch (error) { saved = { error: error instanceof Error ? error.message : "Registro local no disponible" }; }
					if (saved?.record) {
						try { assertIssueIdentity(saved.record, item); if (saved.record.phase === "ready") await verifyIssuePreparation(snapshot, saved.record, signal); }
						catch (error) { saved = { ...saved, error: error instanceof Error ? error.message : "Preparación no disponible" }; }
					}
					if (!saved && preparationsError) saved = { error: preparationsError };
					if (saved) preparations.set(item.number, saved);
				}
				let body = saved?.record?.source.body ?? ""; let staleBody = false;
				try {
					if (parsed.offline) throw new Error("Offline");
					body = await readGithubDetail(snapshot, kind === "issues" ? "issue" : "pr", item.number, signal);
				} catch (error) { if (!saved) throw error; staleBody = true; }
				const description = body.split("\n"); const record = saved?.record;
				if (!current()) return;
				const start = await info(`${kind === "issues" ? "Issue" : "PR"} #${item.number} · ${text(item.title)}`, [field("Autor", item.author, "accent"), field("Etiquetas GitHub", item.labels.join(", ") || "—", "syntaxType"),
					...(record ? [field("Clasificación local", ISSUE_TYPES[record.state.triage.type].label, "accent"), field("Rama", record.state.branch), field("Worktree", record.state.worktree),
						...(saved?.error ? [] : [notice(record.phase === "ready" ? "Enter retoma la sesión guardada en este worktree. Conserva la conversación y los cambios; no reclasifica." : "Preparación pendiente. Enter continúa lo guardado sin repetir el triage ni sobrescribir trabajo.", "accent")])] : kind === "issues" && !saved?.error ? [notice("Enter inicia el triage y abre una sesión en un worktree nuevo desde main local. No implementa todavía.", "accent")] : []),
					...(saved?.error ? [notice(`Recuperación pendiente: ${saved.error}`, "warning")] : []),
					...(kind === "prs" ? [notice(`${item.draft ? "Borrador" : "Abierto"} · ${item.head} → ${item.base}`, item.draft ? "warning" : "success"), field("Revisión", item.review || "sin decisión")] : []),
					item.url, "", section("Descripción"), ...(staleBody ? [notice(body ? "No se pudo actualizar GitHub; se muestra la descripción local guardada." : "No se pudo cargar la descripción de GitHub. El estado local guardado sigue disponible.", "warning")] : []), ...description.slice(0, 1000), ...(description.length > 1000 ? [notice("[Descripción recortada a 1000 líneas]", "warning")] : [])],
					{ color: kind === "issues" ? "syntaxType" : "mdLink", subtitle: `GitHub · ${kind === "issues" ? "issue · preparar o retomar" : "pull request · sólo lectura"}`, ...(kind === "issues" && !saved?.error ? { confirmLabel: record ? "retomar worktree" : "iniciar triage" } : {}) });
				// Siempre detalle primero. Sólo su segundo Enter despacha una acción de sesión.
				if (start && kind === "issues" && current()) pi.sendUserMessage(`/omi-triage ${item.number}`, { expandPromptTemplates: true });
			} catch { if (current()) await info("GitHub · detalle no disponible", [notice("Revisá gh, autenticación o red. El detalle también puede ser demasiado grande.", "warning")], { color: "warning", subtitle: "GitHub · no se pudo cargar el detalle" }); }
			finally { githubDetailBusy = false; changed(); }
		}
		function githubPane(kind: GithubView): ReadView {
			const pane = new ReadView((width) => {
				const t = theme(); const state = github[kind]; const name = kind === "issues" ? "Issues" : "PRs";
				state.selected = Math.max(0, Math.min(state.selected, (state.items?.length ?? 1) - 1));
				const lines = [t.bold(` ${name} abiertos`), t.fg("dim", " ↑ ↓ seleccionar · Enter detalle · r actualizar · Esc chat"), t.fg("dim", ` Todo el repositorio · ${age(state.at)}`), ""];
				if (state.error) lines.push(t.fg("warning", ` ${state.error}${state.items ? " · datos desactualizados" : ""}`));
				if (kind === "issues" && preparationsError) lines.push(t.fg("warning", ` ${preparationsError}`));
				if (!git) lines.push(" No hay un repositorio Git disponible.");
				else if (!state.items && !state.error) lines.push(remoteBusy ? " Consultando GitHub…" : " Sin datos. Pulsá r para actualizar.");
				else if (state.items?.length === 0) lines.push(` No hay ${name.toLowerCase()} abiertos en la última consulta.`);
				for (const [index, item] of (state.items ?? []).entries()) {
					const saved = kind === "issues" ? preparations.get(item.number) : undefined;
					const badges = kind === "prs" ? "" : saved?.record ? ` [${ISSUE_TYPES[saved.record.state.triage.type].label}] [${saved.error ? "Revisar" : saved.record.phase === "ready" ? basename(saved.record.state.worktree) : "Pendiente"}]` : saved?.error || preparationsError ? " [Registro no disponible]" : " [Sin triage]";
					const line = align(` ${index === state.selected ? "›" : " "} #${item.number}${item.draft ? " [borrador]" : ""}${badges} ${text(item.title)}`, text(`@${item.author}`), width);
					lines.push(index === state.selected ? t.fg("accent", line) : line);
				}
				if (state.items?.length === 100) lines.push(t.fg("dim", " Mostrando hasta 100 resultados abiertos."));
				if (githubDetailBusy) lines.push(t.fg("muted", " Cargando detalle…"));
				return lines.map((line) => surface(t, line, width));
			}, (data) => {
				if (matchesKey(data, "escape")) { switchView("chat"); return true; }
				if (data === "r") { if (kind === "issues") { legacyScanned = false; void refreshLocal(); } void refreshRemote(); return true; }
				if (matchesKey(data, "return")) { void showGithubDetail(kind); return true; }
				const state = github[kind]; const page = Math.max(1, rows() - 11);
				const move = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : matchesKey(data, "pageUp") ? -page : matchesKey(data, "pageDown") ? page : 0;
				if (move || matchesKey(data, "home") || matchesKey(data, "end")) {
					state.selected = Math.max(0, Math.min((state.items?.length ?? 1) - 1, matchesKey(data, "home") ? 0 : matchesKey(data, "end") ? (state.items?.length ?? 1) - 1 : state.selected + move));
					pane.offset = Math.max(0, state.selected - page + 1); changed(); return true;
				}
				return false;
			}, changed, () => rows() - 6);
			return pane;
		}
		const issuesPane = githubPane("issues"); const prsPane = githubPane("prs");
		async function returnToPrincipal(_args: string, command: ExtensionCommandContext): Promise<void> {
			if (!active || command.mode !== "tui" || mainBusy || triageBusy || blocked || finishModal) return;
			const warn = (message: string) => command.ui.notify(message, "warning");
			if (!command.isProjectTrusted()) { warn("Volver al repo principal requiere un proyecto de confianza."); return; }
			if (!command.isIdle() || command.hasPendingMessages()) { warn("Esperá a que el agente termine antes de volver al repo principal."); return; }
			if (parsed.noSession) { warn("Volver al repo principal requiere una sesión persistente. Volvé a abrir OMI sin --no-session."); return; }
			mainBusy = true;
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
			const current = () => active && !signal.aborted && ctx.cwd === command.cwd && command.isIdle() && !command.hasPendingMessages();
			try {
				const snapshot = await readGit(command.cwd, signal);
				if (!current()) return;
				if (!snapshot) { warn("No hay un repositorio Git disponible para volver al principal."); return; }
				if (!snapshot.linked) { switchView("chat"); command.ui.notify("Ya estás en el repo principal. No se creó ni se cambió ninguna sesión o rama.", "info"); return; }
				const preparing = preparePrincipalSession(snapshot, command, { signal, isCurrent: current, ...(parsed.sessionDir ? { sessionDir: parsed.sessionDir } : {}) });
				mainSessionTask = preparing; const destination = await preparing; mainSessionTask = undefined;
				if (!current()) return;
				const message = `Repo principal · ${destination.detached ? "HEAD separado · " : ""}${destination.branch}. ${destination.created ? "Sesión nueva, sin heredar el contexto del issue." : "Conversación retomada."} El worktree y sus cambios quedaron intactos.`;
				const result = await command.switchSession(destination.sessionFile, { withSession: async (replacement) => { replacement.ui.notify(message, "info"); } });
				if (result.cancelled) warn("Regreso cancelado. Seguís en el worktree; la sesión del repo principal quedó disponible para reintentar.");
			} catch (error) {
				if (active && !controller.signal.aborted) command.ui.notify(text(error instanceof Error ? error.message : "No se pudo volver al repo principal"), error instanceof PrincipalSessionBusyError ? "warning" : "error");
			} finally { mainSessionTask = undefined; mainBusy = false; changed(); }
		}
		pi.registerCommand("omi-main", { description: "Volver del worktree al repo principal y retomar su sesión, sin cambiar ramas", handler: returnToPrincipal });
		async function startIssueTriage(args: string, command: ExtensionCommandContext): Promise<void> {
			if (!active || command.mode !== "tui" || triageBusy || mainBusy || blocked || finishModal) return;
			const warn = (message: string) => command.ui.notify(message, "warning");
			if (!command.isProjectTrusted()) { warn("El triage y retomar un worktree requieren un proyecto de confianza."); return; }
			if (!command.isIdle() || command.hasPendingMessages()) { warn("Esperá a que el agente termine antes de preparar o retomar un issue."); return; }
			if (parsed.noSession) { warn("El worktree requiere una sesión persistente. Volvé a abrir OMI sin --no-session."); return; }
			const number = args.trim() ? /^[1-9]\d*$/.test(args.trim()) ? Number(args.trim()) : NaN : github.issues.items?.[github.issues.selected]?.number ?? NaN;
			const item = github.issues.items?.find((item) => item.number === number); const snapshot = git;
			if (!snapshot || !Number.isSafeInteger(number) || number <= 0) { warn("Abrí Issues y seleccioná un issue cargado. Uso: /omi-triage [número]."); return; }
			triageBusy = true; const identity = gitIdentity(); const abort = new AbortController();
			const current = () => active && identity === gitIdentity() && command.isIdle() && !command.hasPendingMessages();
			try {
				const preparing = prepareIssue(snapshot, number, item, command, {
					...(parsed.sessionDir ? { sessionDir: parsed.sessionDir } : {}), signal: controller.signal, isCurrent: current,
					classify: async () => {
						if (parsed.offline) { warn("Un triage nuevo requiere conexión; quitá --offline. Los ya guardados se pueden retomar."); return; }
						if (!command.model || !command.modelRegistry.hasConfiguredAuth(command.model)) { warn("Elegí un modelo autenticado con /omi-model o /login antes de iniciar el triage."); return; }
						if (!item) return;
						let failure: unknown; infoPrompt = true;
						const classification = await command.ui.custom<IssueClassification | undefined>((ui, modalTheme, _keys, done) => {
							const loader = new BorderedLoader(ui, modalTheme, `Issue triage · #${number} · Esc cancelar`);
							let finished = false;
							const finish = (value?: IssueClassification) => { if (!finished) { finished = true; done(value); } };
							finishModal = () => { abort.abort(); finish(); }; loader.onAbort = finishModal;
							const signal = AbortSignal.any([controller.signal, abort.signal, AbortSignal.timeout(90_000)]);
							void (async () => {
								const body = await readGithubDetail(snapshot, "issue", item.number, signal);
								return { ...await classifyIssue(command, item, body, signal), body };
							})().then(finish, (error) => { failure = error; finish(); });
							return loader;
						}, { overlay: true, overlayOptions: () => overlayOptions() });
						infoPrompt = false; finishModal = undefined;
						if (!current() || abort.signal.aborted) return;
						if (failure) throw failure;
						return classification;
					},
				});
				issuePreparationTask = preparing;
				const prepared = await preparing; issuePreparationTask = undefined;
				if (!prepared || !current()) return;
				const { record, resumed } = prepared; const { state, sessionFile } = record;
				preparations.set(number, { record }); changed();
				const activeSession = command.sessionManager.getSessionFile();
				if (activeSession && resolve(activeSession) === resolve(sessionFile!) && resolve(command.cwd) === resolve(state.worktree)) {
					switchView("chat"); command.ui.notify(`Ya estás en la sesión del issue #${number}. No se creó ni se cambió nada.`, "info"); return;
				}
				const message = resumed ? `Issue #${number} · ${ISSUE_TYPES[state.triage.type].label}. Sesión retomada; conversación y cambios conservados.` : `Issue #${number} · ${ISSUE_TYPES[state.triage.type].label}. Worktree listo; implementación no iniciada.`;
				const result = await command.switchSession(sessionFile!, { withSession: async (replacement) => { replacement.ui.notify(message, "info"); } });
				if (result.cancelled) warn(`Cambio de sesión cancelado. La preparación quedó guardada en ${state.worktree}. Volvé al detalle y elegí retomar worktree.`);
			} catch (error) {
				if (active && !controller.signal.aborted) command.ui.notify(text(error instanceof Error ? error.message : "No se pudo preparar o retomar el issue"), error instanceof IssuePreparationBusyError ? "warning" : "error");
			} finally { abort.abort(); issuePreparationTask = undefined; triageBusy = false; infoPrompt = false; finishModal = undefined; changed(); }
		}
		pi.registerCommand("omi-triage", { description: "Preparar o retomar el triage, worktree y sesión del issue", handler: startIssueTriage });
		const omiPane = new ReadView((width) => {
			const t = theme(); const lines = [t.bold(" OMI"), t.fg("dim", " r actualizar · Esc chat · infraestructura del proyecto"), "", t.fg("accent", ` PROYECTO OMI · ${age(envAt)}`)];
			if (envError) lines.push(t.fg("warning", ` ${envError}${project ? " · datos desactualizados" : ""}`));
			if (project) {
				lines.push(` ${text(project)}`, "", t.fg("accent", " SERVICIOS Y AMBIENTES"));
				for (const service of services) {
					lines.push(t.bold(` ${text(service)}`));
					const serviceEnvironments = environments.filter((environment) => environment.service === service);
					for (const environment of serviceEnvironments) lines.push(text(`   ${environment.name} · ${environment.version ?? "sin versión"} · ${environment.state}`));
					if (!serviceEnvironments.length) lines.push(t.fg("muted", "   Sin ambientes informados."));
				}
			} else if (!envError) lines.push(envAt ? " Sin proyecto OMI vinculado. Usá omi init para vincularlo." : " Consultando vínculo y ambientes OMI…");
			lines.push("", t.fg("accent", " OPERACIONES OMI"), " Estado, variables, recursos, jobs, versiones, logs y deploys:", " pedilos en Chat. Se conservan las herramientas y confirmaciones.", "", t.fg("dim", " Vista de sólo lectura. Un estado running no es un health check."));
			return lines.map((line) => surface(t, line, width));
		}, (data) => {
			if (matchesKey(data, "escape")) { switchView("chat"); return true; }
			if (data === "r") { void refreshRemote(); return true; }
			return false;
		}, changed, () => rows() - 6);
		const readPanes = { issues: issuesPane, prs: prsPane, changes: changesPane, omi: omiPane };

		const welcome = new Lines((width) => {
			if (working || ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return [];
			const t = theme(); const name = text(basename(git?.root ?? ctx.cwd));
			const identity = git ? `${text(git.branch)} · ${text(workspaceName(git))} · ${git.changeCount} cambios locales` : text(ctx.cwd);
			const description = wrapTextWithAnsi("La conversación aparece acá. Podés empezar escribiendo o abrir los comandos.", Math.max(1, width - 4));
			welcomeCommandStart = 7 + description.length;
			const lines = ["", t.fg("accent", t.bold("omi code")), "", `¿Qué hacemos en ${name}?`, "", t.fg("muted", identity), ...description.map((line) => t.fg("muted", line)), "", t.fg("muted", "Ctrl K   Comandos"), t.fg("muted", `${modelShortcut}   Elegir modelo`), t.fg("muted", "Ctrl 4   Revisar cambios"), ""];
			return lines.map((line) => fit(`  ${line}`, width));
		}, (event) => { if (event.type !== "click") return; if (event.y === welcomeCommandStart) void palette(); else if (event.y === welcomeCommandStart + 1) void showModel(); else if (event.y === welcomeCommandStart + 2) switchView("changes"); else return; return { handled: true }; });
		function buildRoot(): void {
			if (!tui || !document || !editor || !footer) return;
			if (!projectRoot) {
				const dock = new VStack([pending, status, above, { component: editor, shrink: 1, minSize: 3 }, below]);
				const content = new PaintedDocument(workspaceDocument, theme, (width) => Math.max(0, rows() - 6 - dock.render(width).length));
				const transcript = new ScrollView(content, { follow: "end", primary: true, scrollbar: "auto" });
				projectRoot = new VStack([{ component: transcript, basis: 0, grow: 1, minSize: 1 }, { component: dock, basis: "auto", shrink: 1, minSize: 3 }]);
				baseRoot = new VStack([{ component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 }, dock, footer]);
			}
			root = new VStack([{ component: header, basis: 3, shrink: 0 }, { component: new HStack([{ component: view === "chat" ? projectRoot : readPanes[view], basis: 0, grow: 1, minSize: 20 }, { component: sidebar, basis: 33, shrink: 0, visible: (viewport) => sidebarVisible(viewport.width, viewport.height) }]), basis: 0, grow: 1, minSize: 1 }, { component: footer, basis: "auto", shrink: 0 }]);
			ensureRoot();
		}
		function ensureRoot(): void { if (active && tui && root && isViewportTUI(tui)) tui.setLayoutRoot(root); }

		class OmiEditor extends CustomEditor {
			private omiKeys: KeybindingsManager;
			constructor(ui: TUI, editorTheme: ConstructorParameters<typeof CustomEditor>[1], keys: KeybindingsManager) {
				super(ui, editorTheme, keys); this.omiKeys = keys;
				modelShortcut = (keys.getKeys("app.model.select")[0] ?? "/omi-model").replace(/\+/g, " ").replace(/\bctrl\b/g, "Ctrl").replace(/\bl\b/g, "L");
			}
			protected override renderBottomBorder(width: number, hiddenLineCount: number): string { return hiddenLineCount ? super.renderBottomBorder(width, hiddenLineCount) : " ".repeat(width); }
			override render(width: number): string[] {
				return [...super.render(width), theme().fg("muted", " Enter enviar · /omi comandos")].map((line) => surface(theme(), line, width));
			}
			override handleInput(data: string): void {
				if (this.omiKeys.matches(data, "app.model.select")) { void showModel(); return; }
				const value = this.getText().trim();
				if (this.omiKeys.matches(data, "tui.input.submit") && /^\/model(?:\s|$)/.test(value)) { this.setText(""); void showModel(value.slice(6).trim()); return; }
				super.handleInput(data);
			}
		}
		const commands: [string, string, () => void | Promise<void>][] = [
			["omi", "Paleta de comandos de OMI", palette], ["omi-model", "Selector propio de modelo", showModel],
			["omi-workspace", "Ubicación y worktree", showWorkspace], ["omi-resources", "CPU, RAM y disco del host", showResources],
			["omi-actions", "Claude reviews y releases de GitHub Actions", showActions],
			["omi-pr", "Enlace al PR de la rama actual", showBranchPr],
			["omi-context", "Ventana de contexto", showContext], ["omi-sidebar", "Mostrar / ocultar lateral", toggleSidebar],
			...WORKSPACE_VIEWS.map((item): [string, string, () => void] => [item.command, `Vista ${item.label}`, () => switchView(item.id)]),
		];
		for (const [name, description, handler] of commands) pi.registerCommand(name, { description, handler: async () => { if (active) await handler(); } });
		pi.registerCommand("omi-subagents", { description: "Detalle de subagentes y cancelación por ID de lote", handler: async (args) => { if (active) await showSubagents(args); } });

		pi.on("session_start", async (_event, context) => {
			if (context.mode !== "tui") return;
			ctx = context; prefs = await loadWorkspacePreferences(io.homeDir); active = true;
			unsubscribeSubagents?.(); subagents.clear();
			unsubscribeSubagents = pi.events.on("omi:subagents", (event) => { if (active && consumeSubagentEvent(subagents, event)) changed(); });
			issueTriage = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd);
			if (!parsed.useTheme && !pi.getSettings().theme) {
				const base = ctx.ui.getTheme("dark");
				if (base) { const colors = Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<keyof typeof base.colors, string>;
					Object.assign(colors, { accent: "#97d6ba", success: "#97d6ba", text: "#dce1e3", muted: "#a2acb3", dim: "#78858f", border: "#292f34", userMessageBg: "#182b23", userMessageText: "#edf5f0", toolPendingBg: "#0b0e10", toolSuccessBg: "#0b0e10", toolErrorBg: "#201415", selectedBg: "#24382e" });
					ctx.ui.setTheme(new PiTheme(colors, colors, base.getColorMode(), { name: "omi-black", appearance: "dark" })); }
			}
			ctx.ui.setHeader(() => new Lines((width) => tui?.mode === "fullscreen" && layoutCompatible ? [] : header.render(width)));
			ctx.ui.setFooter((ui, _theme, footerData) => {
				tui = ui;
				let pressedPr: BranchPullRequest | undefined;
				const statusAt = (width: number) => {
					const t = theme(); const context = contextState(); const side = sidebarVisible(width);
					const state = blocked ? "Esperando decisión" : working ? activity : "Listo";
					const left = ` ${t.fg(blocked ? "warning" : "success", "●")} ${text(state)} · ${text(workspaceName(git))}${git ? ` · ${text(git.branch)}` : ""}`;
					const extra = text([...footerData.getExtensionStatuses().values()].join(" · "));
					const hint = side ? extra || "Ctrl 1–5 vistas · /omi" : `Contexto ${context.label}${context.percent === undefined ? "" : ` · ${context.percent.toFixed(0)}%`}`;
					return footerStatus(t, left, hint, width, branchPr, branchPrError !== undefined);
				};
				return new Lines((width) => {
					const t = theme(); const statusLine = statusAt(width).line;
					const name = ctx.model ? text(ctx.model.name) : "Sin modelo";
					const modelName = fit(name, Math.min(name.length, Math.max(0, width - 9)));
					const details = !ctx.model ? " · /login" : width >= 110 ? `  ·  ${text(ctx.model.provider)}  ·  Razonamiento: ${ctx.thinkingLevel ?? "off"}  ·  ${modelShortcut} cambiar` : width >= 70 ? `  ·  ${text(ctx.model.provider)}  ·  ${ctx.thinkingLevel ?? "off"}  ·  ${modelShortcut} cambiar` : ` · ${modelShortcut}`;
					return [t.fg("border", "─".repeat(width)), surface(t, statusLine, width, true), surface(t, t.fg("muted", " Modelo: ") + t.fg("accent", t.bold(modelName)) + t.fg("muted", details), width, true)];
				}, (event) => {
					if (event.button === "right" || event.button === "middle") return;
					// Calcular con el ancho del evento: una medición de layout no debe alterar los hit targets.
					const status = statusAt(event.width);
					const onPr = event.y === 1 && status.prStart !== undefined && event.x >= status.prStart && event.x < (status.prEnd ?? 0);
					if (event.type === "press") {
						pressedPr = onPr ? branchPr : undefined;
						// El clic completo pertenece al botón, no al fallback OSC 8 best-effort del renderer.
						return pressedPr ? { handled: true, render: false } : undefined;
					}
					if (event.type === "drag") { if (pressedPr) { pressedPr = undefined; return { handled: true, render: false }; } return; }
					if (event.type !== "click") return;
					const targetPr = pressedPr ?? (onPr ? branchPr : undefined); pressedPr = undefined;
					if (targetPr) { if (targetPr.url === branchPr?.url) void openBranchPr(targetPr); }
					else if (event.y === 2) void showModel();
					else if (event.y === 1 && event.x >= status.hintStart) { if (sidebarVisible(event.width)) void palette(); else void showContext(); }
					else if (event.y === 1 && event.x < status.workspaceEnd) void showWorkspace();
					return { handled: true };
				});
			});
			// Adaptador acotado a Pi 1.5.0: sus siete componentes públicos montados, sin tocar node_modules.
			// Si cambia ese contrato, conservar la TUI base en lugar de apropiarse de un árbol desconocido.
			const children = tui?.children;
			if (VERSION === "1.5.0" && children?.length === 7 && Array.isArray((children[4] as Container)?.children) && (children[0] as Container)?.children?.length === 3) {
				layoutCompatible = true;
				[document, pending, status, above, editor, below, footer] = children as [Component, Component, Component, Component, Container, Component, Component];
				// Pi 1.5.0: header, recursos y chat. Quitar sólo el header vacío con sus
				// márgenes; conservar recursos externos, diagnósticos y el chat intactos.
				const [, loadedResources, chat] = (document as Container).children;
				workspaceDocument = new Container();
				(workspaceDocument as Container).addChild(welcome);
				(workspaceDocument as Container).addChild(loadedResources!);
				(workspaceDocument as Container).addChild(chat!);
				buildRoot();
			} else ctx.ui.notify("Layout de Pi no compatible: se conserva la vista base de OMI", "warning");
			if (!ctx.ui.getEditorComponent()) ctx.ui.setEditorComponent((ui, editorTheme, keys) => new OmiEditor(ui, editorTheme, keys));
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				if (!active || blocked || tui?.hasOverlay()) return;
				const next = WORKSPACE_VIEWS.find((item) => matchesKey(data, item.key));
				if (next) { switchView(next.id); return { consume: true }; }
				if (matchesKey(data, "ctrl+k")) { void palette(); return { consume: true }; }
				if (matchesKey(data, "f4")) { void toggleSidebar(); return { consume: true }; }
				if (view !== "chat" && (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d"))) { switchView("chat"); editor?.children[0]?.handleInput?.(data); return { consume: true }; }
				return undefined;
			});
			working = !ctx.isIdle();
			timer = setInterval(() => { void refreshLocal(); }, 3000); timer.unref(); void refreshLocal(); changed();
		});
		pi.on("session_shutdown", async () => { active = false; unsubscribeSubagents?.(); unsubscribeSubagents = undefined; subagents.clear(); controller.abort(); if (timer) clearInterval(timer); unsubscribeInput?.(); finishModal?.(); finishModal = undefined; if (tui && baseRoot && isViewportTUI(tui)) tui.setLayoutRoot(baseRoot); await Promise.all([saveQueue, issuePreparationTask?.catch(() => {}), issueSessionTask?.catch(() => {}), mainSessionTask?.catch(() => {})]); });
		pi.on("before_agent_start", (_event, context) => { ctx = context; working = true; activity = "Preparando turno"; changed(); });
		pi.on("agent_start", (_event, context) => { ctx = context; working = true; activity = "Trabajando"; changed(); });
		pi.on("agent_settled", (_event, context) => { ctx = context; working = false; runningTools.clear(); activity = "Listo"; void refreshLocal(); changed(); });
		pi.on("tool_execution_start", (event) => { runningTools.set(event.toolCallId, event.toolName); activity = `Ejecutando ${text(event.toolName)}${runningTools.size > 1 ? ` +${runningTools.size - 1}` : ""}`; changed(); });
		pi.on("tool_execution_end", (event) => { runningTools.delete(event.toolCallId); activity = runningTools.size ? `Ejecutando ${text([...runningTools.values()][0]!)}` : "Trabajando"; changed(); });
		pi.on("ui_prompt_start", () => { if (!active) return; blocked = true; if (!infoPrompt) { view = "chat"; buildRoot(); } changed(); });
		pi.on("ui_prompt_end", () => { blocked = false; changed(); });
		const update = (_event: unknown, context: ExtensionContext): void => { ctx = context; changed(); };
		pi.on("message_end", update); pi.on("session_compact", update); pi.on("session_compact_failed", update);
		pi.on("model_select", update); pi.on("thinking_level_select", update);
		pi.on("session_tree", (_event, context) => { subagents.clear(); issueTriage = restoreIssueTriage(context.sessionManager.getBranch(), context.cwd); update(_event, context); });
	} };
}
