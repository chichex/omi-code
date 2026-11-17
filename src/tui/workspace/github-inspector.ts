// Carga del detalle GitHub y preparación local; los modales conservan el renderer del workspace.
// Enter en un issue no prepara nada: pide al harness empezar o retomar, y el harness pide el sí.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGithubDetail, type GithubItem, type GitSnapshot } from "./data.ts";
import { githubDetail, type InfoDetail } from "./details.ts";
import { assertIssueIdentity, readIssuePreparation, verifyIssuePreparation, type IssuePreparationEntry } from "./issue-registry.ts";
import { notice } from "./modals.ts";
import type { WorkspaceView } from "./navigation.ts";
import { requestDevelopmentBegin } from "../development-tickets.ts";
interface GithubList { items: GithubItem[] | undefined; selected: number }
interface InspectorOptions {
 state: () => { ctx: ExtensionContext; git: GitSnapshot | undefined; github: Record<"issues" | "prs", GithubList>; view: WorkspaceView; preparations: Map<number, IssuePreparationEntry>; preparationsError: string | undefined };
 active: () => boolean; gitIdentity: () => string; changed: () => void; modalBusy: () => boolean;
 signal: AbortSignal; offline: boolean | undefined; pi: ExtensionAPI; info: (detail: InfoDetail) => Promise<boolean>;
 /** El trabajo sigue en el chat: ahí se ven el sí, los avisos y el agente. */
 onBegin: () => void;
}
export class GithubInspector {
 busy = false;
 private options: InspectorOptions;
 constructor(options: InspectorOptions) { this.options = options; }
 async show(kind: "issues" | "prs"): Promise<void> {
  const { git, github, preparations, ctx } = this.options.state();
  const { active, gitIdentity, changed, info, pi } = this.options;
  const item = github[kind].items?.[github[kind].selected]; const snapshot = git;
  if (!item || !snapshot || this.busy || this.options.modalBusy() || !active() || !ctx.isProjectTrusted()) return;
  this.busy = true; const identity = gitIdentity(); changed();
  const current = () => active() && identity === gitIdentity() && this.options.state().view === kind && this.options.state().github[kind].items?.[this.options.state().github[kind].selected]?.number === item.number;
  try {
   const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(6000)]);
   let saved = kind === "issues" ? preparations.get(item.number) : undefined;
   if (kind === "issues") {
    try { const record = await readIssuePreparation(snapshot, item.number); if (record) saved = { record }; }
    catch (error) { saved = { error: error instanceof Error ? error.message : "Registro local no disponible" }; }
    if (saved?.record) {
     try { assertIssueIdentity(saved.record, item); if (saved.record.phase === "ready") await verifyIssuePreparation(snapshot, saved.record, signal); }
     catch (error) { saved = { ...saved, error: error instanceof Error ? error.message : "Preparación no disponible" }; }
    }
    // Tras los await, un refresco local pudo reemplazar el Map y el error: se escribe en los vigentes.
    const live = this.options.state();
    if (!saved && live.preparationsError) saved = { error: live.preparationsError };
    if (saved) live.preparations.set(item.number, saved);
   }
   let body = saved?.record?.source.body ?? ""; let staleBody = false;
   try {
    if (this.options.offline) throw new Error("Offline");
    body = await readGithubDetail(snapshot, kind === "issues" ? "issue" : "pr", item.number, signal);
   } catch (error) { if (!saved) throw error; staleBody = true; }
   if (!current()) return;
   const start = await info(githubDetail({ kind, item, saved, body, staleBody }));
   if (start && kind === "issues" && current()) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) ctx.ui.notify("El trabajo requiere una sesión persistente. Volvé a abrir OMI sin --no-session.", "warning");
    else { this.options.onBegin(); requestDevelopmentBegin(pi, sessionFile, { issue: item.number }); }
   }
  } catch { if (current()) await info({ title: "GitHub · detalle no disponible", content: [notice("Revisá gh, autenticación o red. El detalle también puede ser demasiado grande.", "warning")], options: { color: "warning", subtitle: "GitHub · no se pudo cargar el detalle" } }); }
  finally { this.busy = false; changed(); }
 }
}
