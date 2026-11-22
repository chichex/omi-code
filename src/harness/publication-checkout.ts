// Checkout separado del SHA integrado: no switch/reset/rebase del worktree del trabajo.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowV2 } from "./model.ts";
import type { Runner } from "../core/exec.ts";
import { lifecycleAssert } from "./lifecycle-invariants.ts";
export async function publicationCheckout(state: WorkflowV2, commit: string, runner: Runner, signal: AbortSignal) {
 lifecycleAssert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/.test(state.source.url), "commit/repo de publicación inválidos");
 const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//.exec(state.source.url)?.[1]; lifecycleAssert(repo, "repo no identificado");
 const parent = await mkdtemp(join(tmpdir(), "omi-publication-checkout-")), root = join(parent, "source");
 const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_TERMINAL_PROMPT: "0" };
 const git = async (args: string[], cwd = state.checkout.root) => { signal.throwIfAborted(); const result = await runner.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, signal, env }); lifecycleAssert(result.code === 0, "preparación Git de publicación no completada"); return result.stdout.trim(); };
 try {
  await git(["clone", "--no-checkout", "--shared", "--template=", "--", state.checkout.root, root]);
  const present = await runner.run("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, signal, env });
  if (present.code !== 0) await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "--no-tags", "--no-write-fetch-head", `https://github.com/${repo}.git`, commit], root);
  await git(["remote", "set-url", "origin", `https://github.com/${repo}.git`], root);
  await git(["config", "credential.helper", "!gh auth git-credential"], root);
  await git(["checkout", "--detach", commit], root); lifecycleAssert(await git(["rev-parse", "HEAD"], root) === commit && await git(["status", "--porcelain"], root) === "", "checkout no fijado/limpio");
  return { root, commitSha: commit, release: () => rm(parent, { recursive: true, force: true }) };
 } catch (error) { await rm(parent, { recursive: true, force: true }); throw error; }
}
