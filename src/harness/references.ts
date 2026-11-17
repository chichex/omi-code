// Recibos de lectura locales: sólo un digest; el contenido nunca se agrega a auditoría.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
export interface ReadReceipt { digest: string; ranges: [number, number][] }
export async function referenceDigest(path: string): Promise<string | undefined> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) return;
		const bytes = Buffer.alloc(1024 * 1024 + 1); let size = 0;
		while (size < bytes.length) { const next = await file.read(bytes, size, bytes.length - size, null); if (!next.bytesRead) break; size += next.bytesRead; }
		const after = await file.stat();
		if (size > 1024 * 1024 || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) return;
		return createHash("sha256").update(bytes.subarray(0, size)).digest("hex");
	} finally { await file.close(); }
}
