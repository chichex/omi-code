// `omi init --development`: el wizard lifecycle que comparte con la TUI y el diagnóstico --check de sólo lectura.
// El host de la KB (Pi/MCP) se abre recién acá y se cierra explícito. Ningún flag concede permisos ni acepta nada.
import { EXIT_OK, OmiError, UsageError } from "../core/errors.ts";
import { processRunner, type Runner } from "../core/exec.ts";
import { isAgentSession } from "../guardrails/surfaces.ts";
import { detectLifecycle } from "../harness/lifecycle-detect.ts";
import { evaluateLifecycle, readLifecycle } from "../harness/lifecycle-kb.ts";
import { lifecycleOnboardingStatus, runLifecycleOnboarding, type LifecycleOnboardingOutcome } from "../harness/lifecycle-onboarding.ts";
import { lifecycleKeyValid, lifecycleTrustDir, readLifecycleTrust, type LifecycleKey } from "../harness/lifecycle-trust.ts";
import type { KbClient } from "../tui/kb-client.ts";
import { HARNESS_KB_URL } from "../tui/defaults.ts";
import { parseRepoIdentity } from "../tui/development-foundations.ts";
import { parseFlags } from "./flags.ts";
import type { Io } from "./io.ts";
import { printJson } from "./output.ts";
import { promptQuestions } from "./question-prompt.ts";

export interface DevelopmentHost { kb: KbClient | undefined; close(): Promise<void> }
export type DevelopmentHostFactory = (io: Io, signal: AbortSignal) => Promise<DevelopmentHost>;
export interface DevelopmentInitDeps { host?: DevelopmentHostFactory; runner?: Runner; now?: () => string }
const CHECK_TIMEOUT_MS = 60_000;
const headlessHost: DevelopmentHostFactory = async (io, signal) => (await import("./development-host.ts")).headlessKbHost(io, signal);
async function git(runner: Runner, cwd: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
	try {
		const result = await runner.run("git", ["-c", "core.fsmonitor=false", ...args], { cwd, signal, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch { signal.throwIfAborted(); return undefined; }
}
const MESSAGES: Record<LifecycleOnboardingOutcome["kind"], string> = {
	saved: "Lifecycle guardado en la KB y aceptado localmente. No se ejecutó ningún workflow, merge ni deploy.",
	deferred: "Postergado para esta revisión: el harness no lo vuelve a ofrecer; volvé con `omi init --development`.",
	cancelled: "Cancelado: no se guardó nada.", declined: "No se guardó nada.", unavailable: "", invalid: "",
};

export async function developmentInit(args: string[], io: Io, deps: DevelopmentInitDeps = {}): Promise<number> {
	const { values } = parseFlags(args, { development: { type: "boolean" }, check: { type: "boolean" } });
	const check = values.check === true, json = values.json === true;
	if (!check && (!io.interactive || isAgentSession(io))) throw new UsageError("Configurar el lifecycle de desarrollo requiere una persona en una terminal interactiva; ningún flag lo acepta", "`omi init --development --check --json` diagnostica sin escribir");
	// Diagnóstico acotado; el wizard espera a la persona y cada llamada a la KB tiene su propio tope.
	const signal = check ? AbortSignal.timeout(CHECK_TIMEOUT_MS) : new AbortController().signal, runner = deps.runner ?? processRunner;
	const root = await git(runner, io.cwd, ["rev-parse", "--show-toplevel"], signal) ?? io.cwd;
	const origin = await git(runner, root, ["remote", "get-url", "origin"], signal), repo = origin ? parseRepoIdentity(origin) : undefined;
	if (!repo) throw new OmiError("development_repo_unknown", "El repo no tiene origin en github.com; no se consultó la KB ni se configuró nada");
	const base = (await git(runner, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal))?.replace(/^origin\//, "");
	const host = await (deps.host ?? headlessHost)(io, signal);
	try {
		const key: LifecycleKey = { kbUrl: host.kb?.url ?? HARNESS_KB_URL, product: repo.split("/")[1] ?? "", repo };
		if (!lifecycleKeyValid(key)) throw new OmiError("development_repo_unknown", `${repo} no tiene un nombre que sea un producto de la KB; no se configuró nada`);
		const trustDir = lifecycleTrustDir(io.homeDir), detection = await detectLifecycle(root, signal);
		if (check) {
			const reading = await readLifecycle(host.kb, key, root, signal), local = await readLifecycleTrust(trustDir, key), state = lifecycleOnboardingStatus(reading, local);
			const report = { repo, product: key.product, kbUrl: key.kbUrl, status: state.status, revision: state.revision, reason: state.reason, canStartEffects: evaluateLifecycle(reading, local).canStartEffects, deferred: local.kind === "valid" ? local.record.deferred : null, detection };
			if (json) printJson(report, io); else io.out(`Lifecycle ${repo}: ${state.status} · ${state.reason}`);
			return EXIT_OK;
		}
		if (!base) throw new OmiError("development_base_unknown", "No se detectó la rama base (origin/HEAD); no se configuró nada", { hint: "`git remote set-head origin --auto` y volvé a correr `omi init --development`" });
		const outcome = await runLifecycleOnboarding({ kb: host.kb, key, cwd: root, base, trustDir, detection, ask: promptQuestions(io), now: deps.now ?? (() => new Date().toISOString()), signal });
		if (outcome.kind === "unavailable" || outcome.kind === "invalid") throw new OmiError(`development_${outcome.kind}`, `No se puede configurar el lifecycle: ${outcome.reason}. No se guardó ni aceptó nada.`);
		if (json) printJson(outcome, io); else io.out(MESSAGES[outcome.kind]);
		return EXIT_OK;
	} finally { await host.close(); }
}
