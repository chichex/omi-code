// /omi-permitidos: ver y quitar los prefijos de «no volver a preguntar» del repo, en esta máquina.
// Quitar uno pide un sí. Agregarlos sólo se hace desde el diálogo de autorizar un comando simple.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prefixLabel } from "../harness/command-allow.ts";
import { visibleText } from "../harness/foundations.ts";
import type { FoundationsGate } from "./development-foundations.ts";

const CLOSE = "Cerrar";
/** true si quitó un prefijo. Sin repo conocido o sin prefijos, sólo avisa. */
export async function manageAllowedPrefixes(ctx: ExtensionContext, gate: FoundationsGate): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("/omi-permitidos necesita la TUI interactiva.");
	const allowed = await gate.allowed(ctx);
	if (!allowed) { ctx.ui.notify("No se sabe de qué repo es esta sesión: hace falta un origin en github.com con producto en la KB. No hay comandos permitidos.", "info"); return false; }
	const repo = visibleText(allowed.key.repo);
	if (!allowed.prefixes.length) { ctx.ui.notify(`No hay comandos que no vuelvan a preguntar en ${repo}. Se agregan con «Sí, y no volver a preguntar» al autorizar un comando simple.`, "info"); return false; }
	const labels = allowed.prefixes.map((prefix) => visibleText(prefixLabel(prefix)));
	const choice = await ctx.ui.select(`No vuelven a preguntar en ${repo}, en esta máquina. Elegí uno para quitarlo:`, [...labels, CLOSE]);
	const prefix = choice === undefined ? undefined : allowed.prefixes[labels.indexOf(choice)];
	if (prefix === undefined) return false;
	const label = visibleText(prefixLabel(prefix));
	if (!(await ctx.ui.confirm(`Quitar «${label}»`, `Los comandos que empiezan con «${visibleText(prefix)}» vuelven a pedir tu sí cuando coincidan con una regla de Foundations. No cambia la KB.`))) return false;
	await gate.disallow(ctx, prefix);
	ctx.ui.notify(`Quitado «${label}» de ${repo}.`, "info");
	return true;
}
