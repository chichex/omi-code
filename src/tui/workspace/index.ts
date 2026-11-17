// Shell propio de OMI sobre los componentes y el renderer de Pi. No hay un segundo TUI.
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, Container, isViewportTUI, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Io } from "../../cli/io.ts";
import { loadWorkspacePreferences, saveWorkspacePreferences, type WorkspacePreferences } from "./preferences.ts";
export { loadWorkspacePreferences, saveWorkspacePreferences, type WorkspacePreferences } from "./preferences.ts";
import { OmiSidebarSettings } from "./sidebar-settings.ts";
import { sessionStats } from "./session-stats.ts";
import { readEnvironments, readFileDiff, readGit, readGithub, readGithubDetail, readUntrackedPreview, resourceReader, sensitivePreviewPath, type EnvironmentStatus, type GitSnapshot, type GithubItem, type Resources } from "./data.ts";
import { OmiModelPicker, type PickerResult } from "./model-picker.ts";
import { text, tokens } from "./presentation.ts";
import { field, notice, OmiCommandPalette, OmiInfoModal } from "./modals.ts";
import { CompactTranscript, Lines, ReadView } from "./components.ts";
import { transcriptRoots, workspaceEditor, workspaceFooter, workspaceHeader, workspaceRoot, workspaceWelcome } from "./chrome.ts";
import { actionsDetail, branchPrDetail, contextDetail, resourcesDetail, subagentsDetail, workspaceDetail, type InfoDetail } from "./details.ts";
import { changesViewLines, githubViewLines, omiViewLines, type GithubView } from "./read-views.ts";
import { WORKSPACE_VIEWS, type WorkspaceView } from "./navigation.ts";
import { ACTION_GROUPS, readActionRuns, type ActionGroup, type ActionState } from "./github-actions.ts";
import { workspaceSidebar } from "./sidebar.ts";
import { WorkflowProgressMonitor, workflowProgressDetail } from "./workflow-progress.ts";
import { GithubInspector } from "./github-inspector.ts";
import { consumeSubagentEvent, SubagentMonitor } from "./subagents.ts";
import { readBranchPullRequest, type BranchPullRequest } from "./pull-request.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import { classifyIssue, restoreIssueTriage, type IssueTriageState } from "./issue-triage.ts";
import { discoverLegacyPreparations, IssuePreparationBusyError, loadIssuePreparations, rememberIssueSession, type IssuePreparationEntry } from "./issue-registry.ts";
import { prepareIssue, type IssueClassification } from "./issue-preparation.ts";
import { preparePrincipalSession, PrincipalSessionBusyError } from "./main-workspace.ts";

type View = WorkspaceView;
interface GithubList { items: GithubItem[] | undefined; error: string | undefined; at: number | undefined; selected: number }
const emptyGithubList = (): GithubList => ({ items: undefined, error: undefined, at: undefined, selected: 0 });
export function workspaceExtension(io: Io, args: string[]): InlineExtension {
	return { name: "omi-workspace", factory: async (pi: ExtensionAPI) => {
		if (io.env.OMI_TUI === "classic") return;
		// El import de coding-agent sucede después de fijar PI_CODING_AGENT_DIR en launchTui.
		const { BorderedLoader, CustomEditor, Theme: PiTheme, ToolExecutionComponent, VERSION, parseArgs } = await import("@earendil-works/pi-coding-agent");
		const parsed = parseArgs(args);
		let active = false; let ctx: ExtensionContext; let tui: TUI | undefined;
		let prefs: WorkspacePreferences = { favorites: [], sidebar: true }; let session = sessionStats([]);
		let view: View = "chat"; let working = false; let blocked = false; let activity = "Listo";
		const runningTools = new Map<string, string>();
		const subagents = new SubagentMonitor(); let unsubscribeSubagents: (() => void) | undefined;
		const workflow = new WorkflowProgressMonitor(); let unsubscribeWorkflow: (() => void) | undefined;
		let git: GitSnapshot | undefined; let gitError = false; let resources: Resources | undefined;
		const github: Record<GithubView, GithubList> = { issues: emptyGithubList(), prs: emptyGithubList() };
		let actions: Record<ActionGroup, ActionState> = { reviews: {}, releases: {} };
		let branchPr: BranchPullRequest | undefined; let branchPrError: string | undefined;
		let openingBranchPr = false;
		let infoPrompt = false; let triageBusy = false; let mainBusy = false;
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
		let unsubscribeInput: (() => void) | undefined; let finishModal: (() => void) | undefined;
		const controller = new AbortController(); const sampleResources = resourceReader();
		const theme = (): Theme => ctx.ui.theme;
		// Sólo presentación: el mensaje original sigue intacto en el historial y en el contexto del modelo.
		pi.registerMarkdownTransformer((markdown, context) => active && context.messageType === "user" && markdown.trim()
			? `**${theme().fg("accent", "▌ Vos")}**\n\n${markdown}` : markdown);
		const rows = (): number => tui?.terminal.rows || 24;
		const sidebarVisible = (width = tui?.terminal.columns ?? 80, height = rows()): boolean => layoutCompatible && tui?.mode === "fullscreen" && prefs.sidebar && width >= 110 && height >= 26;
		const contextInSidebar = (width: number) => sidebarVisible(width) && !prefs.hiddenSections?.includes("session");
		const contextState = () => {
			const usage = ctx.getContextUsage();
			const limit = usage?.contextWindow ?? ctx.model?.contextWindow;
			return { percent: usage?.percent ?? undefined, label: limit === undefined ? "sin modelo" : `${usage?.tokens == null ? "—" : tokens(usage.tokens)} / ${tokens(limit)}`, limit };
		};
		const changed = (): void => { if (active) { ensureRoot(); tui?.requestRender(); } };
		let saveQueue = Promise.resolve();
		const save = (): Promise<void> => { const snapshot = { ...prefs, favorites: [...prefs.favorites], ...(prefs.hiddenSections ? { hiddenSections: [...prefs.hiddenSections] } : {}) }; saveQueue = saveQueue.then(() => saveWorkspacePreferences(io.homeDir, snapshot)).catch(() => { if (active) ctx.ui.notify("No se pudieron guardar las preferencias de la UI", "warning"); }); return saveQueue; };
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
		async function info({ title, content, options = {} }: InfoDetail): Promise<boolean> {
			if (!active || finishModal) return false;
			infoPrompt = true;
			try { return await ctx.ui.custom<boolean | undefined>((ui, _currentTheme, _keys, done) => {
				finishModal = () => done(undefined);
				return new OmiInfoModal({ title, content, ...options, theme, rows, redraw: () => ui.requestRender(), done });
			}, { overlay: true, overlayOptions: () => overlayOptions() }) === true; }
			finally { infoPrompt = false; finishModal = undefined; }
		}
		async function showWorkspace(): Promise<void> {
			const back = await info(workspaceDetail({ cwd: ctx.cwd, git, gitError }));
			if (back && active) pi.sendUserMessage("/omi-main", { expandPromptTemplates: true });
		}
		async function showBranchPr(): Promise<void> { await info(branchPrDetail({ git, pr: branchPr, error: branchPrError, loading: remoteBusy || !lastRemote })); }
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
		async function showActions(): Promise<void> { await info(actionsDetail(actions)); }
		async function showProgress(): Promise<void> { await info({ title: "Progreso de desarrollo", content: workflowProgressDetail(gitError ? undefined : workflow.current(ctx.cwd, git)), options: { color: "accent", subtitle: "Desarrollo · estado observado hasta PR draft" } }); }
		async function showResources(): Promise<void> { await info(resourcesDetail(resources)); }
		async function showSubagents(args = ""): Promise<void> {
			if (!active) return;
			const tasks = subagents.tasks; const cancel = /^cancel\s+(.+)$/.exec(args.trim());
			if (args.trim() && !cancel) { ctx.ui.notify("Uso: /omi-subagents [cancel <ID de tarea o lote>]", "warning"); return; }
			if (cancel) {
				const task = tasks.find((task) => task.id === cancel[1] || task.id.slice(0, task.id.lastIndexOf("/")) === cancel[1]);
				const id = task?.id.slice(0, task.id.lastIndexOf("/"));
				if (!id || !tasks.some((task) => task.id.slice(0, task.id.lastIndexOf("/")) === id && ["pending", "running"].includes(task.status))) { ctx.ui.notify("Ese lote no tiene subagentes activos o en cola", "warning"); return; }
				if (await info({ title: "Cancelar subagentes", content: [field("Lote", text(id)), notice("Se solicita detener todas las tareas de este lote, incluidas las que están en cola. No revierte cambios ni herramientas ya ejecutadas.", "warning")], options: { color: "syntaxVariable", confirmLabel: "solicitar cancelación" } }) && active) pi.events.emit("omi:subagents:cancel", { id });
				return;
			}
			await info(subagentsDetail(tasks, Date.now()));
		}
		async function showContext(): Promise<void> { await info(contextDetail(ctx.model, ctx.getContextUsage())); }
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
		async function customizeSidebar(): Promise<void> {
			if (!active || finishModal) return;
			infoPrompt = true;
			try {
				const hidden = await ctx.ui.custom<NonNullable<WorkspacePreferences["hiddenSections"]> | undefined>((ui, _theme, _keys, done) => {
					finishModal = () => done(undefined);
					return new OmiSidebarSettings({ hiddenSections: prefs.hiddenSections ?? [], theme, rows, redraw: () => ui.requestRender(), done });
				}, { overlay: true, overlayOptions: () => overlayOptions(76) });
				if (active && hidden) { prefs.hiddenSections = hidden; changed(); await save(); }
			} finally { finishModal = undefined; infoPrompt = false; }
		}
		async function palette(): Promise<void> {
			if (!active || finishModal) return;
			const actions: [string, () => void | Promise<void>][] = [...WORKSPACE_VIEWS.map((item): [string, () => void] => [item.label, () => switchView(item.id)]),
				["Progreso de desarrollo", showProgress], ["PR de la rama actual", showBranchPr], ["GitHub Actions", showActions], ["Subagentes", showSubagents], ["Elegir modelo", showModel], ["Ventana de contexto", showContext], ["Ubicación / worktree", showWorkspace], ["Recursos del equipo", showResources], ["Mostrar / ocultar lateral", toggleSidebar], ["Personalizar lateral", customizeSidebar], ["Alternar detalle de herramientas", () => { ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()); }], ["Actualizar datos", () => { void refreshLocal(); void refreshRemote(); }],
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
		const header = workspaceHeader(() => ({ theme: theme(), cwd: ctx.cwd, git, view }), { palette, switchView });
		const sidebarFrame = (width: number) => workspaceSidebar({ theme: theme(), cwd: ctx.cwd, height: Math.max(1, rows() - 6), git, gitError, resources, actions, project, envAt, envError, context: contextState(), issueTriage, subagents, workflowProgress: gitError ? undefined : workflow.current(ctx.cwd, git), hiddenSections: prefs.hiddenSections, model: ctx.model, thinking: ctx.thinkingLevel ?? "off", session }, width);
		const sidebar = new Lines((width) => sidebarFrame(width).lines, (event) => {
			if (event.type !== "click") return;
			const target = sidebarFrame(event.width).targets.get(event.y);
			if (target === "resources") void showResources(); else if (target === "context") void showContext();
			else if (target === "workspace") void showWorkspace(); else if (target === "actions") void showActions();
			else if (target === "subagents") void showSubagents(); else if (target === "progress") void showProgress(); else if (target === "model") void showModel();
			else if (target === "sidebar-settings") void customizeSidebar(); else if (target) switchView(target);
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
		const changesPane = new ReadView((width) => changesViewLines(theme(), { git, gitError, diff, diffLoading, selectedFile }, width), (data) => {
			if (matchesKey(data, "escape")) { switchView("chat"); return true; }
			if (matchesKey(data, "backspace")) { diffRequest++; diffLoading = false; diff = undefined; changesPane.offset = 0; changed(); return true; }
			if (diff === undefined && !diffLoading) {
				if (matchesKey(data, "up") || matchesKey(data, "down")) { selectedFile = Math.max(0, Math.min((git?.changes.length ?? 1) - 1, selectedFile + (matchesKey(data, "up") ? -1 : 1))); changesPane.offset = Math.max(0, selectedFile - Math.max(1, rows() - 12)); changed(); return true; }
				if (matchesKey(data, "return")) { void openChange(); return true; }
			}
			return false;
		}, changed, () => rows() - 6);
		const githubInspector = new GithubInspector({ state: () => ({ ctx, git, github, view, preparations, preparationsError }), active: () => active,
			gitIdentity, changed, modalBusy: () => !!finishModal, signal: controller.signal, offline: parsed.offline, pi, info });
		const showGithubDetail = (kind: GithubView): Promise<void> => githubInspector.show(kind);
		function githubPane(kind: GithubView): ReadView {
			const pane = new ReadView((width) => {
				const state = github[kind];
				state.selected = Math.max(0, Math.min(state.selected, (state.items?.length ?? 1) - 1));
				return githubViewLines(theme(), { kind, state, hasGit: !!git, remoteBusy, preparations, preparationsError, detailBusy: githubInspector.busy, now: Date.now() }, width);
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
		const omiPane = new ReadView((width) => omiViewLines(theme(), { project, services, environments, error: envError, at: envAt, now: Date.now() }, width), (data) => {
			if (matchesKey(data, "escape")) { switchView("chat"); return true; }
			if (data === "r") { void refreshRemote(); return true; }
			return false;
		}, changed, () => rows() - 6);
		const readPanes = { issues: issuesPane, prs: prsPane, changes: changesPane, omi: omiPane };

		const welcome = workspaceWelcome(() => ({ theme: theme(), cwd: ctx.cwd, git, modelShortcut, visible: !working && !ctx.sessionManager.getBranch().some((entry) => entry.type === "message") }), { palette, showModel, switchView });
		function buildRoot(): void {
			if (!tui || !document || !editor || !footer) return;
			if (!projectRoot) ({ projectRoot, baseRoot } = transcriptRoots({ document, workspaceDocument, pending, status, above, editor, below, footer }, theme, rows));
			root = workspaceRoot({ header, main: view === "chat" ? projectRoot : readPanes[view], sidebar, footer }, sidebarVisible);
			ensureRoot();
		}
		function ensureRoot(): void { if (active && tui && root && isViewportTUI(tui)) tui.setLayoutRoot(root); }
		const OmiEditor = workspaceEditor(CustomEditor, { theme, showModel, shortcut: (value) => { modelShortcut = value; } });
		const commands: [string, string, () => void | Promise<void>][] = [
			["omi", "Paleta de comandos de OMI", palette], ["omi-model", "Selector propio de modelo", showModel],
			["omi-workspace", "Ubicación y worktree", showWorkspace], ["omi-resources", "CPU, RAM y disco del host", showResources],
			["omi-actions", "Claude reviews y releases de GitHub Actions", showActions],
			["omi-progress", "Progreso del desarrollo hasta PR draft", showProgress],
			["omi-pr", "Enlace al PR de la rama actual", showBranchPr],
			["omi-context", "Ventana de contexto", showContext], ["omi-sidebar", "Mostrar / ocultar lateral", toggleSidebar], ["omi-output", "Alternar detalle de herramientas", () => { ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()); }],
			["omi-sidebar-settings", "Elegir los bloques visibles de la lateral", customizeSidebar],
			...WORKSPACE_VIEWS.map((item): [string, string, () => void] => [item.command, `Vista ${item.label}`, () => switchView(item.id)]),
		];
		for (const [name, description, handler] of commands) pi.registerCommand(name, { description, handler: async () => { if (active) await handler(); } });
		pi.registerCommand("omi-subagents", { description: "Detalle de subagentes y cancelación por ID de lote", handler: async (args) => { if (active) await showSubagents(args); } });

		pi.on("session_start", async (_event, context) => {
			if (context.mode !== "tui") return;
			ctx = context; prefs = await loadWorkspacePreferences(io.homeDir); session = sessionStats(ctx.sessionManager.getBranch()); active = true;
			unsubscribeSubagents?.(); subagents.clear();
			unsubscribeWorkflow?.(); workflow.clear();
			unsubscribeWorkflow = pi.events.on("omi:workflow", (event) => { if (active && workflow.consume(event)) changed(); });
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
				return workspaceFooter((width) => ({ theme: theme(), state: blocked ? "Esperando decisión" : working ? activity : "Listo", blocked, git, context: contextState(), sidebar: contextInSidebar(width),
					extra: text([...footerData.getExtensionStatuses().values()].join(" · ")), model: ctx.model, thinking: ctx.thinkingLevel ?? "off", modelShortcut, pr: branchPr, prStale: branchPrError !== undefined }),
					{ openPr: openBranchPr, showModel, palette, showContext, showWorkspace });
			});
			// Adaptador acotado a Pi 1.5.1: sus siete componentes públicos montados, sin tocar node_modules.
			// Si cambia ese contrato, conservar la TUI base en lugar de apropiarse de un árbol desconocido.
			const children = tui?.children;
			if (VERSION === "1.5.1" && children?.length === 7 && Array.isArray((children[4] as Container)?.children) && (children[0] as Container)?.children?.length === 3) {
				layoutCompatible = true;
				[document, pending, status, above, editor, below, footer] = children as [Component, Component, Component, Component, Container, Component, Component];
				// Pi 1.5.1: header, recursos y chat. Quitar sólo el header vacío con sus
				// márgenes; conservar recursos externos, diagnósticos y el chat intactos.
				const [, loadedResources, chat] = (document as Container).children;
				workspaceDocument = new Container();
				(workspaceDocument as Container).addChild(welcome);
				(workspaceDocument as Container).addChild(loadedResources!);
				(workspaceDocument as Container).addChild(new CompactTranscript(chat!, ToolExecutionComponent, theme, () => tui?.requestRender()));
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
			timer = setInterval(() => { void refreshLocal(); }, 3000); timer.unref(); if (parsed.offline || !ctx.isProjectTrusted()) void refreshRemote(); void refreshLocal(); changed();
		});
		pi.on("session_shutdown", async () => { active = false; unsubscribeWorkflow?.(); unsubscribeWorkflow = undefined; workflow.clear(); unsubscribeSubagents?.(); unsubscribeSubagents = undefined; subagents.clear(); controller.abort(); if (timer) clearInterval(timer); unsubscribeInput?.(); finishModal?.(); finishModal = undefined; if (tui && baseRoot && isViewportTUI(tui)) tui.setLayoutRoot(baseRoot); await Promise.all([saveQueue, issuePreparationTask?.catch(() => {}), issueSessionTask?.catch(() => {}), mainSessionTask?.catch(() => {})]); });
		pi.on("before_agent_start", (_event, context) => { ctx = context; working = true; activity = "Preparando turno"; changed(); });
		pi.on("agent_start", (_event, context) => { ctx = context; working = true; activity = "Trabajando"; changed(); });
		pi.on("agent_settled", (_event, context) => { ctx = context; working = false; runningTools.clear(); activity = "Listo"; void refreshLocal(); changed(); });
		pi.on("tool_execution_start", (event) => { runningTools.set(event.toolCallId, event.toolName); activity = `Ejecutando ${text(event.toolName)}${runningTools.size > 1 ? ` +${runningTools.size - 1}` : ""}`; changed(); });
		pi.on("tool_execution_end", (event) => { runningTools.delete(event.toolCallId); activity = runningTools.size ? `Ejecutando ${text([...runningTools.values()][0]!)}` : "Trabajando"; changed(); });
		pi.on("ui_prompt_start", () => { if (!active) return; blocked = true; if (!infoPrompt) { view = "chat"; buildRoot(); } changed(); });
		pi.on("ui_prompt_end", () => { blocked = false; changed(); });
		const update = (_event: unknown, context: ExtensionContext): void => { ctx = context; session = sessionStats(ctx.sessionManager.getBranch()); changed(); };
		pi.on("message_end", update); pi.on("session_compact", update); pi.on("session_compact_failed", update);
		pi.on("model_select", update); pi.on("thinking_level_select", update);
		pi.on("session_tree", (_event, context) => { workflow.clear(); subagents.clear(); issueTriage = restoreIssueTriage(context.sessionManager.getBranch(), context.cwd); update(_event, context); });
	} };
}
