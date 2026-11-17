// Mutaciones Git sólo tras el sí humano al empezar un trabajo (development-begin). Nunca checkout/stash/fetch en el origen.
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { childEnvironment } from "../../core/process-environment.ts";
import { safeText, type GitSnapshot } from "./data.ts";

export type IssueType = "feature" | "fix" | "improvement" | "chore";
export const ISSUE_TYPES: Record<IssueType, { label: string; branch: string }> = {
	feature: { label: "Nuevo feature", branch: "feat" }, fix: { label: "Fix", branch: "fix" },
	improvement: { label: "Mejora", branch: "improve" }, chore: { label: "Chore", branch: "chore" },
};
export interface IssueWorktree { worktree: string; branch: string; baseRef: "main"; baseCommit: string }
export type WorktreeCommand = (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;
const gitCommand: WorktreeCommand = (args, cwd, signal) => new Promise((resolve, reject) => {
	execFile("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args], {
		cwd, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
		env: { ...childEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
	}, (error, stdout, stderr) => {
		if (error && typeof error.code !== "number") { reject(error); return; }
		resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
	});
});

export function issueWorktreePath(git: Pick<GitSnapshot, "mainRoot">, number: number): string {
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Número de issue no válido");
	return join(dirname(git.mainRoot), `${basename(git.mainRoot)}-worktrees`, `issue-${number}`);
}
function issueBranch(type: IssueType, number: number, title: string): string {
	const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
	return `${ISSUE_TYPES[type].branch}/issue-${number}${slug ? `-${slug}` : ""}`;
}
async function available(path: string): Promise<void> {
	try { await lstat(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	throw new Error(`Ya existe ${path}. Abrí ese worktree o su sesión con /resume; no se sobrescribió nada.`);
}
/** Sólo lectura: la base de todo worktree de issue es el commit de main local. */
export async function mainBaseCommit(git: Pick<GitSnapshot, "root">, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<string> {
	signal?.throwIfAborted();
	const base = await run(["rev-parse", "--verify", "refs/heads/main^{commit}"], git.root, signal);
	const baseCommit = base.stdout.trim();
	if (base.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error("No hay una main local con commits. Prepará main antes de iniciar el issue; OMI no hace fetch ni usa otra rama como base.");
	return baseCommit;
}
export async function checkIssueWorktree(git: Pick<GitSnapshot, "root" | "mainRoot">, number: number, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<{ worktree: string; baseCommit: string }> {
	signal?.throwIfAborted();
	const worktree = issueWorktreePath(git, number);
	await available(worktree);
	return { worktree, baseCommit: await mainBaseCommit(git, signal, run) };
}
export async function planIssueWorktree(git: Pick<GitSnapshot, "root" | "mainRoot">, issue: { number: number; title: string }, type: IssueType, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<IssueWorktree> {
	const { worktree, baseCommit } = await checkIssueWorktree(git, issue.number, signal, run);
	const branch = issueBranch(type, issue.number, issue.title);
	const existing = await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], git.root, signal);
	if (existing.code === 0) throw new Error(`Ya existe la rama ${branch}. No se reutiliza ni se resetea una rama existente.`);
	if (existing.code !== 1) throw new Error("No se pudo comprobar si la rama del issue ya existe");
	return { worktree, branch, baseRef: "main", baseCommit };
}
export interface RegisteredWorktree { worktree: string; branch?: string }
export async function registeredIssueWorktrees(git: Pick<GitSnapshot, "root">, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<RegisteredWorktree[]> {
	const result = await run(["worktree", "list", "--porcelain", "-z"], git.root, signal);
	if (result.code !== 0) throw new Error("No se pudo verificar git worktree list");
	const trees: RegisteredWorktree[] = [];
	for (const field of result.stdout.split("\0")) {
		if (field.startsWith("worktree ")) trees.push({ worktree: field.slice(9) });
		else if (field.startsWith("branch ") && trees.length) trees[trees.length - 1]!.branch = field.slice(7);
	}
	return trees;
}
/** Un nombre de carpeta no prueba pertenencia: verificar registro Git, raíz, common-dir y rama real. */
export async function inspectIssueWorktree(git: Pick<GitSnapshot, "root" | "commonDir">, plan: IssueWorktree, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<"ready" | "missing"> {
	const trees = await registeredIssueWorktrees(git, signal, run);
	const registered = trees.find((tree) => resolve(tree.worktree) === resolve(plan.worktree));
	let exists = false;
	try {
		const info = await lstat(plan.worktree); exists = true;
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`La ruta guardada no es un directorio de worktree: ${plan.worktree}`);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (!exists) {
		if (registered) throw new Error(`Falta el worktree registrado en ${plan.worktree}. Recuperá su ubicación con git worktree repair; OMI no lo recrea ni lo poda.`);
		return "missing";
	}
	if (!registered || registered.branch !== `refs/heads/${plan.branch}`) throw new Error(`El worktree ${plan.worktree} no corresponde a la rama guardada ${plan.branch}. No se modificó nada; revisá git worktree list.`);
	const paths = await run(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], plan.worktree, signal);
	const [root, common] = paths.stdout.trimEnd().split("\n");
	const branch = await run(["symbolic-ref", "--quiet", "HEAD"], plan.worktree, signal);
	if (paths.code !== 0 || !root || !common || await realpath(root) !== await realpath(plan.worktree) || await realpath(common) !== await realpath(git.commonDir) || branch.code !== 0 || branch.stdout.trim() !== `refs/heads/${plan.branch}`) {
		throw new Error(`No se pudo verificar la identidad del worktree ${plan.worktree}. No se reutiliza una carpeta ajena.`);
	}
	return "ready";
}
/** Sólo un plan ya persistido permite recuperar una rama que dejó un worktree add interrumpido. */
export async function ensureIssueWorktree(git: Pick<GitSnapshot, "root" | "commonDir">, plan: IssueWorktree, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<void> {
	if (await inspectIssueWorktree(git, plan, signal, run) === "ready") return;
	const existing = await run(["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`], git.root, signal);
	if (existing.code !== 0 && existing.code !== 1) throw new Error("No se pudo verificar la rama guardada");
	if (existing.code === 0) {
		const tip = await run(["rev-parse", "--verify", `refs/heads/${plan.branch}^{commit}`], git.root, signal);
		if (tip.code !== 0 || tip.stdout.trim() !== plan.baseCommit) throw new Error(`La rama ${plan.branch} cambió desde la preparación interrumpida. No se reseteó ni se creó otro worktree.`);
	}
	await addIssueWorktree(git, plan, existing.code === 1, signal, run);
}
async function addIssueWorktree(git: Pick<GitSnapshot, "root">, plan: IssueWorktree, newBranch: boolean, signal: AbortSignal | undefined, run: WorktreeCommand): Promise<void> {
	signal?.throwIfAborted();
	await available(plan.worktree);
	await mkdir(dirname(plan.worktree), { recursive: true });
	// SHA fijado, no HEAD ni una referencia que pueda moverse durante el checkout. Sin --force.
	const args = newBranch ? ["worktree", "add", "-b", plan.branch, "--", plan.worktree, plan.baseCommit] : ["worktree", "add", "--", plan.worktree, plan.branch];
	const result = await run(args, git.root, signal);
	if (result.code !== 0) throw new Error(`No se pudo crear el worktree: ${safeText(result.stderr).slice(0, 1500)}. Revisá git worktree list antes de reintentar; no se borró ni reseteó nada.`);
}
export async function createPlannedIssueWorktree(git: Pick<GitSnapshot, "root">, plan: IssueWorktree, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<void> {
	await addIssueWorktree(git, plan, true, signal, run);
}
export async function createIssueWorktree(git: Pick<GitSnapshot, "root" | "mainRoot">, issue: { number: number; title: string }, type: IssueType, signal?: AbortSignal, run: WorktreeCommand = gitCommand): Promise<IssueWorktree> {
	const plan = await planIssueWorktree(git, issue, type, signal, run);
	await createPlannedIssueWorktree(git, plan, signal, run);
	return plan;
}
