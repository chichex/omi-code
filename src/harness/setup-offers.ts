// Marcadores de ofertas de sesión nueva. Nunca son una aceptación, una postergación ni un permiso.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../core/paths.ts";
import type { TrustKey } from "./foundations-trust.ts";

export type SetupOfferArea = "foundations" | "lifecycle";
/** Una oferta reclamada. `release` la devuelve si su diálogo no llegó a mostrarse. */
export interface SetupOfferClaim { release(): void }

/** Se llama justo antes del primer diálogo. Sin ceder el turno entre la última guarda y la creación exclusiva.
 * Falla cerrado: un error de FS impide la oferta automática, y /omi-setup sigue. */
export function claimSetupOffer(home: string, key: TrustKey, area: SetupOfferArea, revision: string): SetupOfferClaim | undefined {
	try {
		const dir = join(agentDir(home), "setup-offers");
		const id = createHash("sha256").update(JSON.stringify([key.kbUrl, key.product, key.repo, area, revision])).digest("hex");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!lstatSync(dir).isDirectory()) return undefined;
		// Un archivo vacío basta; EEXIST (también para un enlace) o cualquier error impiden la oferta.
		const path = join(dir, id);
		writeFileSync(path, "", { flag: "wx", mode: 0o600 });
		const mine = lstatSync(path);
		let held = true;
		return { release: () => {
			// Una sola vez y sólo la marca propia: liberada, otro proceso pudo tomar la misma oferta.
			if (!held) return;
			held = false;
			try {
				const now = lstatSync(path);
				if (now.dev === mine.dev && now.ino === mine.ino) unlinkSync(path);
			} catch { /* La marca queda: esa oferta automática se pierde. */ }
		} };
	} catch { return undefined; }
}
