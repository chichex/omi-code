import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { readCommand, type GitSnapshot, type ReadCommand } from "./data.ts";
import { fit } from "./presentation.ts";

export interface BranchPullRequest { number: number; title: string; url: string; draft: boolean; state: "OPEN" | "CLOSED" | "MERGED" }
/** gh resuelve el PR de la rama y su remoto, incluidos forks; no se infiere de la lista limitada del repo. */
export async function readBranchPullRequest(git: GitSnapshot, signal?: AbortSignal, run: ReadCommand = readCommand): Promise<BranchPullRequest | undefined> {
	if (git.detached) return undefined;
	const result = await run("gh", ["pr", "status", "--json", "number,title,url,isDraft,state"], git.root, signal);
	if (result.code !== 0 || result.truncated) throw new Error("PR no disponible");
	const raw: unknown = JSON.parse(result.stdout);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Respuesta de PR no válida");
	const value = (raw as Record<string, unknown>).currentBranch;
	if (value == null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("PR no válido");
	const item = value as Record<string, unknown>;
	if (!Number.isSafeInteger(item.number) || Number(item.number) <= 0 || typeof item.title !== "string" || typeof item.url !== "string" || /[\x00-\x20\x7f-\x9f]/.test(item.url)
		|| !["OPEN", "CLOSED", "MERGED"].includes(String(item.state))) throw new Error("PR no válido");
	const url = new URL(item.url);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.pathname.endsWith(`/pull/${item.number}`)) throw new Error("URL de PR no válida");
	return { number: Number(item.number), title: item.title, url: url.href, draft: item.isDraft === true, state: item.state as BranchPullRequest["state"] };
}

export interface FooterStatus { line: string; hintStart: number; prStart?: number; prEnd?: number }
/** Reservar el enlace antes de recortar la rama, sin perder el contexto en panes angostos. */
export function footerStatus(theme: Theme, left: string, hint: string, width: number, pr?: BranchPullRequest, stale = false): FooterStatus {
	width = Math.max(0, width);
	const rightWidth = Math.min(visibleWidth(hint), Math.floor(width * .48));
	const label = pr ? `PR #${pr.number}${stale ? "*" : ""} ↗` : "";
	const showLink = pr && visibleWidth(label) + 3 <= width - rightWidth - 1;
	const linkWidth = showLink ? visibleWidth(label) + 3 : 0;
	const leftWidth = Math.max(0, width - rightWidth - (width ? 1 : 0) - linkWidth);
	const link = showLink ? ` · ${hyperlink(theme.fg(stale ? "warning" : "accent", label), pr.url)}` : "";
	return {
		line: fit(left, leftWidth) + link + (width ? " " : "") + theme.fg("muted", fit(hint, rightWidth)), hintStart: width - rightWidth,
		...(showLink ? { prStart: leftWidth + 3, prEnd: leftWidth + linkWidth } : {}),
	};
}
