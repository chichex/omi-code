// Identidad de workflow/ref confiable: no inferir branch/tag ambiguo ni SHA desde semver.
import { Type } from "typebox";
import { GitHubReadClient, GitHubReadError } from "./lifecycle-github-read.ts";
import { githubChecked, id, sha, text } from "./lifecycle-github-schema.ts";
import { lifecycleRef } from "./lifecycle-config.ts";
const Workflow = Type.Object({ id, path: text(), state: Type.Literal("active") });
const Ref = Type.Object({ object: Type.Object({ type: Type.Enum(["commit", "tag"]), sha }) });
async function optional(client: GitHubReadClient, kind: "heads" | "tags", name: string, signal: AbortSignal) {
 try { return githubChecked(Ref, await client.json(`repos/${client.repo}/git/ref/${kind}/${encodeURIComponent(name)}`, signal)).object; }
 catch (error) { if (error instanceof GitHubReadError && error.status === 404) return null; throw error; }
}
async function peel(client: GitHubReadClient, input: { type: "commit" | "tag"; sha: string }, signal: AbortSignal): Promise<string> {
 let object = input;
 for (let depth = 0; object.type === "tag" && depth < 5; depth++) object = githubChecked(Ref, await client.json(`repos/${client.repo}/git/tags/${object.sha}`, signal)).object;
 if (object.type !== "commit") throw new GitHubReadError("tag sin commit acotado"); return object.sha;
}
export async function resolveCommitTag(client: GitHubReadClient, tag: string, signal: AbortSignal): Promise<string> {
 if (!lifecycleRef(tag)) throw new GitHubReadError("tag inválido"); const object = await optional(client, "tags", tag, signal); if (!object) throw new GitHubReadError("tag ausente"); return peel(client, object, signal);
}
export async function trustedWorkflow(client: GitHubReadClient, filename: string, ref: string, signal: AbortSignal) {
 const name = filename.replace(/^\.github\/workflows\//, "");
 if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/.test(name) || name.includes("..") || !lifecycleRef(ref)) throw new GitHubReadError("workflow/ref inválido");
 const workflow = githubChecked(Workflow, await client.json(`repos/${client.repo}/actions/workflows/${name}`, signal)); if (workflow.path !== `.github/workflows/${name}`) throw new GitHubReadError("workflow ajeno");
 const namespace = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
 const refs = namespace ? [await optional(client, namespace[1] === "heads" ? "heads" : "tags", namespace[2] ?? "", signal)] : [await optional(client, "heads", ref, signal), await optional(client, "tags", ref, signal)];
 const found = refs.filter(x => x !== null); const object = found[0]; if (found.length !== 1 || !object) throw new GitHubReadError("ref ausente/ambiguo");
 return { id: workflow.id, path: workflow.path, ref, sha: await peel(client, object, signal) };
}
