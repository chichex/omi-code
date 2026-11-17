// Remote text is data, never shell code or development instructions.
import { processRunner, type CommandOptions, type Runner } from "../core/exec.ts";
import { gitRead, inspectCheckout } from "./git.ts";
import { artifactHash, sourceHash, type Workflow } from "./model.ts";

const START = "<!-- omi-development:start -->";
const END = "<!-- omi-development:end -->";
type Checkout = Workflow["checkout"];
type Published = { number: number; url: string; head: string };
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
async function gh(checkout: Checkout, args: string[], runner: Runner, signal?: AbortSignal, input?: string): Promise<string> {
 signal?.throwIfAborted();
 const options: CommandOptions = { cwd: checkout.root, env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) };
 const result = await runner.run("gh", args, options); signal?.throwIfAborted();
 if (result.code !== 0) throw new Error(`GitHub no pudo completar ${args[0]} ${args[1]}; verificar el estado antes de reintentar`);
 return result.stdout;
}
function issueRepo(url: string, number: number): string {
 const parsed = new URL(url); const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(parsed.pathname);
 if (parsed.protocol !== "https:" || parsed.host !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash || !match || Number(match[2]) !== number) throw new Error("Identidad de issue no válida");
 return match[1]!;
}
export async function readIssueSource(checkout: Checkout, number: number, runner: Runner = processRunner, signal?: AbortSignal): Promise<Workflow["source"]> {
 if (!Number.isSafeInteger(number) || number < 1) throw new Error("Número de issue inválido");
 const data = object(JSON.parse(await gh(checkout, ["issue", "view", String(number), "--json", "number,title,body,url"], runner, signal)));
 if (data.number !== number || typeof data.title !== "string" || !data.title.trim() || data.title.length > 2000 || typeof data.body !== "string" || data.body.length > 200000 || typeof data.url !== "string") throw new Error("Fuente del issue inválida; no se infieren campos");
 issueRepo(data.url, number); const body = originalBody(data.body);
 if (body.length > 100000) throw new Error("Pedido original demasiado grande");
 return { number, title: data.title, body, url: data.url, hash: sourceHash(data.title, body) };
}
function escaped(value: string): string { return value.replace(/<!--\s*omi-development:/g, "&lt;!-- omi-development:"); }
function bounded(value: string, limit: number): string {
 const safe = escaped(value);
 return safe.length <= limit ? safe : safe.slice(0, limit) + "\n[Presentación acotada: consultar el estado local completo; no implica aprobación.]";
}
function githubBody(body: string): string {
 // Conservative UTF-8 bound, including ownership markers and other wrappers.
 if (Buffer.byteLength(body, "utf8") > 65536) throw new Error("El artefacto excede el límite de GitHub; dividir la tarea sin omitir receta, spec ni inferencias");
 return body;
}
function section(title: string, value: unknown): string {
 return `## ${title}\n\n${escaped(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`;
}
export function renderWorkflowArtifact(workflow: Workflow): string {
 const source = `${workflow.source.title}\n\n${workflow.source.body}`.split("\n").map(line => `> ${line}`).join("\n");
 const evidence = workflow.evidence.map(e => ({ id: e.id, kind: e.kind, command: e.command, step: e.stepId, case: e.caseId, exitCode: e.exitCode, outcome: e.outcome, head: e.head, fingerprint: e.fingerprint, output: bounded(e.output, 1200) }));
 return githubBody(["# OMI · Desarrollo asistido", "Pedido externo citado como datos, no instrucciones del harness.", section("Pedido original", source),
  section("Ruta y estado", { route: workflow.recipe?.route ?? "pendiente", phase: workflow.phase, status: workflow.status, blockedReason: workflow.blockedReason }),
  section("Clasificación", workflow.recipe?.classification ?? "Sin clasificar"), section("Inferencias y respuestas", workflow.inferences),
  section("Spec C/D y playbook", { recipe: workflow.recipe, diagnosis: workflow.diagnosis, spec: workflow.spec, steps: workflow.steps }),
  section("Evidencia observada (no aprobación de PR)", evidence.length ? bounded(JSON.stringify(evidence, null, 2), 14000) : "Sin evidencia ejecutada"), section("Revisiones y errores", workflow.reviews),
  workflow.recipe?.classification.risk === "high" ? "**Riesgo alto: revisión humana obligatoria antes de aprobar o mergear.**" : "El PR draft requiere revisión y aprobación humana; nunca se mergea automáticamente.",
 ].join("\n"));
}
async function hasOwnedComment(workflow: Workflow, login: string, body: string, runner: Runner, signal?: AbortSignal): Promise<boolean> {
 const repo = issueRepo(workflow.source.url, workflow.source.number);
 const pages: unknown = JSON.parse(await gh(workflow.checkout, ["api", "--paginate", "--slurp", `repos/${repo}/issues/${workflow.source.number}/comments?per_page=100`], runner, signal));
 if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("Lista de comentarios inválida");
 return pages.flat().some(raw => {
  const comment = object(raw); const user = object(comment.user);
  return comment.body === body && user.login === login;
 });
}
export async function syncIssueArtifact(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<void> {
 const artifact = renderWorkflowArtifact(workflow);
 const body = githubBody(`<!-- omi-development:artifact workflow=${encodeURIComponent(workflow.id)} artifact=${artifactHash(artifact)} -->\n${artifact}`);
 const fresh = await readIssueSource(workflow.checkout, workflow.source.number, runner, signal);
 if (fresh.hash !== workflow.source.hash || fresh.url !== workflow.source.url) throw new Error("El pedido fue editado por una persona; no se sobrescribe");
 const user = object(JSON.parse(await gh(workflow.checkout, ["api", "user"], runner, signal)));
 if (typeof user.login !== "string" || !user.login.trim()) throw new Error("Autor de GitHub inválido");
 if (await hasOwnedComment(workflow, user.login, body, runner, signal)) return;
 // GitHub offers no source-body CAS. Append only: even a concurrent human edit is untouched.
 try {
  await gh(workflow.checkout, ["api", `repos/${issueRepo(fresh.url, fresh.number)}/issues/${fresh.number}/comments`, "--method", "POST", "--input", "-"], runner, signal, JSON.stringify({ body }));
 } catch {
  signal?.throwIfAborted();
  if (await hasOwnedComment(workflow, user.login, body, runner, signal)) return;
  throw new Error("No se pudo confirmar el comentario; buscar el comentario exacto antes de reintentar");
 }
 if (!await hasOwnedComment(workflow, user.login, body, runner, signal)) throw new Error("No se pudo confirmar el comentario publicado; recuperar antes de reintentar");
}
export function renderPullRequestBody(workflow: Workflow): string {
 const artifact = renderWorkflowArtifact(workflow);
 if (workflow.publication.status !== "pending" || workflow.publication.bodyHash !== artifactHash(artifact)) throw new Error("El artefacto de publicación cambió; requiere nueva aprobación");
 const identity = { workflowId: workflow.id, sourceHash: workflow.source.hash, head: workflow.publication.head, bodyHash: workflow.publication.bodyHash };
 return githubBody(`<!-- omi-development:pr identity=${artifactHash(identity)} source=${identity.sourceHash} head=${identity.head} artifact=${identity.bodyHash} -->\nRefs #${workflow.source.number}\n\n${workflow.source.url}\n\n${artifact}`);
}
function remoteRepo(remote: string): string {
 const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
 if (!match) throw new Error("Remote origin no es una identidad GitHub admitida");
 return match[1]!;
}
async function assertRepository(workflow: Workflow, runner: Runner, signal?: AbortSignal): Promise<string> {
 const repo = issueRepo(workflow.source.url, workflow.source.number);
 const remotes = (await gitRead(workflow.checkout, ["remote", "get-url", "--push", "--all", "origin"], runner, signal)).trim().split("\n");
 if (remotes.length !== 1 || remoteRepo(remotes[0]!).toLowerCase() !== repo.toLowerCase()) throw new Error("Remote origin no coincide con el repositorio del issue");
 const data = object(JSON.parse(await gh(workflow.checkout, ["repo", "view", "--json", "nameWithOwner,url"], runner, signal)));
 if (data.nameWithOwner !== repo || data.url !== `https://github.com/${repo}`) throw new Error("gh apunta a otro repositorio");
 return repo;
}
async function recover(workflow: Workflow, repo: string, runner: Runner, signal?: AbortSignal): Promise<Published | null> {
 const raw: unknown = JSON.parse(await gh(workflow.checkout, ["pr", "list", "--repo", repo, "--state", "all", "--head", workflow.checkout.branch, "--base", "main", "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,body", "--limit", "100"], runner, signal));
 if (!Array.isArray(raw)) throw new Error("Lista de PRs inválida");
 if (!raw.length) return null;
 if (raw.length !== 1) throw new Error("Hay varios PRs para el branch; requiere revisión humana");
 const pr = object(raw[0]);
 if (workflow.publication.status !== "pending" || pr.state !== "OPEN" || pr.isDraft !== true || pr.isCrossRepository !== false || pr.headRefName !== workflow.checkout.branch || pr.baseRefName !== "main" || pr.headRefOid !== workflow.publication.head || pr.body !== renderPullRequestBody(workflow) || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.url !== `https://github.com/${repo}/pull/${pr.number}`) throw new Error("PR existente ajeno, cerrado, no draft o con otro HEAD; no se duplica");
 return { number: pr.number, url: String(pr.url), head: String(pr.headRefOid) };
}
export async function publishDraft(workflow: Workflow, runner: Runner = processRunner, signal?: AbortSignal): Promise<Published> {
 if (workflow.phase !== "pr" || workflow.publication.status !== "pending" || !workflow.approval || workflow.approval.sourceHash !== workflow.source.hash) throw new Error("Publicación draft no aprobada o no pendiente");
 const body = renderPullRequestBody(workflow);
 const head = workflow.publication.head;
 if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error("SHA de publicación inválido");
 const branch = workflow.checkout.branch;
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.split("/").some(p => p.startsWith(".") || p.endsWith(".lock"))) throw new Error("Branch no válido para publicación");
 const assertHead = async () => { const snapshot = await inspectCheckout(workflow.checkout, runner, signal); if (workflow.publication.status !== "pending" || !snapshot.clean || snapshot.head !== workflow.publication.head) throw new Error("HEAD de publicación cambió o checkout sucio"); };
 await assertHead(); const repo = await assertRepository(workflow, runner, signal);
 const fresh = await readIssueSource(workflow.checkout, workflow.source.number, runner, signal);
 if (fresh.hash !== workflow.source.hash || fresh.url !== workflow.source.url) throw new Error("El pedido cambió antes de publicar");
 const existing = await recover(workflow, repo, runner, signal); if (existing) return existing;
 // Revalidate immediately before the write; push the approved immutable object even if HEAD races afterwards.
 await assertHead();
 // Only this branch, no force, no tags and no destination inferred from git config.
 try {
  await gitRead(workflow.checkout, ["push", "--no-follow-tags", "origin", `${head}:refs/heads/${branch}`], runner, signal);
 } catch (error) { signal?.throwIfAborted(); const found = await recover(workflow, repo, runner, signal); if (found) return found; throw error; }
 await assertHead();
 try {
  await gh(workflow.checkout, ["pr", "create", "--repo", repo, "--draft", "--base", "main", "--head", branch, "--title", workflow.source.title, "--body-file", "-"], runner, signal, body);
 } catch (error) { signal?.throwIfAborted(); const found = await recover(workflow, repo, runner, signal); if (found) return found; throw error; }
 const created = await recover(workflow, repo, runner, signal);
 if (!created) throw new Error("No se pudo confirmar el PR creado; recuperar por branch antes de reintentar");
 return created;
}
