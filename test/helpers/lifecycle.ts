// Fixtures del lifecycle post-PR: perillas aceptadas en una KB en memoria y un GitHub falso por `gh api`.
// Nada sale de la máquina: GitHub responde desde memoria y la KB es la de mock-kb.
import { execFileSync } from "node:child_process";
import { defaultLifecycleConfig, defaultLifecycleTarget, renderLifecycleBlock, type LifecycleConfig } from "../../src/harness/lifecycle-config.ts";
import { acceptLifecycle } from "../../src/harness/lifecycle-kb.ts";
import { lifecycleTrustDir, type LifecycleKey } from "../../src/harness/lifecycle-trust.ts";
import type { MemoryKb } from "./mock-kb.ts";

export const AT = "2026-01-01T00:00:00Z";
/** Review por GitHub con ada, Land ask y Ship por release v0.2.0 (o el que pida el test). */
export function lifecycleConfig(repo: string, change: (block: LifecycleConfig) => void = () => {}): LifecycleConfig {
	const block = defaultLifecycleConfig(repo, "main");
	block.review.provider = { kind: "github", reviewers: ["ada"] };
	const target = defaultLifecycleTarget({ id: "release", timeoutSeconds: 60, provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" }, evidence: { kind: "github-release", assets: ["app-linux-x64.tar.gz"], checksumsAsset: "checksums.txt" } });
	if (!("target" in target)) throw new Error(target.reason);
	block.ship = { status: "configured", targets: [target.target] };
	change(block); return block;
}
/** Guarda las perillas en la KB y la aceptación local, como lo haría `omi init --development`. */
export async function acceptLifecycleConfig(kb: MemoryKb, home: string, cwd: string, block: LifecycleConfig): Promise<LifecycleKey> {
	const key: LifecycleKey = { kbUrl: kb.url, product: block.repo.split("/")[1]!, repo: block.repo };
	if (!kb.access.includes(key.product)) kb.access.push(key.product);
	kb.perillas(key.product, `# Perillas de ${key.product}\n\n${renderLifecycleBlock(block)}\n`);
	const pin = await acceptLifecycle(kb, key, cwd, { trustDir: lifecycleTrustDir(home), expectedRevision: undefined, now: () => AT, signal: AbortSignal.timeout(5000), confirm: async () => true });
	if (!pin) throw new Error("No se aceptó el lifecycle del fixture");
	return key;
}
export interface FakePull { number: number; branch: string; draft: boolean; merged: boolean; mergeSha: string | null; head: () => string; base: string }
export interface FakeGitHub {
	pull: FakePull; inline: { id: number; body: string; commit_id: string; path: string; line: number }[]; reviews: { id: number; login: string; state: string; commit_id: string; body: string }[];
	checks: { id: number; name: string; app: number; conclusion: string }[]; mutations: string[][]; reads: string[];
	handle: (args: string[], input: string | undefined) => { code?: number; stdout: string } | undefined;
}
const json = (body: unknown, status = 200) => ({ code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` });
/** GitHub de un repo con un PR: GETs acotados con --include, ready, merge PUT y nada más. */
export function fakeGitHub(repo: string, root: string, pull: Omit<FakePull, "head" | "base"> & { head?: () => string }): FakeGitHub {
	const base = execFileSync("git", ["rev-parse", "main"], { cwd: root, encoding: "utf8" }).trim();
	const head = pull.head ?? (() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
	const gh: FakeGitHub = { pull: { ...pull, head, base }, inline: [], reviews: [], checks: [{ id: 1001, name: "cierre", app: 15368, conclusion: "success" }], mutations: [], reads: [], handle: () => undefined };
	const pr = () => ({ number: gh.pull.number, state: gh.pull.merged ? "closed" : "open", draft: gh.pull.draft, merged: gh.pull.merged, merge_commit_sha: gh.pull.mergeSha, merged_at: gh.pull.merged ? AT : null, mergeable: true, mergeable_state: "clean", user: { login: "author" },
		head: { sha: gh.pull.head(), ref: gh.pull.branch, repo: { full_name: repo } }, base: { sha: gh.pull.base, ref: "main", repo: { full_name: repo } } });
	gh.handle = (args) => {
		if (args[0] === "pr" && args[1] === "ready") { gh.mutations.push(args); gh.pull.draft = false; return { stdout: "" }; }
		if (args[0] !== "api" || !args.includes("--hostname")) return undefined;
		const method = args[args.indexOf("--method") + 1];
		const endpoint = args.find(a => a.startsWith("repos/")) ?? "";
		if (method !== "GET") {
			gh.mutations.push(args);
			if (method === "PUT" && endpoint === `repos/${repo}/pulls/${gh.pull.number}/merge`) { gh.pull.merged = true; gh.pull.mergeSha = "f".repeat(40); return { stdout: JSON.stringify({ merged: true, sha: gh.pull.mergeSha, message: "merged" }) }; }
			return { code: 1, stdout: "" };
		}
		gh.reads.push(endpoint);
		const path = new URL(`https://api.github.com/${endpoint}`).pathname.replace(/^\//, "");
		const prefix = `repos/${repo}`, number = gh.pull.number;
		if (path === prefix) return json({ full_name: repo, default_branch: "main", allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, permissions: { push: true, admin: false } });
		if (path === `${prefix}/pulls/${number}`) return json(pr());
		if (path === `${prefix}/pulls/${number}/reviews`) return json(gh.reviews.map(r => ({ id: r.id, user: { login: r.login }, state: r.state, commit_id: r.commit_id, submitted_at: AT, body: r.body })));
		if (path === `${prefix}/pulls/${number}/comments`) return json(gh.inline.map(c => ({ ...c, user: { login: "ada" }, created_at: AT, updated_at: AT })));
		if (path === `${prefix}/issues/${number}/comments` || path.endsWith("/statuses") || path === `${prefix}/rules/branches/main`) return json([]);
		if (path.endsWith("/check-runs")) return json({ total_count: gh.checks.length, check_runs: gh.checks.map(c => ({ id: c.id, name: c.name, head_sha: gh.pull.head(), status: "completed", conclusion: c.conclusion, app: { id: c.app } })) });
		if (path === `${prefix}/branches/main/protection`) return json({ url: `https://api.github.com/${prefix}/branches/main/protection`, required_status_checks: { strict: false, checks: [{ context: "cierre", app_id: 15368 }], contexts: ["cierre"] }, required_pull_request_reviews: { required_approving_review_count: 1 } });
		if (path === `${prefix}/branches/main`) return json({ name: "main", protected: true, commit: { sha: gh.pull.base } });
		if (path.startsWith(`${prefix}/collaborators/`)) return json({ user: { login: path.split("/")[4] }, permission: "write" });
		if (path.startsWith(`${prefix}/compare/`)) return json({ status: "ahead", ahead_by: 1, behind_by: 0 });
		return json({ message: "Not Found" }, 404);
	};
	return gh;
}
