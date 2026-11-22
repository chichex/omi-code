// Transporte de un push autorizado: gitdir privado sin aliases/url-rewrites del checkout mutable.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Runner } from "../core/exec.ts";
import type { WorkflowV2 } from "./model.ts";
import type { CorrectionPushRequest } from "./correction-schema.ts";
export async function fixedGitPush(checkout: WorkflowV2["checkout"], destination: string, request: CorrectionPushRequest, runner: Runner, signal: AbortSignal): Promise<void> {
 const directory = await mkdtemp(join(tmpdir(), "omi-fixed-push-"));
 // El helper de auth es fijo y habla con Git por su pipe, nunca por el contexto/salida del modelo.
 const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_NAMESPACE: "", GIT_TERMINAL_PROMPT: "0", GIT_DIR: directory, GIT_COMMON_DIR: directory,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(join(checkout.commonDir, "objects")) };
 try {
  signal.throwIfAborted();
  const initialized = await runner.run("git", ["init", "--bare", "--quiet", "--template=", `--object-format=${request.head.length === 64 ? "sha256" : "sha1"}`, directory], { cwd: directory, signal, env });
  if (initialized.code !== 0) throw new Error("No se pudo preparar el transporte privado de push"); signal.throwIfAborted();
  const result = await runner.run("git", ["--git-dir", directory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "--no-follow-tags", "--no-mirror", destination, `${request.head}:refs/heads/${request.branch}`], { cwd: directory, signal, env });
  if (result.code !== 0) throw new Error("Push no confirmado; observar SHA sin repetir la mutación");
 } finally { await rm(directory, { recursive: true, force: true }); }
}
