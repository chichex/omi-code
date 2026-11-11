// Snapshots de sesión: leer sin migrar/reparar y publicar completos, nunca reemplazar conversaciones.
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { FileEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export async function readSessionSnapshot(sessionFile: string, signal?: AbortSignal): Promise<SessionManager> {
	signal?.throwIfAborted();
	const info = await lstat(sessionFile);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error(`No se puede verificar la sesión guardada: ${sessionFile}`);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const entries: FileEntry[] = []; const ids = new Set<string>();
	try {
		for (const line of (await readFile(sessionFile, { encoding: "utf8", signal })).split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as FileEntry;
			if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string" || typeof entry.timestamp !== "string") throw new Error("Entrada inválida");
			if (entries.length && (entry.type === "session" || ids.has(entry.id) || entry.parentId !== null && !ids.has(entry.parentId))) throw new Error("Árbol de sesión inválido");
			if (entry.type !== "session") ids.add(entry.id);
			entries.push(entry);
		}
	} catch { signal?.throwIfAborted(); throw new Error(`JSONL o árbol de sesión inválido: ${sessionFile}. Recuperá el archivo antes de retomar; no se reemplazó nada.`); }
	const header = entries[0];
	if (header?.type !== "session" || header.version !== 3 || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) throw new Error(`Header de sesión inválido: ${sessionFile}`);
	signal?.throwIfAborted();
	return SessionManager.inMemory(header.cwd, {}, entries);
}
export async function publishSessionSnapshot(session: SessionManager, sessionFile: string): Promise<void> {
	await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
	const temporary = `${sessionFile}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile([session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n"); await handle.sync(); }
		finally { await handle.close(); }
		await link(temporary, sessionFile);
	} finally { await rm(temporary, { force: true }); }
}
