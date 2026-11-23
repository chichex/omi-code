// Un pedido nuevo se clasifica antes de crear recursos: simple/dudas vuelven al chat; harness crea el issue
// (con el sí sólo si Foundations dice arranque: ask), reutiliza triage, prepara worktree/sesión y sigue en Explorar.
// Lo que se puede comprobar sin efectos (tamaño, identidad, repo, main local) falla antes de preguntar.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import { readIssueSource } from "../harness/github.ts";
import { renderWorkflowArtifact } from "../harness/pr-body.ts";
import { createWorkflow } from "../harness/state.ts";
import { readWorkflow } from "../harness/store.ts";
import type { Workflow } from "../harness/model.ts";
import { beginCommand, issueDevelopmentTicket, revokeDevelopmentTicket, type BeginOrigin, type BeginRequest } from "./development-tickets.ts";
import { readGit, safeText, type GitSnapshot, type GithubItem } from "./workspace/data.ts";
import { classifyDevelopmentRequest, decideDevelopmentRequest, classifyIssue, restoreIssueTriage } from "./workspace/issue-triage.ts";
import type { RequestDecision, TriagePolicyPin } from "../harness/triage-policy.ts";
import { prepareIssue, type IssueClassification } from "./workspace/issue-preparation.ts";
import { assertIssueIdentity, discoverLegacyPreparations, readIssuePreparation, verifyIssuePreparation, type IssuePreparation } from "./workspace/issue-registry.ts";
import { PHASE_LABELS } from "./development-view.ts";
import { checkIssueWorktree, mainBaseCommit } from "./workspace/issue-worktree.ts";
import { carryFoundationsPin } from "./development-foundations.ts";
import { WaitingLoader } from "./development-loader.ts";

/** Muestra un trabajo largo con opción de cancelar; undefined si la persona canceló. */
export type BeginLoader = <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
export interface BeginOptions {
	runner: Runner; offline: boolean; signal: AbortSignal; now: () => string; loader: BeginLoader; sessionDir: string | undefined;
	confirm: (ctx: ExtensionContext, title: string, description: string) => Promise<boolean>;
	triagePolicy: (ctx: ExtensionContext) => Promise<TriagePolicyPin>;
	/** El sí ya se dio: empezar o retomar el trabajo en la sesión actual. */
	startHere: () => Promise<void>;
	/** Sólo tests: el tope de una clasificación. */
	classifyTimeoutMs?: number;
}
// Una clasificación corre sin razonamiento: si no volvió en un minuto, esperar más no ayuda.
const CLASSIFY_TIMEOUT_MS = 60_000;
// El número más largo que puede citar el artefacto: el pedido tiene que entrar también con él.
const MAX_ISSUE = 999_999_999;
// Formato invisible (bidi, ancho cero, tags) y selectores de variación suplementarios: lo publicado
// se leería distinto de lo que se mostró, y el texto vuelve como contexto de un modelo.
const INVISIBLE = /[\p{Cf}\u{E0100}-\u{E01EF}]/u;
const TAIL = "No se escribe código hasta aprobar la receta. Qué pide tu sí (receta, comandos, push y PR) lo decide Foundations. Termina en un PR draft, sin merge ni deploy.";
const FRESH = "Se clasifica, se trae main de origin (sólo fast-forward) y se prepara un worktree nuevo desde main, en una sesión nueva, y se explora el código.";
const shown = (value: string) => value.split("\n").map(safeText).join("\n");
const modelName = (ctx: ExtensionContext): string => safeText(ctx.model?.name || ctx.model?.id || "el modelo");
/** Muestra qué modelo clasifica; si se agota el tope, lo dice en castellano en lugar del error del runtime. */
async function classifying<T>(ctx: ExtensionContext, options: BeginOptions, what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
	const limit = options.classifyTimeoutMs ?? CLASSIFY_TIMEOUT_MS; const timeout = AbortSignal.timeout(limit); const model = modelName(ctx);
	try { return await options.loader(ctx, `${what} con ${model}`, (signal) => work(AbortSignal.any([signal, options.signal, timeout]))); }
	catch (error) {
		if (!timeout.aborted || options.signal.aborted) throw error;
		throw new Error(`${model} no respondió la clasificación en ${Math.max(1, Math.round(limit / 1000))} s. Reintentá, o elegí otro modelo con /omi-model.`, { cause: error });
	}
}

/** Sin efectos: lo que el agente o el panel no pueden pedir. Lo usa la tool antes de terminar el turno. */
export function assertBeginRequest(request: BeginRequest): void {
	const issue = request.issue !== undefined; const fresh = request.title !== undefined || request.body !== undefined;
	if (issue === fresh || (fresh && (!request.title?.trim() || !request.body?.trim()))) throw new Error("Pasá issue con el número de un issue existente, o title y body para crear uno nuevo; no ambos.");
	if (INVISIBLE.test(`${request.title ?? ""}${request.body ?? ""}`)) throw new Error("El título o el cuerpo traen caracteres invisibles o de dirección de texto; quitalos para que lo publicado sea lo que se muestra.");
}
export function assertCanBegin(ctx: ExtensionContext, offline: boolean): void {
	// También con arranque: auto: la clasificación se muestra con Esc para cancelar y el trabajo cambia de sesión.
	if (!ctx.hasUI) throw new Error("Empezar un trabajo requiere la TUI o RPC: muestra la clasificación (Esc la cancela) y cambia a la sesión del worktree.");
	if (!ctx.isProjectTrusted()) throw new Error("El harness de desarrollo requiere un proyecto de confianza");
	if (!ctx.sessionManager.getSessionFile()) throw new Error("El worktree del trabajo requiere una sesión persistente. Volvé a abrir OMI sin --no-session.");
	if (offline) throw new Error("Empezar o retomar un trabajo necesita GitHub: quitá --offline o PI_OFFLINE.");
	if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("Elegí un modelo autenticado con /omi-model o /login antes de empezar un trabajo.");
}
const placeholder = (git: GitSnapshot): Workflow["checkout"] => ({ root: git.root, commonDir: git.commonDir, branch: "main", baseCommit: "preview" });
// El pedido se cita en el PR draft: si no entra, nunca se podrá publicar.
function assertQuotable(source: Workflow["source"], git: GitSnapshot, now: string): void {
	try { renderWorkflowArtifact(createWorkflow(source, placeholder(git), "preview", now)); }
	catch { throw new Error("El pedido es demasiado grande para citarlo en el PR draft de GitHub; acotalo antes de empezar."); }
}
async function gh(git: GitSnapshot, args: string[], options: BeginOptions, input?: string): Promise<string> {
	const result = await options.runner.run("gh", args, { cwd: git.root, env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" }, signal: options.signal, ...(input === undefined ? {} : { input }) });
	options.signal.throwIfAborted();
	if (result.code !== 0) throw new Error(`GitHub no pudo completar ${args[0]} ${args[1]}`);
	return result.stdout;
}
async function readRepository(git: GitSnapshot, options: BeginOptions): Promise<string> {
	const data: unknown = JSON.parse(await gh(git, ["repo", "view", "--json", "nameWithOwner"], options));
	const name = data && typeof data === "object" && "nameWithOwner" in data ? data.nameWithOwner : undefined;
	if (typeof name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error("No se pudo identificar el repositorio de GitHub");
	return name;
}
async function readLabels(git: GitSnapshot, number: number, options: BeginOptions): Promise<string[]> {
	const data: unknown = JSON.parse(await gh(git, ["issue", "view", String(number), "--json", "labels"], options));
	const labels = data && typeof data === "object" && "labels" in data && Array.isArray(data.labels) ? data.labels : [];
	return labels.map((label: unknown) => label && typeof label === "object" && "name" in label ? label.name : undefined).filter((name): name is string => typeof name === "string").slice(0, 100);
}
// Una respuesta perdida puede haber creado el issue: no se reintenta solo, se pide revisar.
async function createIssue(git: GitSnapshot, repo: string, title: string, body: string, options: BeginOptions): Promise<number> {
	let url = "";
	try { url = (await gh(git, ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], options, body)).trim().split("\n").at(-1) ?? ""; }
	catch { options.signal.throwIfAborted(); }
	const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(url);
	if (!match || match[1]!.toLowerCase() !== repo.toLowerCase()) throw new Error(`No se pudo confirmar la creación del issue en ${repo}. Revisá GitHub antes de volver a pedirlo, para no duplicarlo.`);
	return Number(match[2]);
}

// Sin efectos: el trabajo guardado, para que el diálogo diga qué va a pasar con él.
async function savedWork(git: GitSnapshot, number: number, state: { worktree: string; branch: string; baseCommit: string }): Promise<Workflow | undefined> {
	try { return await readWorkflow({ root: await realpath(state.worktree), commonDir: await realpath(git.commonDir), branch: state.branch, baseCommit: state.baseCommit }, number); }
	catch (error) { throw new Error(`No se pudo leer el trabajo guardado del issue #${number}: ${error instanceof Error ? error.message : "estado inválido"}. Abrí su sesión con /resume para recuperarlo.`); }
}
function workNote(work: Workflow | undefined): string {
	if (!work) return "Se explora el código.";
	const phase = PHASE_LABELS[work.phase];
	if (work.status === "paused") return `El trabajo está pausado en ${phase} (${shown(work.blockedReason || work.activity.replace(/^pause: /, ""))}): con el sí se reanuda desde ahí, sin conceder aprobaciones.`;
	if (work.status === "complete") return `El trabajo ya terminó (${phase}): se abre para consultarlo, sin volver a ejecutar nada.`;
	return `El trabajo sigue desde ${phase}.`;
}
// Sin efectos: el registro, o una preparación anterior al registro que se reconoce por su sesión.
async function savedPreparation(git: GitSnapshot, number: number, url: string, options: BeginOptions): Promise<IssuePreparation | undefined> {
	let saved = await readIssuePreparation(git, number);
	if (!saved) {
		const legacy = (await discoverLegacyPreparations(git, new Map(), options.sessionDir, options.signal, number)).get(number);
		if (legacy?.error) throw new Error(legacy.error);
		saved = legacy?.record;
	}
	if (!saved) return undefined;
	assertIssueIdentity(saved, { number, url });
	if (saved.phase === "ready") await verifyIssuePreparation(git, saved, options.signal);
	return saved;
}

export interface BeginTicket { origin: BeginOrigin; request: BeginRequest }
// Lo que va a pasar se lee primero; el texto que se publica va al final y completo.
function dialog(actions: string, ticket: BeginTicket, details: string): string {
	const who = ticket.origin === "panel" ? "Pedido desde el panel de Issues." : `Motivo del agente: ${shown(ticket.request.reason?.trim() || "sin motivo")}`;
	return `${actions} ${TAIL}\n\n${who}\n\n${details}`;
}
export interface BeginChatResult { classification: Awaited<ReturnType<typeof classifyDevelopmentRequest>>; decision: RequestDecision }
export async function beginDevelopment(ctx: ExtensionCommandContext, ticket: BeginTicket, options: BeginOptions): Promise<BeginChatResult | undefined> {
	const { request } = ticket;
	assertBeginRequest(request); assertCanBegin(ctx, options.offline);
	const git = await readGit(ctx.cwd, options.signal);
	if (!git) throw new Error("Empezar un trabajo necesita un repositorio Git");
	const origin = ctx.sessionManager.getSessionFile()!;
	let number = request.issue; let source: Workflow["source"] | undefined; let created = "";
	let prior: (IssueClassification & { title: string }) | undefined;
	const current = () => { options.signal.throwIfAborted(); if (ctx.sessionManager.getSessionFile() !== origin) throw new Error("La sesión cambió durante la clasificación; no se creó ningún recurso."); };
	if (number === undefined) {
		const title = request.title!.trim(); const body = request.body!.trim();
		const repo = await readRepository(git, options);
		assertQuotable({ number: MAX_ISSUE, title, body, url: `https://github.com/${repo}/issues/${MAX_ISSUE}`, hash: "preview" }, git, options.now());
		await mainBaseCommit(git, options.signal); current();
		const pin = await options.triagePolicy(ctx); current();
		if (pin.notice) ctx.ui.notify(shown(pin.notice), "info");
		const classification = await classifying(ctx, options, "Clasificando el pedido", (signal) => classifyDevelopmentRequest(ctx, { title, body }, signal));
		current();
		if (!classification) { ctx.ui.notify("Clasificación cancelada: no se creó issue, rama, worktree ni sesión. El chat sigue igual.", "info"); return; }
		const decision = decideDevelopmentRequest(classification, pin.policy);
		if (decision.kind !== "harness") return { classification, decision };
		prior = { ...classification, title, body };
		if (!(await options.confirm(ctx, "Crear issue y empezar el trabajo", dialog(`Clasificación previa: ${shown(decision.reason)} Se crea un issue en ${repo} con el pedido de abajo. Se trae main de origin (sólo fast-forward) y se prepara un worktree desde main y una sesión nueva para explorar el código, sin volver a clasificar.`, ticket, `${shown(title)}\n\n${shown(body)}`)))) {
			ctx.ui.notify("No se creó nada: el chat sigue igual.", "info"); return;
		}
		current();
		number = await createIssue(git, repo, title, body, options);
		created = `El issue #${number} ya se creó en ${repo}: para seguir, pedí el #${number}; no lo vuelvas a crear.`;
	} else {
		source = await readIssueSource(placeholder(git), number, options.runner, options.signal);
		assertQuotable(source, git, options.now());
		const triage = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd); const here = triage?.issue.number === number;
		// Sin efectos: preparación e identidad guardadas, main local, que el worktree no sea ajeno y el trabajo guardado.
		const saved = here ? undefined : await savedPreparation(git, number, source.url, options);
		if (!here && !saved) await checkIssueWorktree(git, number, options.signal);
		const base = here ? triage : saved?.phase === "ready" ? saved.state : undefined;
		const work = base && await savedWork(git, number, base);
		const where = here ? `Se trabaja en este worktree. ${workNote(work)}`
			: saved?.phase === "ready" ? `Se abre su sesión en ${saved.state.worktree}. ${workNote(work)}`
			: saved ? `Se completa la preparación guardada en ${saved.state.worktree}, sin reclasificar, se abre su sesión y se explora el código.`
			: FRESH;
		if (!(await options.confirm(ctx, `${saved || work ? "Retomar" : "Empezar"} el trabajo del issue #${number}`, dialog(where, ticket, `Issue #${number}: ${shown(source.title)}\n${source.url}`)))) {
			ctx.ui.notify("No se creó nada: el chat sigue igual.", "info"); return;
		}
		if (here) { await options.startHere(); return; }
	}
	try { await prepareAndSwitch(ctx, git, number, source, origin, options, prior); }
	catch (error) { throw created ? new Error(`${created} ${error instanceof Error ? error.message : "No se pudo preparar el trabajo."}`, { cause: error }) : error; }
}
async function prepareAndSwitch(ctx: ExtensionCommandContext, git: GitSnapshot, issueNumber: number, known: Workflow["source"] | undefined, origin: string, options: BeginOptions, prior?: IssueClassification & { title: string }): Promise<void> {
	const issueSource = known ?? await readIssueSource(placeholder(git), issueNumber, options.runner, options.signal);
	if (prior && (prior.title !== issueSource.title || prior.body !== issueSource.body)) throw new Error("El pedido publicado no coincide con el que se clasificó. Retomá el issue existente para revisar el cambio.");
	const item: GithubItem = { number: issueNumber, title: issueSource.title, url: issueSource.url, labels: [], author: "", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const prepared = await prepareIssue(git, issueNumber, item, ctx, {
		...(options.sessionDir ? { sessionDir: options.sessionDir } : {}), signal: options.signal,
		isCurrent: () => !options.signal.aborted && ctx.sessionManager.getSessionFile() === origin,
		classify: async (): Promise<IssueClassification | undefined> => {
			if (prior) return prior;
			// Las etiquetas sólo sirven para un triage nuevo (clasificar y guardarlo): al retomar no se piden.
			item.labels = await readLabels(git, issueNumber, options);
			const result = await classifying(ctx, options, `Clasificando el issue #${issueNumber}`, (signal) => classifyIssue(ctx, item, issueSource.body, signal));
			return result && { ...result, body: issueSource.body };
		},
	});
	if (!prepared) { ctx.ui.notify(`Clasificación cancelada. El issue #${issueNumber} sigue en GitHub; no se creó worktree ni sesión.`, "warning"); return; }
	const { record } = prepared; const sessionFile = record.sessionFile!;
	if (resolve(sessionFile) === resolve(origin)) { await options.startHere(); return; }
	// switchSession sólo existe en comandos: el sí viaja como un token de un solo uso ligado a la sesión destino.
	// Foundations ya se decidió acá: la sesión del worktree no relee la KB ni vuelve a preguntar.
	carryFoundationsPin(origin, sessionFile);
	const token = issueDevelopmentTicket({ kind: "start", sessionFile, issue: issueNumber });
	let switched = false;
	try {
		const result = await ctx.switchSession(sessionFile, { withSession: async (next) => { switched = true; await next.sendUserMessage(beginCommand(token), { expandPromptTemplates: true }); } });
		if (result.cancelled) ctx.ui.notify(`Cambio de sesión cancelado. El worktree quedó en ${record.state.worktree}; volvé a pedir el issue #${issueNumber} para seguir.`, "warning");
	} finally { if (!switched) revokeDevelopmentTicket(token); }
}

export const borderedLoader: BeginLoader = async <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
	let failure: unknown; let value: T | undefined;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const loader = new WaitingLoader(tui, theme, title);
		let finished = false; const finish = () => { if (!finished) { finished = true; done(); } };
		loader.onAbort = finish;
		work(loader.signal).then((result) => { if (!loader.signal.aborted) value = result; finish(); }, (error) => { if (!loader.signal.aborted) failure = error; finish(); });
		return loader;
	}, { overlay: true });
	if (failure) throw failure;
	return value;
};

const BeginToolSchema = Type.Object({
	issue: Type.Optional(Type.Integer({ minimum: 1, description: "Número de un issue existente de este repo (#N). Si el pedido lo nombra, usalo en lugar de crear otro." })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S", description: "Título del pedido nuevo para clasificar antes de crear un issue, si amerita harness" })),
	body: Type.Optional(Type.String({ minLength: 1, maxLength: 60000, pattern: "\\S", description: "Pedido completo para clasificar: qué, por qué, contexto y criterios del chat; será el cuerpo del issue sólo si amerita harness" })),
	reason: Type.String({ minLength: 1, maxLength: 600, pattern: "\\S", description: "Por qué este pedido vale la pena evaluar para el harness" }),
}, { additionalProperties: false });
export interface BeginToolHost { offline: boolean; busy: () => boolean; onRequest: (token: string) => void }
export function registerBeginTool(pi: ExtensionAPI, host: BeginToolHost): void {
	pi.registerTool({
		name: "omi_work_begin", label: "Desarrollo: empezar trabajo", executionMode: "sequential", parameters: BeginToolSchema,
		description: "Evalúa un pedido de código que vale la pena seguir. Con title y body, OMI clasifica antes de crear issue o recursos: un cambio simple sigue en el chat original; si falta información, vuelve con preguntas sin crear nada. Si requiere harness, crea el issue con el texto del pedido sin preguntar, salvo que Foundations diga arranque: ask (entonces pide el sí), y reutiliza el triage para preparar worktree desde main (antes la trae de origin, sólo fast-forward) y sesión nueva en Explorar. Con issue existente siempre usa harness y ese mismo número; retoma sin reclasificar. La tool termina el turno y bloquea otras tools hasta resolver la clasificación/confirmación; no crea nada por sí misma. No autoriza comandos o acciones sensibles. La sesión nueva no hereda el chat: body debe traer pedido, contexto y criterios completos.",
		promptSnippet: "Clasificar un pedido antes de crear issue o empezar el harness; los cambios simples vuelven al chat",
		promptGuidelines: [
			"Cuando la persona pide un cambio de código que vale la pena seguir, llamá a omi_work_begin en lugar de editar directo. Si nombra un issue (#N), pasá issue (siempre harness); si no, title y body para clasificar ANTES de crear un issue. OMI puede devolver un cambio simple o preguntas al chat: no repitas el mismo pedido sin información nueva. Clasificar no autoriza acciones ni sustituye las reglas y permisos del proyecto.",
			"No llames a omi_work_begin para preguntas, explicaciones, operaciones de OMI ni un cambio trivial que la persona pidió hacer directo: eso sigue en el chat.",
		],
		async execute(_id, input, _signal, _update, ctx) {
			assertBeginRequest(input); assertCanBegin(ctx, host.offline);
			if (host.busy()) throw new Error("Esta sesión ya tiene un trabajo de desarrollo activo; seguí con ese o salí con /omi-work stop.");
			host.onRequest(issueDevelopmentTicket({ kind: "request", origin: "agent", sessionFile: ctx.sessionManager.getSessionFile()!, request: input }));
			return { content: [{ type: "text", text: "Pedido registrado. Al terminar el turno OMI clasifica los pedidos nuevos antes de crear recursos. Puede devolver un cambio simple o preguntas a este chat, sin activar harness; si lo requiere, crea el issue (con el sí de la persona sólo si Foundations dice arranque: ask) y reutiliza el triage. Un issue existente siempre sigue por harness. No llames otras tools: quedan bloqueadas hasta resolver el pedido. La clasificación no concede permisos. Si hace falta, respondé sólo con un resumen breve." }], details: { request: input }, terminate: true };
		},
	});
}
