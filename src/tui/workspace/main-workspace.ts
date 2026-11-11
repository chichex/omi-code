// Volver al checkout principal reemplazando la sesión real. Nunca ejecutar checkout/reset/stash.
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInside } from "../../core/files.ts";
import { readGit, safeText, type GitSnapshot } from "./data.ts";
import { publishSessionSnapshot, readSessionSnapshot } from "./session-files.ts";
import { registeredIssueWorktrees } from "./issue-worktree.ts";

export interface PrincipalSession { sessionFile: string; cwd: string; created: boolean; branch: string; detached: boolean }
export interface PrincipalSessionOptions { sessionDir?: string; signal: AbortSignal; isCurrent: () => boolean }
export class PrincipalSessionBusyError extends Error {}
export async function preparePrincipalSession(git: GitSnapshot, ctx: ExtensionContext, options: PrincipalSessionOptions): Promise<PrincipalSession> {
	const current = () => { options.signal.throwIfAborted(); if (!options.isCurrent()) throw new Error("La sesión cambió mientras se buscaba el repo principal"); };
	current();
	// La primera entrada de worktree list no basta si el principal se borró o reemplazó.
	const main = await readGit(git.mainRoot, options.signal);
	if (!main || main.linked || await realpath(main.root) !== await realpath(git.mainRoot) || await realpath(main.commonDir) !== await realpath(git.commonDir)) {
		throw new Error(`No se pudo verificar el repo principal en ${git.mainRoot}. Recuperá su ubicación antes de volver; no se creó ni modificó ningún checkout.`);
	}
	if (!(await registeredIssueWorktrees(main, options.signal)).some((tree) => resolve(tree.worktree) === resolve(git.root))) throw new Error("El worktree actual ya no pertenece al repo principal. Revisá git worktree list; no se cambió nada.");
	const root = await realpath(main.root); current();
	const lock = join(git.commonDir, "omi", "main-session.lock");
	await mkdir(join(git.commonDir, "omi"), { recursive: true, mode: 0o700 });
	let handle;
	try { handle = await open(lock, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PrincipalSessionBusyError(`Otra ventana está preparando el regreso al repo principal. Reintentá al terminar. Tras un cierre abrupto, verificá el PID/host en ${lock} antes de quitar ese lock.`);
		throw error;
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }) + "\n"); current();
		const inMain = async (cwd: string): Promise<boolean> => {
			if (!isAbsolute(cwd)) return false;
			let path: string;
			try { path = await realpath(cwd); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
			if (!isInside(root, path)) return false;
			const checkout = await readGit(path, options.signal);
			return !!checkout && !checkout.linked && await realpath(checkout.root) === root && await realpath(checkout.commonDir) === await realpath(main.commonDir);
		};
		const target = (sessionFile: string, cwd: string, created = false): PrincipalSession => ({ sessionFile, cwd, created, branch: main.branch, detached: main.detached });
		// Preferir la conversación de origen, incluso si se inició en una subcarpeta del principal.
		let parent = ctx.sessionManager.getHeader?.()?.parentSession; const visited = new Set<string>();
		while (parent) {
			current();
			if (!isAbsolute(parent) || visited.has(resolve(parent)) || visited.size >= 32) throw new Error("El vínculo a la sesión de origen no es válido. Elegí la sesión del repo principal con /resume.");
			visited.add(resolve(parent));
			let session;
			try { session = await readSessionSnapshot(parent, options.signal); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
			if (await inMain(session.getCwd())) { current(); return target(parent, session.getCwd()); }
			parent = session.getHeader()?.parentSession;
		}
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sessions = options.sessionDir ? await SessionManager.listAll(options.sessionDir, undefined, options.signal) : await SessionManager.listAll(undefined, options.signal);
		// Si no hubo conversación de origen, la más reciente del principal. Nunca una del worktree.
		for (const info of sessions) {
			current();
			if (!await inMain(info.cwd)) continue;
			const session = await readSessionSnapshot(info.path, options.signal);
			if (await inMain(session.getCwd())) { current(); return target(info.path, session.getCwd()); }
		}
		current();
		const parentSession = ctx.sessionManager.getSessionFile();
		const session = SessionManager.inMemory(main.root, parentSession ? { parentSession } : {});
		if (ctx.model) session.appendModelChange(ctx.model.provider, ctx.model.id);
		if (ctx.thinkingLevel) session.appendThinkingLevelChange(ctx.thinkingLevel);
		session.appendSessionInfo(`Repo principal · ${safeText(basename(main.root))}`);
		// Header + configuración, sin copiar el contexto del issue ni inventar un mensaje humano.
		const file = SessionManager.create(main.root, options.sessionDir, { id: session.getSessionId() }).getSessionFile()!;
		await publishSessionSnapshot(session, file); current();
		return target(file, main.root, true);
	} finally { try { await handle.close(); } finally { await rm(lock, { force: true }); } }
}
