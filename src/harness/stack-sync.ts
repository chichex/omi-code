// Actualizar un stack publicado: lleva los cambios de cada PR al de arriba con un commit de merge y push
// normal, y re-apunta a main el que quedó sobre un PR mergeado. Nunca rebase, force push ni merge de PRs.
// Los merges se calculan con `git merge-tree` y `git commit-tree`: escriben objetos, no el worktree ni su
// índice, así que el checkout del trabajo no cambia. Todo se calcula antes de la primera escritura remota.
import { processRunner, type Runner } from "../core/exec.ts";
import { gitRead } from "./git.ts";
import { assertRepository, gh } from "./github.ts";
import type { StackPull, Workflow } from "./model.ts";
import { DEFAULT_BASE } from "./stack.ts";

export interface StackSyncResult { stack: StackPull[]; actions: string[] }
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const STATES = ["OPEN", "MERGED", "CLOSED"] as const;
interface RemotePull { state: typeof STATES[number]; isDraft: boolean; base: string; head: string; mergeCommit: string | null }
// Lo de abajo del PR que se está mirando: la rama de su base y, si el de abajo ya está en main, su punta final.
interface Below { branch: string; head: string; landed?: { number: StackPull["number"]; head: string; commit: string | null } }

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
async function readPull(w: Workflow, repo: string, pull: StackPull, runner: Runner, signal?: AbortSignal): Promise<RemotePull> {
	const data = record(JSON.parse(await gh(w.checkout, ["pr", "view", String(pull.number), "--repo", repo, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,mergeCommit"], runner, signal)));
	const merge = data?.mergeCommit === null ? null : record(data?.mergeCommit)?.oid;
	const state = STATES.find((s) => s === data?.state);
	if (!data || !state || data.number !== pull.number || data.url !== pull.url || data.headRefName !== pull.branch || data.isCrossRepository !== false || typeof data.isDraft !== "boolean" || typeof data.baseRefName !== "string" || typeof data.headRefOid !== "string" || !SHA.test(data.headRefOid) || (merge !== null && (typeof merge !== "string" || !SHA.test(merge))))
		throw new Error(`El PR #${pull.number} del stack no coincide con lo publicado (rama, repo o datos); requiere revisión humana`);
	return { state, isDraft: data.isDraft, base: data.baseRefName, head: data.headRefOid, mergeCommit: merge ?? null };
}
async function git(w: Workflow, args: string[], runner: Runner, signal?: AbortSignal): Promise<{ code: number; stdout: string }> {
	signal?.throwIfAborted();
	const result = await runner.run("git", ["-c", "core.fsmonitor=false", "-C", w.checkout.root, ...args], { env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }, ...(signal ? { signal } : {}) });
	signal?.throwIfAborted();
	return result;
}
async function contains(w: Workflow, ancestor: string, head: string, runner: Runner, signal?: AbortSignal): Promise<boolean> {
	const { code } = await git(w, ["merge-base", "--is-ancestor", ancestor, head], runner, signal);
	if (code > 1) throw new Error("Git no pudo comparar commits del stack");
	return code === 0;
}
// Un commit de merge de verdad (dos padres: el PR y lo que se le trae). base fija la base del merge de tres vías.
async function merge(w: Workflow, head: string, other: string, message: string, runner: Runner, signal?: AbortSignal, base?: string): Promise<string> {
	const tree = await git(w, ["merge-tree", "--write-tree", ...(base ? [`--merge-base=${base}`] : []), head, other], runner, signal);
	if (tree.code === 1) throw new Error(`${message}: hay un conflicto. Resolvelo a mano con git merge (sin rebase ni force push), subilo y volvé a actualizar el stack`);
	const oid = tree.stdout.split("\n")[0]?.trim() ?? "";
	if (tree.code !== 0 || !SHA.test(oid)) throw new Error("Git no pudo calcular el merge del stack (requiere Git 2.40 o superior)");
	const commit = (await gitRead(w.checkout, ["commit-tree", oid, "-p", head, "-p", other, "-m", message], runner, signal)).trim();
	if (!SHA.test(commit)) throw new Error("Git no devolvió el commit de merge del stack");
	return commit;
}
// Lo que hay en GitHub: cada PR, la punta de main y sus commits ya traídos al repo local.
async function readRemote(workflow: Workflow, pulls: StackPull[], runner: Runner, signal?: AbortSignal): Promise<{ repo: string; main: string; remote: RemotePull[] }> {
	const repo = await assertRepository(workflow, runner, signal);
	const remote: RemotePull[] = [];
	for (const pull of pulls) remote.push(await readPull(workflow, repo, pull, runner, signal));
	const heads = (await gitRead(workflow.checkout, ["ls-remote", "origin", `refs/heads/${DEFAULT_BASE}`], runner, signal)).trim().split("\n");
	const main = heads.length === 1 ? heads[0]!.split("\t")[0]! : "";
	if (!SHA.test(main)) throw new Error(`No se pudo leer ${DEFAULT_BASE} en GitHub`);
	// refs/pull/N/head sigue existiendo aunque se borre la rama de un PR mergeado.
	await gitRead(workflow.checkout, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "origin", `refs/heads/${DEFAULT_BASE}`, ...pulls.map((p) => `refs/pull/${p.number}/head`)], runner, signal);
	for (const oid of [main, ...remote.flatMap((r) => [r.head, ...(r.mergeCommit ? [r.mergeCommit] : [])])]) {
		if ((await git(workflow, ["cat-file", "-e", `${oid}^{commit}`], runner, signal)).code !== 0) throw new Error(`No se pudo traer el commit ${oid.slice(0, 7)} de GitHub; volvé a actualizar el stack`);
	}
	return { repo, main, remote };
}
// La punta que tiene que tener un PR abierto para contener lo de abajo, con los merges que hagan falta.
async function updatedHead(workflow: Workflow, pull: StackPull, head: string, below: Below, main: string, runner: Runner, signal?: AbortSignal): Promise<string> {
	const has = (ancestor: string, tip: string) => contains(workflow, ancestor, tip, runner, signal);
	if (!below.landed) return below.branch === DEFAULT_BASE || await has(below.head, head) ? head : merge(workflow, head, below.head, `Merge ${below.branch} into ${pull.branch}`, runner, signal);
	// El de abajo ya está en main, quizás con squash: primero su punta final y después main, con esa
	// punta como base del merge. Así sus propios cambios, que main trae aplastados, no chocan.
	const landed = below.landed;
	let tip = await has(landed.head, head) ? head : await merge(workflow, head, landed.head, `Merge PR #${landed.number} into ${pull.branch}`, runner, signal);
	const synced = landed.commit ? await has(landed.commit, tip) : false;
	if (!synced && !(await has(main, tip))) tip = await merge(workflow, tip, main, `Merge ${DEFAULT_BASE} into ${pull.branch}`, runner, signal, landed.head);
	return tip;
}
export async function syncStack(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<StackSyncResult> {
	const pulls = workflow.publication.status === "opened" ? workflow.publication.stack : undefined;
	if (!pulls) throw new Error("Este trabajo no publicó un stack de PRs");
	if (pulls.some((p) => p.number === null || p.url === null)) throw new Error("El stack publicado tiene PRs sin número; requiere revisión humana");
	const { repo, main, remote } = await readRemote(workflow, pulls, runner, signal);
	// De abajo hacia arriba, sin escribir en GitHub: un conflicto o un PR inesperado frena antes de cualquier push.
	const next: StackPull[] = []; const writes: { pull: StackPull; from: string; head: string; fromBase: string; base: string }[] = [];
	let below: Below = { branch: DEFAULT_BASE, head: main };
	for (const [i, pull] of pulls.entries()) {
		const r = remote[i]!;
		if (r.state === "CLOSED") throw new Error(`El PR #${pull.number} del stack está cerrado sin mergear: el stack requiere una persona`);
		if (r.state === "MERGED") {
			if (r.base !== DEFAULT_BASE) throw new Error(`El PR #${pull.number} se mergeó en ${r.base}, no en ${DEFAULT_BASE}: el stack requiere una persona`);
			next.push({ ...pull, base: DEFAULT_BASE, head: r.head, status: "merged" });
			below = { branch: DEFAULT_BASE, head: main, landed: { number: pull.number, head: r.head, commit: r.mergeCommit } }; continue;
		}
		if (!(await contains(workflow, pull.head, r.head, runner, signal))) throw new Error(`La rama ${pull.branch} se reescribió: no contiene el commit publicado. No se mergea sobre una historia ajena; requiere una persona`);
		const head = await updatedHead(workflow, pull, r.head, below, main, runner, signal);
		writes.push({ pull, from: r.head, head, fromBase: r.base, base: below.branch });
		next.push({ ...pull, head, base: below.branch, status: r.isDraft ? "draft" : "open" });
		below = { branch: pull.branch, head };
	}
	const actions: string[] = [];
	for (const w of writes) {
		if (w.head !== w.from) {
			try { await gitRead(workflow.checkout, ["push", "--no-follow-tags", "origin", `${w.head}:refs/heads/${w.pull.branch}`], runner, signal); }
			catch { signal?.throwIfAborted(); throw new Error(`git push de ${w.pull.branch} fue rechazado: la rama cambió en GitHub o está protegida. Volvé a actualizar el stack; nunca se fuerza`); }
			actions.push(`${w.pull.branch}: merge y push normal (${w.from.slice(0, 7)} → ${w.head.slice(0, 7)})`);
		}
		if (w.base !== w.fromBase) {
			await gh(workflow.checkout, ["pr", "edit", String(w.pull.number), "--repo", repo, "--base", w.base], runner, signal);
			actions.push(`#${w.pull.number}: base ${w.fromBase} → ${w.base}`);
		}
	}
	return { stack: next, actions };
}
