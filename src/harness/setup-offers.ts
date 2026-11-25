// Marcadores de ofertas de sesión nueva. Nunca son una aceptación, una postergación ni un permiso.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../core/paths.ts";
import type { TrustKey } from "./foundations-trust.ts";

export type SetupOfferArea = "foundations" | "lifecycle";

/** Se llama justo antes del primer diálogo. Sin ceder el turno entre la última guarda y la creación exclusiva. */
export function claimSetupOffer(home: string, key: TrustKey, area: SetupOfferArea, revision: string): boolean {
	try {
		const dir = join(agentDir(home), "setup-offers");
		const id = createHash("sha256").update(JSON.stringify([key.kbUrl, key.product, key.repo, area, revision])).digest("hex");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!lstatSync(dir).isDirectory()) return false;
		// Un archivo vacío basta; EEXIST (también para un enlace) o cualquier error impiden la oferta.
		writeFileSync(join(dir, id), "", { flag: "wx", mode: 0o600 });
		return true;
	} catch { return false; }
}
