// omi_pr_merge: la persona pide el merge en el chat y lo autoriza con su sí en la pantalla de OMI, nunca con el chat.
// Mergea el SHA exacto que vio y lo confirma leyendo el PR. Dentro del harness no corre: Land es /omi-work land.
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Runner } from "../core/exec.ts";
import { boundedGitHubRunner } from "../harness/lifecycle-github-read.ts";
import { canAsk } from "./questions/ask.ts";

export const PR_MERGE_TOOL = "omi_pr_merge";
const GH_ENV = { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
const ParamsSchema = Type.Object({ pr: Type.Integer({ minimum: 1, description: "Número del PR en el repo de esta carpeta. Ejemplo: 79" }) }, { additionalProperties: false });
const CheckSchema = Type.Object({ name: Type.Optional(Type.String()), context: Type.Optional(Type.String()), status: Type.Optional(Type.String()), conclusion: Type.Optional(Type.Union([Type.String(), Type.Null()])), state: Type.Optional(Type.String()) });
const PullSchema = Type.Object({
	number: Type.Integer({ minimum: 1 }), title: Type.String(), url: Type.String(), state: Type.String(), isDraft: Type.Boolean(),
	headRefName: Type.String(), headRefOid: Type.String({ pattern: "^[0-9a-f]{40}$" }), baseRefName: Type.String(), mergeStateStatus: Type.String(), statusCheckRollup: Type.Array(CheckSchema),
});
const MergedSchema = Type.Object({ state: Type.String(), headRefOid: Type.String() });
const RepoSchema = Type.Object({ squashMergeAllowed: Type.Boolean(), mergeCommitAllowed: Type.Boolean(), rebaseMergeAllowed: Type.Boolean() });
type Pull = Static<typeof PullSchema>;

// Lo que llega de GitHub se muestra como texto plano: sin controles ni formato invisible.
const plain = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
const detail = (stderr: string) => plain(stderr).slice(0, 300) || "sin detalle";
const PENDING = new Set(["", "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
function checkLabel(check: Static<typeof CheckSchema>): string {
	const name = plain(check.name ?? check.context ?? "check"); const result = (check.conclusion ?? check.state ?? "").toUpperCase();
	if ((check.status !== undefined && check.status !== "COMPLETED") || PENDING.has(result)) return `${name} corriendo`;
	return `${name} ${PASSED.has(result) ? "ok" : "falló"}`;
}
const checks = (pull: Pull) => pull.statusCheckRollup.map(checkLabel).join(", ") || "ninguno";

const BLOCKERS: Record<string, string> = {
	DRAFT: "es draft: marcalo listo para review antes de mergear", BEHIND: "la rama está atrás de {base}: actualizala antes de mergear",
	BLOCKED: "GitHub lo bloquea: faltan checks en verde o reviews obligatorias", DIRTY: "tiene conflictos con {base}",
	UNSTABLE: "hay checks que no pasaron", UNKNOWN: "GitHub todavía está calculando si se puede mergear: reintentá en unos segundos",
};
function blocker(pull: Pull): string | undefined {
	if (pull.state === "MERGED") return "ya está mergeado";
	if (pull.state !== "OPEN") return "está cerrado";
	const status = pull.isDraft ? "DRAFT" : pull.mergeStateStatus;
	if (status === "CLEAN" || status === "HAS_HOOKS") return undefined;
	return (BLOCKERS[status] ?? `GitHub no lo deja mergear (${plain(status)})`).replace("{base}", plain(pull.baseRefName));
}

const METHODS = [["squash", "squashMergeAllowed"], ["merge", "mergeCommitAllowed"], ["rebase", "rebaseMergeAllowed"]] as const;
const METHOD_LABEL = { squash: "squash", merge: "merge commit", rebase: "rebase" } as const;

async function gh<S extends TSchema>(runner: Runner, cwd: string, args: string[], schema: S, what: string, signal: AbortSignal | undefined): Promise<Static<S>> {
	const result = await runner.run("gh", args, { cwd, env: GH_ENV, ...(signal ? { signal } : {}) });
	if (result.code !== 0) throw new Error(`No pude leer ${what} con gh: ${detail(result.stderr)}`);
	let value: unknown;
	try { value = JSON.parse(result.stdout); } catch { value = undefined; }
	if (!Value.Check(schema, value)) throw new Error(`GitHub devolvió ${what} en un formato que no reconozco`);
	return value;
}

async function merge(runner: Runner, number: number, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<string> {
	if (!canAsk(ctx)) throw new Error("omi_pr_merge necesita la TUI de OMI para pedirle el sí a la persona: sin ella no se mergea.");
	const pull = await gh(runner, ctx.cwd, ["pr", "view", String(number), "--json", "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup"], PullSchema, `el PR #${number}`, signal);
	const repo = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(pull.url);
	if (!repo || Number(repo[2]) !== number || pull.number !== number) throw new Error(`El PR #${number} no es un PR de github.com de esta carpeta`);
	const reason = blocker(pull);
	if (reason) throw new Error(`No mergeé el PR #${number}: ${reason}. Checks: ${checks(pull)}. No le pregunté a la persona.`);
	const settings = await gh(runner, ctx.cwd, ["repo", "view", repo[1]!, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], RepoSchema, `la configuración de ${repo[1]}`, signal);
	const method = METHODS.find(([, setting]) => settings[setting])?.[0];
	if (!method) throw new Error(`No mergeé el PR #${number}: ${repo[1]} no permite ningún método de merge.`);
	const base = plain(pull.baseRefName);
	const message = [`${repo[1]} · ${plain(pull.title)}`, `${plain(pull.headRefName)} → ${base} · ${METHOD_LABEL[method]} · HEAD ${pull.headRefOid.slice(0, 12)}`, `Checks: ${checks(pull)}`, "",
		`Integra el cambio en ${base}. Si el repo publica o despliega en cada merge, eso arranca al confirmar.`].join("\n");
	if (!(await ctx.ui.confirm(`Mergear el PR #${number}`, message, signal ? { signal } : undefined))) return `La persona no confirmó el merge del PR #${number}: no se mergeó. No vuelvas a llamar a omi_pr_merge salvo que te lo pida de nuevo.`;
	// Un solo PUT atado al SHA que vio la persona: si alguien empujó mientras tanto, GitHub lo rechaza.
	const put = await runner.run("gh", ["api", "--hostname", "github.com", "--method", "PUT", `repos/${repo[1]}/pulls/${number}/merge`, "-f", `sha=${pull.headRefOid}`, "-f", `merge_method=${method}`], { cwd: ctx.cwd, env: GH_ENV, ...(signal ? { signal } : {}) });
	const after = await gh(runner, ctx.cwd, ["pr", "view", String(number), "--json", "state,headRefOid"], MergedSchema, `el PR #${number}`, signal).catch(() => undefined);
	if (after?.state === "MERGED" && after.headRefOid === pull.headRefOid) return `PR #${number} mergeado en ${base} (${METHOD_LABEL[method]}, HEAD ${pull.headRefOid.slice(0, 12)}). GitHub confirmó el merge. Si el repo publica o despliega en cada merge, eso ya corre en GitHub Actions.`;
	throw new Error(`GitHub no confirmó el merge del PR #${number}${put.code === 0 ? "" : `: ${detail(put.stderr)}`}. No lo reintenté: revisalo en ${pull.url}.`);
}

export function registerPrMergeTool(pi: ExtensionAPI, runner: Runner = boundedGitHubRunner): void {
	pi.registerTool({
		name: PR_MERGE_TOOL, label: "Mergear un PR", parameters: ParamsSchema,
		// Interactiva: ni codemode ni un subagente en segundo plano la pueden llamar.
		exposure: "model-only", executionMode: "sequential",
		description: "Mergea un PR de GitHub del repo de esta carpeta cuando la persona lo pide. OMI le muestra el repo, las ramas, el método, el SHA y los checks, y le pide su sí en pantalla: ese sí es el permiso, no el chat. Sólo mergea PRs abiertos, no draft y que GitHub deja mergear; si no, devuelve el motivo sin preguntar. Mergea ese SHA exacto y confirma el merge leyendo el PR. Sin la TUI interactiva no se ofrece.",
		promptSnippet: "Mergear un PR de GitHub cuando la persona lo pide, con su sí en pantalla",
		promptGuidelines: [
			"Si la persona te pide mergear un PR, usá omi_pr_merge: OMI le muestra el PR y le pide su sí. No mergees con bash, gh pr merge ni la API de GitHub.",
			"Llamala sólo si la persona pidió mergear ese PR. Si GitHub todavía no lo deja (por ejemplo, checks corriendo), decíselo; si pidió el merge para cuando quede listo, esperá a que terminen los checks y volvé a llamarla. Si la persona dice que no, no insistas.",
		],
		async execute(_id, { pr }, signal, _update, ctx) {
			return { content: [{ type: "text", text: await merge(runner, pr, ctx, signal) }], details: { pr } };
		},
	});
}

export function prMergeExtension(runner?: Runner): Exclude<InlineExtension, ExtensionFactory> {
	return { name: "omi-pr-merge", factory: (pi: ExtensionAPI) => {
		registerPrMergeTool(pi, runner);
		// Sin TUI interactiva siempre fallaría: no se le ofrece al modelo.
		pi.on("session_start", (_event, ctx) => { if (!canAsk(ctx)) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== PR_MERGE_TOOL)); });
	} };
}
