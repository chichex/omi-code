// Descarga por ID fijo, sin URLs de payload ni logs/cuerpos de credenciales en contexto.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { childEnvironment } from "../core/process-environment.ts";
import { GitHubReadError } from "./lifecycle-github-read.ts";
export const MAX_RELEASE_ASSET_BYTES = 1024 * 1024 * 1024, MAX_RELEASE_TARGET_BYTES = 2 * 1024 * 1024 * 1024;
function env() { return childEnvironment({ ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" }); }
function endpoint(repo: string, type: "artifact" | "asset", id: number): string {
 if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) || repo.split("/").some(x => x === "." || x === "..") || !Number.isSafeInteger(id) || id <= 0) throw new GitHubReadError("identidad binaria inválida");
 return type === "artifact" ? `repos/${repo}/actions/artifacts/${id}/zip` : `repos/${repo}/releases/assets/${id}`;
}
export function githubBinary(repo: string, type: "artifact" | "asset", id: number, limit: number, signal: AbortSignal): Promise<Buffer> {
 const path = endpoint(repo, type, id); signal.throwIfAborted();
 return new Promise((resolve, reject) => execFile("gh", ["api", "--hostname", "github.com", "--method", "GET", path, "-H", "Accept: application/octet-stream"], { encoding: "buffer", signal, timeout: 15000, killSignal: "SIGKILL", maxBuffer: limit, env: env() }, (error, stdout) => error ? reject(new GitHubReadError("Descarga binaria incompleta/fuera de límite")) : resolve(stdout)));
}
export function githubAssetDigest(repo: string, id: number, expectedBytes: number, signal: AbortSignal): Promise<{ sha256: string; size: number }> {
 const path = endpoint(repo, "asset", id); signal.throwIfAborted();
 if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_RELEASE_ASSET_BYTES) throw new GitHubReadError("asset excede límite host");
 return new Promise((resolve, reject) => {
  const child = spawn("gh", ["api", "--hostname", "github.com", "--method", "GET", path, "-H", "Accept: application/octet-stream"], { signal, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  const hash = createHash("sha256"); let size = 0, error = false, stderr = 0;
  const timer = setTimeout(() => { error = true; child.kill("SIGKILL"); }, 120000); timer.unref();
  child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > expectedBytes || size > MAX_RELEASE_ASSET_BYTES) { error = true; child.kill("SIGKILL"); } else hash.update(bytes); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.length; if (stderr > 8192) { error = true; child.kill("SIGKILL"); } });
  child.once("error", () => { error = true; clearTimeout(timer); reject(new GitHubReadError("Lectura de asset cancelada/incompleta")); });
  child.once("close", code => { clearTimeout(timer); if (error || signal.aborted || code !== 0 || size !== expectedBytes) reject(new GitHubReadError("Asset no íntegro o fuera de límite")); else resolve({ sha256: hash.digest("hex"), size }); });
 });
}
