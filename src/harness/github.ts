// Remote text is data, never shell code or development instructions. Command output stays local:
// nobody reviews it before publishing and it may print credentials.
import { processRunner, type CommandOptions, type Runner } from "../core/exec.ts";
import { gitRead, inspectCheckout } from "./git.ts";
import { issueRepository, sourceHash, type Workflow } from "./model.ts";
import { pullRequestBody } from "./pr-body.ts";
import { ISSUE_BODY_LIMIT, issueSectionVariants, parseIssueBody, withIssueSection, type IssueBody } from "./issue-section.ts";
import { pullRequestTitle } from "./pr-title.ts";

const START = "<!-- omi-development:start -->";
const END = "<!-- omi-development:end -->";
type Checkout = Workflow["checkout"];
export type Published = { number: number; url: string; head: string };
// Un PR del stack de la publicación (index desde 0) y el número del de abajo, ya abierto.
export interface StackPosition { index: number; below?: number }
type Target = { branch: string; base: string; head: string; body: string };
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Respuesta JSON de GitHub inválida");
 return Object.fromEntries(Object.entries(value));
}
function originalBody(body: string): string {
 const starts = body.split(START).length - 1; const ends = body.split(END).length - 1;
 const markers = body.match(/<!--\s*omi-development:[\s\S]*?-->/g) ?? [];
 const prefixes = body.match(/<!--\s*omi-development:/g) ?? [];
 if (prefixes.length !== starts + ends || markers.length !== prefixes.length || markers.some(marker => marker !== START && marker !== END) || starts !== ends || starts > 1 || (starts === 1 && body.indexOf(END) < body.indexOf(START))) throw new Error("Sección administrada malformada o duplicada; requiere revisión humana");
 if (!starts) return body;
 return body.slice(0, body.indexOf(START)) + body.slice(body.indexOf(END) + END.length);
}
export async function gh(checkout: Checkout, args: string[], runner: Runner, signal?: AbortSignal, input?: string): Promise<string> {
 signal?.throwIfAborted();
 const options: CommandOptions = { cwd: checkout.root, env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) };
 const result = await runner.run("gh", args, options); signal?.throwIfAborted();
 if (result.code !== 0) throw new Error(`GitHub no pudo completar ${args[0]} ${args[1]}; verificar el estado antes de reintentar`);
 return result.stdout;
}
async function readIssue(checkout: Checkout, number: number, runner: Runner, signal?: AbortSignal): Promise<{ source: Workflow["source"]; raw: string; parts: IssueBody }> {
 if (!Number.isSafeInteger(number) || number < 1) throw new Error("Número de issue inválido");
 const data = object(JSON.parse(await gh(checkout, ["issue", "view", String(number), "--json", "number,title,body,url"], runner, signal)));
 if (data.number !== number || typeof data.title !== "string" || !data.title.trim() || data.title.length > 2000 || typeof data.body !== "string" || data.body.length > 200000 || typeof data.url !== "string") throw new Error("Fuente del issue inválida; no se infieren campos");
 // La sección administrada del harness no es parte del pedido: escribirla no invalida el trabajo.
 issueRepository(data.url, number); const parts = parseIssueBody(data.body); const body = originalBody(parts.human);
 if (body.length > 100000) throw new Error("Pedido original demasiado grande");
 return { source: { number, title: data.title, body, url: data.url, hash: sourceHash(data.title, body) }, raw: data.body, parts };
}
export async function readIssueSource(checkout: Checkout, number: number, runner: Runner = processRunner, signal?: AbortSignal): Promise<Workflow["source"]> {
 return (await readIssue(checkout, number, runner, signal)).source;
}
// GitHub no ofrece CAS para el cuerpo del issue: se relee justo antes de escribir y se reemplaza sólo
// lo que está entre los marcadores. Riesgo residual: una edición humana que cae entre esa lectura y
// la escritura se pierde del cuerpo (GitHub la conserva en el historial de ediciones del issue).
// onlyIfPresent: sin receta aprobada, sólo se mantiene una sección que ya autorizó una aprobación anterior.
export async function syncIssueSection(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal, options: { onlyIfPresent?: boolean } = {}): Promise<boolean> {
 const repo = issueRepository(workflow.source.url, workflow.source.number);
 const fresh = await readIssue(workflow.checkout, workflow.source.number, runner, signal);
 if (fresh.source.url !== workflow.source.url || fresh.source.hash !== workflow.source.hash) throw new Error("El pedido cambió en GitHub desde el último contraste; la sección se actualiza después del próximo punto de control");
 if (options.onlyIfPresent && fresh.parts.section === null) return false;
 // Si no entra junto al pedido, la sección se resume y lo dice; el pedido nunca se toca.
 const content = issueSectionVariants(workflow).find((c) => withIssueSection(fresh.raw, fresh.parts, c).length <= ISSUE_BODY_LIMIT);
 if (!content) throw new Error("El pedido ocupa casi todo el límite de GitHub para el cuerpo del issue; la sección del harness no entra");
 const body = withIssueSection(fresh.raw, fresh.parts, content);
 if (body === fresh.raw) return false;
 await gh(workflow.checkout, ["issue", "edit", String(workflow.source.number), "--repo", repo, "--body-file", "-"], runner, signal, body);
 // No se reintenta solo: una escritura sin confirmar se revisa en GitHub.
 if ((await readIssue(workflow.checkout, workflow.source.number, runner, signal)).parts.section !== `\n${content}\n`) throw new Error("No se pudo confirmar la sección del harness en el issue; revisalo en GitHub antes de reintentar");
 return true;
}
// Sólo el cuerpo del recibo pendiente: un recibo de otro cuerpo (formato anterior u otro estado) no se publica
// ni con su cuerpo ni con el nuevo; la sesión lo renueva según push_pr antes de llegar acá. Sin position, el
// PR único; con position, ese PR del stack, con su head, su Refs o Closes y su línea del stack.
export function renderPullRequestBody(workflow: Workflow, position?: StackPosition): string {
 if (workflow.publication.status !== "pending") throw new Error("No hay una publicación pendiente");
 const stack = position && workflow.publication.stack; const pull = stack && stack[position.index];
 if (position && !pull) throw new Error("PR inexistente en el stack de la publicación");
 const place = stack && position ? { pulls: stack, index: position.index, ...(position.below === undefined ? {} : { below: position.below }) } : undefined;
 const proposal = pullRequestBody(workflow, pull ? pull.head : workflow.publication.head, place);
 if (proposal.bodyHash !== workflow.publication.bodyHash) throw new Error("El cuerpo del PR cambió desde el recibo pendiente; volvé a publicar para renovarlo con la política push_pr vigente");
 return proposal.body;
}
function remoteRepo(remote: string): string {
 const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
 if (!match) throw new Error("Remote origin no es una identidad GitHub admitida");
 return match[1]!;
}
export async function assertRepository(workflow: Workflow, runner: Runner, signal?: AbortSignal): Promise<string> {
 const repo = issueRepository(workflow.source.url, workflow.source.number);
 const remotes = (await gitRead(workflow.checkout, ["remote", "get-url", "--push", "--all", "origin"], runner, signal)).trim().split("\n");
 if (remotes.length !== 1 || remoteRepo(remotes[0]!).toLowerCase() !== repo.toLowerCase()) throw new Error("Remote origin no coincide con el repositorio del issue");
 const data = object(JSON.parse(await gh(workflow.checkout, ["repo", "view", "--json", "nameWithOwner,url"], runner, signal)));
 if (data.nameWithOwner !== repo || data.url !== `https://github.com/${repo}`) throw new Error("gh apunta a otro repositorio");
 return repo;
}
async function recover(workflow: Workflow, repo: string, target: Target, runner: Runner, signal?: AbortSignal): Promise<Published | null> {
 const raw: unknown = JSON.parse(await gh(workflow.checkout, ["pr", "list", "--repo", repo, "--state", "all", "--head", target.branch, "--base", target.base, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,body", "--limit", "100"], runner, signal));
 if (!Array.isArray(raw)) throw new Error("Lista de PRs inválida");
 if (!raw.length) return null;
 if (raw.length !== 1) throw new Error("Hay varios PRs para el branch; requiere revisión humana");
 const pr = object(raw[0]);
 if (workflow.publication.status !== "pending" || pr.state !== "OPEN" || pr.isDraft !== true || pr.isCrossRepository !== false || pr.headRefName !== target.branch || pr.baseRefName !== target.base || pr.headRefOid !== target.head || pr.body !== target.body || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.url !== `https://github.com/${repo}/pull/${pr.number}`) throw new Error("PR existente ajeno, editado, de una publicación anterior, cerrado, no draft o con otro HEAD; no se edita ni se duplica: revisalo en GitHub");
 return { number: pr.number, url: String(pr.url), head: String(pr.headRefOid) };
}
/** Sólo lectura: el draft del PR único que ya abrió este recibo pendiente. Sin push ni create; ajeno o editado falla. */
export async function findPublishedDraft(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<Published | null> {
 const body = renderPullRequestBody(workflow); if (workflow.publication.status !== "pending") throw new Error("No hay una publicación pendiente");
 const repo = await assertRepository(workflow, runner, signal);
 return recover(workflow, repo, { branch: workflow.checkout.branch, base: "main", head: workflow.publication.head, body }, runner, signal);
}
// Con position, publica ese PR del stack con las mismas validaciones: su rama, su base y el commit de su grupo.
// HEAD sigue siendo el de arriba, el verificado: el checkout no puede moverse mientras se publica el stack.
export async function publishDraft(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal, position?: StackPosition): Promise<Published> {
 if (workflow.phase !== "pr" || workflow.publication.status !== "pending" || !workflow.approval || workflow.approval.sourceHash !== workflow.source.hash) throw new Error("Publicación draft no aprobada o no pendiente");
 const body = renderPullRequestBody(workflow, position);
 const stack = position && workflow.publication.stack; const pull = stack && stack[position.index];
 const head = pull ? pull.head : workflow.publication.head;
 if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error("SHA de publicación inválido");
 const branch = pull ? pull.branch : workflow.checkout.branch; const base = pull ? pull.base : "main";
 const title = pullRequestTitle(workflow, position);
 const target = { branch, base, head, body };
 if ([branch, base].some(b => !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(b) || b.includes("..") || b.includes("//") || b.endsWith("/") || b.endsWith(".") || b.split("/").some(p => p.startsWith(".") || p.endsWith(".lock")))) throw new Error("Branch no válido para publicación");
 const assertHead = async () => { const snapshot = await inspectCheckout(workflow.checkout, runner, signal); if (workflow.publication.status !== "pending" || !snapshot.clean || snapshot.head !== workflow.publication.head) throw new Error("HEAD de publicación cambió o checkout sucio"); };
 await assertHead(); const repo = await assertRepository(workflow, runner, signal);
 const fresh = await readIssueSource(workflow.checkout, workflow.source.number, runner, signal);
 if (fresh.hash !== workflow.source.hash || fresh.url !== workflow.source.url) throw new Error("El pedido cambió antes de publicar");
 const existing = await recover(workflow, repo, target, runner, signal); if (existing) return existing;
 // Revalidate immediately before the write; push the approved immutable object even if HEAD races afterwards.
 await assertHead();
 // Only this branch, no force, no tags and no destination inferred from git config.
 try {
  await gitRead(workflow.checkout, ["push", "--no-follow-tags", "origin", `${head}:refs/heads/${branch}`], runner, signal);
 } catch {
  signal?.throwIfAborted(); const found = await recover(workflow, repo, target, runner, signal); if (found) return found;
  throw new Error("git push de la rama falló: revisá autenticación, rama protegida o non-fast-forward antes de volver a publicar");
 }
 await assertHead();
 try {
  await gh(workflow.checkout, ["pr", "create", "--repo", repo, "--draft", "--base", base, "--head", branch, "--title", title, "--body-file", "-"], runner, signal, body);
 } catch (error) { signal?.throwIfAborted(); const found = await recover(workflow, repo, target, runner, signal); if (found) return found; throw error; }
 const created = await recover(workflow, repo, target, runner, signal);
 if (!created) throw new Error("No se pudo confirmar el PR creado; recuperar por branch antes de reintentar");
 return created;
}
