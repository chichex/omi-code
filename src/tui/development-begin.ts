// Un pedido de desarrollo que vale la pena arranca el harness con un único sí humano: crear el issue
// si hace falta, clasificar, preparar worktree y sesión, cambiar de sesión y seguir en Explorar.
// Lo que se puede comprobar sin efectos (tamaño, identidad, repo, main local) falla antes de preguntar.
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import { readIssueSource, renderWorkflowArtifact } from "../harness/github.ts";
import { createWorkflow } from "../harness/state.ts";
import type { Workflow } from "../harness/model.ts";
import { beginCommand, issueDevelopmentTicket, revokeDevelopmentTicket, type BeginOrigin, type BeginRequest } from "./development-tickets.ts";
import { readGit, safeText, type GitSnapshot, type GithubItem } from "./workspace/data.ts";
import { classifyIssue, restoreIssueTriage } from "./workspace/issue-triage.ts";
import { prepareIssue, type IssueClassification } from "./workspace/issue-preparation.ts";
import { assertIssueIdentity, readIssuePreparation } from "./workspace/issue-registry.ts";
import { checkIssueWorktree, mainBaseCommit } from "./workspace/issue-worktree.ts";

/** Muestra un trabajo largo con opción de cancelar; undefined si la persona canceló. */
export type BeginLoader = <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
export interface BeginOptions {
	runner: Runner; offline: boolean; signal: AbortSignal; now: () => string; loader: BeginLoader; sessionDir: string | undefined;
	confirm: (ctx: ExtensionContext, title: string, description: string) => Promise<boolean>;
	/** El sí ya se dio: empezar o retomar el trabajo en la sesión actual. */
	startHere: () => Promise<void>;
}
const CLASSIFY_TIMEOUT_MS = 90_000;
// El número más largo que puede citar el artefacto: el pedido tiene que entrar también con él.
const MAX_ISSUE = 999_999_999;
// Bidi y ancho cero: lo publicado se leería distinto de lo que se mostró en el diálogo.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const TAIL = "Después se explora el código. No se escribe código hasta que apruebes la receta; los comandos y los cambios remotos piden permiso aparte. Termina en un PR draft, sin merge ni deploy.";
const shown = (value: string) => value.split("\n").map(safeText).join("\n");

/** Sin efectos: lo que el agente o el panel no pueden pedir. Lo usa la tool antes de terminar el turno. */
export function assertBeginRequest(request: BeginRequest): void {
	const issue = request.issue !== undefined; const fresh = request.title !== undefined || request.body !== undefined;
	if (issue === fresh || (fresh && (!request.title?.trim() || !request.body?.trim()))) throw new Error("Pasá issue con el número de un issue existente, o title y body para crear uno nuevo; no ambos.");
	if (INVISIBLE.test(`${request.title ?? ""}${request.body ?? ""}`)) throw new Error("El título o el cuerpo traen caracteres invisibles o de dirección de texto; quitalos para que lo publicado sea lo que se muestra.");
}
export function assertCanBegin(ctx: ExtensionContext, offline: boolean): void {
	if (!ctx.hasUI) throw new Error("Empezar un trabajo requiere confirmación humana interactiva");
	if (!ctx.isProjectTrusted()) throw new Error("El harness de desarrollo requiere un proyecto de confianza");
	if (!ctx.sessionManager.getSessionFile()) throw new Error("El worktree del trabajo requiere una sesión persistente. Volvé a abrir OMI sin --no-session.");
	if (offline) throw new Error("Empezar o retomar un trabajo necesita GitHub: quitá --offline.");
	if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("Elegí un modelo autenticado con /omi-model o /login antes de empezar un trabajo.");
}
const placeholder = (git: GitSnapshot): Workflow["checkout"] => ({ root: git.root, commonDir: git.commonDir, branch: "main", baseCommit: "preview" });
// El pedido se cita en los comentarios del issue: si no entra, nunca se podrá aprobar.
function assertQuotable(source: Workflow["source"], git: GitSnapshot, now: string): void {
	try { renderWorkflowArtifact(createWorkflow(source, placeholder(git), "preview", now)); }
	catch { throw new Error("El pedido es demasiado grande para citarlo en un comentario de GitHub; acotalo antes de empezar."); }
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

export interface BeginTicket { origin: BeginOrigin; request: BeginRequest }
// Lo que va a pasar se lee primero; el texto que se publica va al final y completo.
function dialog(actions: string, ticket: BeginTicket, details: string): string {
	const who = ticket.origin === "panel" ? "Pedido desde el panel de Issues." : `Motivo del agente: ${shown(ticket.request.reason?.trim() || "sin motivo")}`;
	return `${actions} ${TAIL}\n\n${who}\n\n${details}`;
}
export async function beginDevelopment(ctx: ExtensionCommandContext, ticket: BeginTicket, options: BeginOptions): Promise<void> {
	const { request } = ticket;
	assertBeginRequest(request); assertCanBegin(ctx, options.offline);
	const git = await readGit(ctx.cwd, options.signal);
	if (!git) throw new Error("Empezar un trabajo necesita un repositorio Git");
	const origin = ctx.sessionManager.getSessionFile()!;
	let number = request.issue; let source: Workflow["source"] | undefined; let created = "";
	if (number === undefined) {
		const title = request.title!.trim(); const body = request.body!.trim();
		const repo = await readRepository(git, options);
		assertQuotable({ number: MAX_ISSUE, title, body, url: `https://github.com/${repo}/issues/${MAX_ISSUE}`, hash: "preview" }, git, options.now());
		await mainBaseCommit(git, options.signal);
		if (!(await options.confirm(ctx, "Crear issue y empezar el trabajo", dialog(`Se crea un issue en ${repo} con el pedido de abajo, se clasifica y se prepara un worktree nuevo desde main local, en una sesión nueva.`, ticket, `${shown(title)}\n\n${shown(body)}`)))) {
			ctx.ui.notify("No se creó nada: el chat sigue igual.", "info"); return;
		}
		number = await createIssue(git, repo, title, body, options);
		created = `El issue #${number} ya se creó en ${repo}: para seguir, pedí el #${number}; no lo vuelvas a crear.`;
	} else {
		source = await readIssueSource(placeholder(git), number, options.runner, options.signal);
		assertQuotable(source, git, options.now());
		const here = restoreIssueTriage(ctx.sessionManager.getBranch(), ctx.cwd)?.issue.number === number;
		const saved = here ? undefined : await readIssuePreparation(git, number);
		// Sin efectos: identidad guardada, main local y que la ruta del worktree no sea ajena.
		if (saved) assertIssueIdentity(saved, { number, url: source.url });
		else if (!here) await checkIssueWorktree(git, number, options.signal);
		const where = here ? "Se trabaja en este worktree."
			: saved?.phase === "ready" ? `Se abre su sesión en ${saved.state.worktree} y el trabajo sigue desde la etapa guardada; si estaba pausado, sigue pausado hasta /omi-work resume.`
			: saved ? `Se completa la preparación guardada en ${saved.state.worktree}, sin reclasificar, y se abre su sesión.`
			: "Se clasifica y se prepara un worktree nuevo desde main local, en una sesión nueva.";
		if (!(await options.confirm(ctx, `${saved ? "Retomar" : "Empezar"} el trabajo del issue #${number}`, dialog(where, ticket, `Issue #${number}: ${shown(source.title)}\n${source.url}`)))) {
			ctx.ui.notify("No se creó nada: el chat sigue igual.", "info"); return;
		}
		if (here) { await options.startHere(); return; }
	}
	try { await prepareAndSwitch(ctx, git, number, source, origin, options); }
	catch (error) { throw created ? new Error(`${created} ${error instanceof Error ? error.message : "No se pudo preparar el trabajo."}`) : error; }
}
async function prepareAndSwitch(ctx: ExtensionCommandContext, git: GitSnapshot, issueNumber: number, known: Workflow["source"] | undefined, origin: string, options: BeginOptions): Promise<void> {
	const issueSource = known ?? await readIssueSource(placeholder(git), issueNumber, options.runner, options.signal);
	const item: GithubItem = { number: issueNumber, title: issueSource.title, url: issueSource.url, labels: await readLabels(git, issueNumber, options), author: "", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const prepared = await prepareIssue(git, issueNumber, item, ctx, {
		...(options.sessionDir ? { sessionDir: options.sessionDir } : {}), signal: options.signal,
		isCurrent: () => !options.signal.aborted && ctx.sessionManager.getSessionFile() === origin,
		classify: async (): Promise<IssueClassification | undefined> => {
			const result = await options.loader(ctx, `Clasificando el issue #${issueNumber}`, (signal) => classifyIssue(ctx, item, issueSource.body, AbortSignal.any([signal, options.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)])));
			return result && { ...result, body: issueSource.body };
		},
	});
	if (!prepared) { ctx.ui.notify(`Clasificación cancelada. El issue #${issueNumber} sigue en GitHub; no se creó worktree ni sesión.`, "warning"); return; }
	const { record } = prepared; const sessionFile = record.sessionFile!;
	if (resolve(sessionFile) === resolve(origin)) { await options.startHere(); return; }
	// switchSession sólo existe en comandos: el sí viaja como un token de un solo uso ligado a la sesión destino.
	const token = issueDevelopmentTicket({ kind: "start", sessionFile, issue: issueNumber });
	let switched = false;
	try {
		const result = await ctx.switchSession(sessionFile, { withSession: async (next) => { switched = true; await next.sendUserMessage(beginCommand(token), { expandPromptTemplates: true }); } });
		if (result.cancelled) ctx.ui.notify(`Cambio de sesión cancelado. El worktree quedó en ${record.state.worktree}; volvé a pedir el issue #${issueNumber} para seguir.`, "warning");
	} finally { if (!switched) revokeDevelopmentTicket(token); }
}

export const borderedLoader: BeginLoader = async <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
	const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
	let failure: unknown; let value: T | undefined;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const loader = new BorderedLoader(tui, theme, `${title} · Esc cancelar`);
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
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S", description: "Título del issue nuevo, si el pedido no tiene issue" })),
	body: Type.Optional(Type.String({ minLength: 1, maxLength: 60000, pattern: "\\S", description: "Pedido completo para el issue nuevo: qué, por qué, contexto y criterios que surgieron en el chat" })),
	reason: Type.String({ minLength: 1, maxLength: 600, pattern: "\\S", description: "Por qué este pedido vale la pena seguirlo con el harness" }),
}, { additionalProperties: false });
export interface BeginToolHost { offline: boolean; busy: () => boolean; onRequest: (token: string) => void }
export function registerBeginTool(pi: ExtensionAPI, host: BeginToolHost): void {
	pi.registerTool({
		name: "omi_work_begin", label: "Desarrollo: empezar trabajo", executionMode: "sequential", parameters: BeginToolSchema,
		description: "Propone empezar el harness de desarrollo para un pedido de cambio de código de este repo que vale la pena seguir: feature, fix, mejora o chore con impacto. Con issue usa un issue existente de GitHub; con title y body propone crear uno nuevo. No crea nada por sí misma: al terminar el turno OMI le pide confirmación a la persona, prepara un worktree desde main local en una sesión nueva y el trabajo sigue en Explorar. La sesión nueva no hereda este chat: el body tiene que traer el pedido completo, el contexto y los criterios que surgieron acá.",
		promptSnippet: "Empezar el harness de desarrollo ante un pedido de cambio de código que vale la pena seguir",
		promptGuidelines: [
			"Cuando la persona pide un cambio de código en este repo que vale la pena seguir (feature, fix, mejora o chore con impacto), llamá a omi_work_begin en lugar de editar archivos directo. Si nombra un issue (#N), pasá issue; si no, title y body para crear uno.",
			"No llames a omi_work_begin para preguntas, explicaciones, operaciones de OMI ni un cambio trivial que la persona pidió hacer directo: eso sigue en el chat.",
		],
		async execute(_id, input, _signal, _update, ctx) {
			assertBeginRequest(input); assertCanBegin(ctx, host.offline);
			if (host.busy()) throw new Error("Esta sesión ya tiene un trabajo de desarrollo activo; seguí con ese o salí con /omi-work stop.");
			host.onRequest(issueDevelopmentTicket({ kind: "request", origin: "agent", sessionFile: ctx.sessionManager.getSessionFile()!, request: input }));
			return { content: [{ type: "text", text: "Pedido registrado. Al terminar este turno OMI le pide confirmación a la persona y, si acepta, el trabajo sigue en el worktree del issue. No edites archivos ni sigas con el pedido en este chat." }], details: { request: input }, terminate: true };
		},
	});
}
